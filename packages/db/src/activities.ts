import { SYNC_ATTEMPTS, SYNC_LEASE_MS, type StravaActivity, type SyncDashboard } from "@pkg/shared";
import { prisma } from "./client.js";
import { getTrainingSummary } from "./training.js";
import { lockUserTraining } from "./training-lock.js";

export async function createOrReuseSyncRun(userId: number) {
  return prisma.$transaction(async (tx) => {
    await lockUserTraining(tx, userId);
    const connection = await tx.stravaConnection.findUnique({ where: { userId }, select: { userId: true } });
    if (!connection) throw new Error("Strava is not connected");
    const activeSync = await tx.jobRun.findFirst({
      where: { userId, jobType: "STRAVA_SYNC", status: { in: ["PENDING", "RUNNING"] } },
      orderBy: { createdAt: "desc" },
    });
    return activeSync ?? tx.jobRun.create({ data: { userId, jobType: "STRAVA_SYNC" } });
  }, { isolationLevel: "ReadCommitted", timeout: 10000 });
}

export async function loadSyncRun(jobRunId: number) {
  return prisma.jobRun.findUnique({
    where: { id: jobRunId },
    include: {
      user: { select: { stravaConnection: { select: { athleteId: true, scopes: true } } } },
    },
  });
}

export async function startSyncRun(id: number, queueAttemptsMade: number) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "JobRun" WHERE "id" = ${id} FOR UPDATE`;
    const syncRun = await tx.jobRun.findUniqueOrThrow({ where: { id } });
    if (syncRun.jobType !== "STRAVA_SYNC") throw new Error("Not a Strava sync");
    if (!["PENDING", "RUNNING"].includes(syncRun.status)) {
      return { kind: "terminal" as const, status: syncRun.status, activityCount: syncRun.activityCount };
    }
    const now = new Date();
    const deferUntil = Math.max(syncRun.leaseExpiresAt?.getTime() ?? 0, syncRun.nextRetryAt?.getTime() ?? 0);
    if (deferUntil > now.getTime()) return { kind: "deferred" as const, until: deferUntil };
    // Queue counters may reset when Redis loses a job. The DB counter never resets.
    const attemptsStarted = Math.max(syncRun.attemptsStarted, queueAttemptsMade);
    if (attemptsStarted >= SYNC_ATTEMPTS) {
      await tx.jobRun.update({ where: { id }, data: {
        status: "FAILED", error: "Sync attempt limit reached. Please try syncing again.",
        finishedAt: now, leaseExpiresAt: null, nextRetryAt: null,
      } });
      return { kind: "terminal" as const, status: "FAILED" as const, activityCount: syncRun.activityCount };
    }
    const attemptNumber = attemptsStarted + 1;
    await tx.jobRun.update({ where: { id }, data: {
      status: "RUNNING", startedAt: now, finishedAt: null, error: null, activityCount: 0,
      attemptsStarted: attemptNumber, nextRetryAt: null,
      leaseExpiresAt: new Date(now.getTime() + SYNC_LEASE_MS),
    } });
    return { kind: "started" as const, attemptNumber };
  });
}

export class SyncLeaseLostError extends Error {}

// The attempt number fences out workers that resume after their lease was replaced.
export async function renewSyncLease(id: number, attemptNumber: number) {
  const now = new Date();
  const result = await prisma.jobRun.updateMany({ where: {
    id, status: "RUNNING", attemptsStarted: attemptNumber, leaseExpiresAt: { gt: now },
  }, data: { leaseExpiresAt: new Date(now.getTime() + SYNC_LEASE_MS) } });
  if (result.count !== 1) throw new SyncLeaseLostError("Sync execution lease was lost");
}

function mapStravaSportToActivityType(sport: string): "RUN" | "BIKE" | "SWIM" | "OTHER" {
  if (["Run", "TrailRun", "VirtualRun"].includes(sport)) return "RUN";
  if (["Ride", "VirtualRide", "MountainBikeRide", "GravelRide", "EBikeRide", "EMountainBikeRide", "Handcycle", "Velomobile"].includes(sport)) return "BIKE";
  return sport === "Swim" ? "SWIM" : "OTHER";
}

export async function saveActivityPage(
  jobRunId: number,
  userId: number,
  activities: StravaActivity[],
  activityCount: number,
  attemptNumber: number,
) {
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const leaseUpdate = await tx.jobRun.updateMany({
      where: {
        id: jobRunId, userId, status: "RUNNING", attemptsStarted: attemptNumber,
        leaseExpiresAt: { gt: now },
      },
      data: { activityCount, leaseExpiresAt: new Date(now.getTime() + SYNC_LEASE_MS) },
    });
    if (leaseUpdate.count !== 1) throw new SyncLeaseLostError("Sync execution lease was lost");
    for (const activity of activities) {
      const data = {
        name: activity.name,
        type: mapStravaSportToActivityType(activity.sport_type ?? activity.type),
        startedAt: new Date(activity.start_date),
        durationSeconds: activity.moving_time,
        distanceMeters: Math.round(activity.distance),
        elevationMeters: activity.total_elevation_gain === undefined ? null : Math.round(activity.total_elevation_gain),
        source: "STRAVA" as const,
      };
      const savedActivity = await tx.activity.upsert({
        where: { stravaActivityId: BigInt(activity.id) },
        create: { ...data, userId, stravaActivityId: BigInt(activity.id) },
        update: data,
        select: { userId: true },
      });
      // Roll back the page rather than change another user's activity.
      if (savedActivity.userId !== userId) throw new Error("Activity ownership mismatch");
    }
  }, { timeout: 20000 });
}

export async function finishSyncRun(id: number, userId: number, attemptNumber: number) {
  const finishedAt = new Date();
  await prisma.$transaction(async tx => {
    const completion = await tx.jobRun.updateMany({
      where: {
        id, userId, status: "RUNNING", attemptsStarted: attemptNumber,
        leaseExpiresAt: { gt: finishedAt },
      },
      data: { status: "SUCCESS", finishedAt, error: null, leaseExpiresAt: null, nextRetryAt: null },
    });
    if (completion.count !== 1) throw new SyncLeaseLostError("Sync execution lease was lost");
    await tx.stravaConnection.update({ where: { userId }, data: { lastSuccessfulSyncAt: finishedAt } });
  });
}

export async function recordSyncFailure(id: number, attemptNumber: number, message: string, nextRetryAt: Date | null) {
  await prisma.jobRun.updateMany({ where: {
    id, jobType: "STRAVA_SYNC", status: "RUNNING", attemptsStarted: attemptNumber, leaseExpiresAt: { gt: new Date() },
  }, data: {
    status: nextRetryAt ? "PENDING" : "FAILED", error: message, nextRetryAt, leaseExpiresAt: null,
    finishedAt: nextRetryAt ? null : new Date(),
  } });
}

export async function listUnfinishedSyncRuns(afterId = 0) {
  return prisma.jobRun.findMany({ where: {
    id: { gt: afterId }, jobType: "STRAVA_SYNC", status: { in: ["PENDING", "RUNNING"] },
  }, orderBy: { id: "asc" }, take: 100,
  select: { id: true, attemptsStarted: true, leaseExpiresAt: true, nextRetryAt: true } });
}

export async function failUnleasedSyncRun(id: number, attemptsStarted: number) {
  await prisma.jobRun.updateMany({ where: {
    id, jobType: "STRAVA_SYNC", status: { in: ["PENDING", "RUNNING"] }, attemptsStarted,
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
  }, data: {
    status: "FAILED", error: "Sync stopped or exhausted its attempts. Please try syncing again.",
    finishedAt: new Date(), leaseExpiresAt: null, nextRetryAt: null,
  } });
}

export async function getSyncDashboard(userId: number): Promise<SyncDashboard> {
  const [connection, latestSync, activities, trainingSummary] = await Promise.all([
    prisma.stravaConnection.findUnique({ where: { userId }, select: { lastSuccessfulSyncAt: true } }),
    prisma.jobRun.findFirst({ where: { userId, jobType: "STRAVA_SYNC" }, orderBy: { id: "desc" },
      select: { id: true, status: true, activityCount: true, error: true, createdAt: true, finishedAt: true } }),
    prisma.activity.findMany({ where: { userId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 30,
      select: { id: true, name: true, type: true, startedAt: true, durationSeconds: true, distanceMeters: true, stravaActivityId: true } }),
    getTrainingSummary(userId),
  ]);
  return {
    trainingSummary,
    lastSuccessfulSyncAt: connection?.lastSuccessfulSyncAt?.toISOString() ?? null,
    latestSync: latestSync ? { ...latestSync, createdAt: latestSync.createdAt.toISOString(), finishedAt: latestSync.finishedAt?.toISOString() ?? null } : null,
    activities: activities.map(activity => ({
      ...activity, startedAt: activity.startedAt.toISOString(), stravaActivityId: activity.stravaActivityId?.toString() ?? null,
    })),
  };
}
