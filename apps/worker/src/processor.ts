import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import { JOBS, GeneratePlanJobSchema, PingJobSchema, SyncAthleteJobSchema, SYNC_HISTORY_DAYS, SYNC_ATTEMPTS } from "@pkg/shared";
import {
  executePlanRun, finishSyncRun, getValidStravaAccessToken, loadSyncRun, recordSyncFailure, saveActivityPage, startSyncRun,
  renewSyncLease, SyncLeaseLostError,
} from "@pkg/db";
import {
  fetchStravaActivities, refreshStravaTokens, StravaApiError, StravaDataError, StravaTokenError,
} from "@pkg/shared/strava";

export function stravaBackoff(attemptsMade: number, _type?: string, error?: Error) {
  const rateDelay = error instanceof StravaApiError || error instanceof StravaTokenError ? error.retryAfterMs : 0;
  return Math.max(rateDelay, Math.min(60000, 2000 * 2 ** (attemptsMade - 1)));
}

export async function processJob(job: Job) {
  if (job.name === JOBS.generatePlan) {
    const parsed = GeneratePlanJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError("Invalid GeneratePlanJob");
    const result = await executePlanRun(parsed.data.jobRunId);
    if (result.status === "DEFERRED") { await job.moveToDelayed(result.until!, job.token); throw new DelayedError(); }
    if (result.status !== "SUCCESS") throw new UnrecoverableError("Generation request is terminal");
    return result;
  }
  if (job.name === JOBS.ping) {
    const parsed = PingJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError(`Invalid PingJob: ${parsed.error.message}`);
    console.log(`Processed PingJob ${job.id} for user ${parsed.data.userId}`);
    return { processed: true, userId: parsed.data.userId };
  }
  if (job.name !== JOBS.syncAthlete) throw new UnrecoverableError(`Unsupported job: ${job.name}`);
  const parsed = SyncAthleteJobSchema.safeParse(job.data);
  if (!parsed.success) throw new UnrecoverableError("Invalid SyncAthleteJob");
  const syncRun = await loadSyncRun(parsed.data.jobRunId);
  if (!syncRun || syncRun.jobType !== "STRAVA_SYNC") throw new UnrecoverableError("Sync record not found");
  if (syncRun.status === "SUCCESS") return { activityCount: syncRun.activityCount };
  const claim = await startSyncRun(syncRun.id, job.attemptsMade);
  if (claim.kind === "deferred") {
    await job.moveToDelayed(claim.until, job.token);
    throw new DelayedError(); // Lease/rate-limit waits do not spend an attempt.
  }
  if (claim.kind === "terminal") {
    if (claim.status === "SUCCESS") return { activityCount: claim.activityCount };
    throw new UnrecoverableError("Sync cancelled, failed, or exhausted its attempts");
  }
  const { attemptNumber } = claim;

  try {
    const connection = syncRun.user.stravaConnection;
    if (!connection || !connection.scopes.includes("activity:read_all")) {
      throw new UnrecoverableError("Please reconnect Strava with activity access.");
    }
    // Freeze the window at enqueue time so every retry covers the same range.
    const before = Math.floor(syncRun.createdAt.getTime() / 1000);
    const after = before - SYNC_HISTORY_DAYS * 86400;
    let processedActivityCount = 0;
    for (let page = 1; ; page++) {
      await renewSyncLease(syncRun.id, attemptNumber);
      let accessToken = await getValidStravaAccessToken(syncRun.userId, refreshStravaTokens);
      let activities;
      try {
        activities = await fetchStravaActivities(accessToken, { after, before, page });
      } catch (error) {
        if (!(error instanceof StravaApiError) || error.status !== 401) throw error;
        // Refresh once on rejection, even if Postgres still says the token is valid.
        accessToken = await getValidStravaAccessToken(syncRun.userId, refreshStravaTokens, accessToken);
        activities = await fetchStravaActivities(accessToken, { after, before, page });
      }
      if (activities.length === 0) break;
      if (activities.some(activity => BigInt(activity.athlete.id) !== connection.athleteId)) {
        throw new UnrecoverableError("Strava returned activities for a different athlete.");
      }
      processedActivityCount += activities.length;
      await saveActivityPage(syncRun.id, syncRun.userId, activities, processedActivityCount, attemptNumber);
    }
    await finishSyncRun(syncRun.id, syncRun.userId, attemptNumber);
    console.log(`Sync ${syncRun.id} completed: ${processedActivityCount} activities processed`);
    return { activityCount: processedActivityCount };
  } catch (error) {
    // A newer attempt owns the record. Never overwrite its progress or failure.
    if (error instanceof SyncLeaseLostError) throw new UnrecoverableError(error.message);
    const isProviderError = error instanceof StravaApiError || error instanceof StravaTokenError;
    const isPermanentFailure = error instanceof UnrecoverableError || error instanceof StravaDataError ||
      (isProviderError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));
    const willRetry = !isPermanentFailure && attemptNumber < SYNC_ATTEMPTS &&
      job.attemptsMade + 1 < (job.opts.attempts ?? 1);

    let message = willRetry ? "Sync interrupted. Retrying automatically." : "Sync failed. Please try again.";
    if (isProviderError && [400, 401, 403].includes(error.status)) {
      message = "Strava access was rejected. Please reconnect Strava.";
    } else if (isProviderError && error.status === 429) {
      message = willRetry
        ? "Strava's request limit was reached. Waiting before retrying."
        : "Strava's request limit was reached. Please try syncing again later.";
    } else if (error instanceof UnrecoverableError || error instanceof StravaDataError) {
      message = error.message;
    }

    const retryAt = willRetry
      ? new Date(Date.now() + stravaBackoff(attemptNumber, "strava", error instanceof Error ? error : undefined))
      : null;
    await recordSyncFailure(syncRun.id, attemptNumber, message, retryAt);
    if (isPermanentFailure || attemptNumber >= SYNC_ATTEMPTS) throw new UnrecoverableError(message);
    // Preserve only the safe provider error's rate-limit delay for BullMQ backoff.
    if (isProviderError) throw error;
    throw new Error(message);
  }
}
