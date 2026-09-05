import type { StravaActivity, SyncDashboard } from "@pkg/shared";
import { prisma } from "./client.js";

export async function createOrReuseSyncRun(userId: number) {
  return prisma.$transaction(async (tx) => {
    // Negative keys keep sync requests separate from OAuth's athlete locks.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${-BigInt(userId)})`;
    const connection = await tx.stravaConnection.findUnique({ where: { userId }, select: { userId: true } });
    if (!connection) throw new Error("Strava is not connected");
    const active = await tx.jobRun.findFirst({
      where: { userId, jobType: "STRAVA_SYNC", status: { in: ["PENDING", "RUNNING"] } },
      orderBy: { createdAt: "desc" },
    });
    return active ?? tx.jobRun.create({ data: { userId, jobType: "STRAVA_SYNC" } });
  });
}

export async function failSyncEnqueue(id: number) {
  await prisma.jobRun.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "FAILED", error: "Could not queue activities. Please try syncing again.", finishedAt: new Date() },
  });
}

export async function loadSyncRun(id: number) {
  return prisma.jobRun.findUnique({ where: { id }, include: { user: {
    select: { stravaConnection: { select: { athleteId: true, scopes: true } } },
  } } });
}

export async function startSyncRun(id: number) {
  return prisma.jobRun.update({ where: { id }, data: {
    status: "RUNNING", startedAt: new Date(), finishedAt: null, error: null, activityCount: 0,
  } });
}

function activityType(sport: string): "RUN" | "BIKE" | "SWIM" | "OTHER" {
  if (["Run", "TrailRun", "VirtualRun"].includes(sport)) return "RUN";
  if (["Ride", "VirtualRide", "MountainBikeRide", "GravelRide", "EBikeRide", "EMountainBikeRide", "Handcycle", "Velomobile"].includes(sport)) return "BIKE";
  return sport === "Swim" ? "SWIM" : "OTHER";
}

export async function saveActivityPage(jobRunId: number, userId: number, activities: StravaActivity[], activityCount: number) {
  await prisma.$transaction(async (tx) => {
    for (const activity of activities) {
      const data = {
        name: activity.name,
        type: activityType(activity.sport_type ?? activity.type),
        startedAt: new Date(activity.start_date),
        durationSeconds: activity.moving_time,
        distanceMeters: Math.round(activity.distance),
        elevationMeters: activity.total_elevation_gain === undefined ? null : Math.round(activity.total_elevation_gain),
        source: "STRAVA" as const,
      };
      const saved = await tx.activity.upsert({
        where: { stravaActivityId: BigInt(activity.id) },
        create: { ...data, userId, stravaActivityId: BigInt(activity.id) },
        update: data,
        select: { userId: true },
      });
      // Roll back the page rather than change another user's activity.
      if (saved.userId !== userId) throw new Error("Activity ownership mismatch");
    }
    await tx.jobRun.update({ where: { id: jobRunId }, data: { activityCount } });
  }, { timeout: 20000 });
}

export async function finishSyncRun(id: number, userId: number) {
  const finishedAt = new Date();
  await prisma.$transaction([
    prisma.jobRun.update({ where: { id }, data: { status: "SUCCESS", finishedAt, error: null } }),
    prisma.stravaConnection.update({ where: { userId }, data: { lastSuccessfulSyncAt: finishedAt } }),
  ]);
}

export async function recordSyncFailure(id: number, message: string, retrying: boolean) {
  await prisma.jobRun.updateMany({ where: { id, jobType: "STRAVA_SYNC", status: { in: ["PENDING", "RUNNING"] } }, data: {
    status: retrying ? "PENDING" : "FAILED", error: message,
    finishedAt: retrying ? null : new Date(),
  } });
}

export async function getSyncDashboard(userId: number): Promise<SyncDashboard> {
  const [connection, latestSync, activities] = await Promise.all([
    prisma.stravaConnection.findUnique({ where: { userId }, select: { lastSuccessfulSyncAt: true } }),
    prisma.jobRun.findFirst({ where: { userId, jobType: "STRAVA_SYNC" }, orderBy: { id: "desc" },
      select: { id: true, status: true, activityCount: true, error: true, createdAt: true, finishedAt: true } }),
    prisma.activity.findMany({ where: { userId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 30,
      select: { id: true, name: true, type: true, startedAt: true, durationSeconds: true, distanceMeters: true, stravaActivityId: true } }),
  ]);
  return {
    lastSuccessfulSyncAt: connection?.lastSuccessfulSyncAt?.toISOString() ?? null,
    latestSync: latestSync ? { ...latestSync, createdAt: latestSync.createdAt.toISOString(), finishedAt: latestSync.finishedAt?.toISOString() ?? null } : null,
    activities: activities.map(activity => ({
      ...activity, startedAt: activity.startedAt.toISOString(), stravaActivityId: activity.stravaActivityId?.toString() ?? null,
    })),
  };
}
