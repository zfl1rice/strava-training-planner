import { UnrecoverableError, type Job } from "bullmq";
import { JOBS, PingJobSchema, SyncAthleteJobSchema, SYNC_HISTORY_DAYS } from "@pkg/shared";
import {
  finishSyncRun, getValidStravaAccessToken, loadSyncRun, recordSyncFailure, saveActivityPage, startSyncRun,
} from "@pkg/db";
import {
  fetchStravaActivities, refreshStravaTokens, StravaApiError, StravaDataError, StravaTokenError,
} from "@pkg/shared/strava";

export function stravaBackoff(attemptsMade: number, _type?: string, error?: Error) {
  const rateDelay = error instanceof StravaApiError || error instanceof StravaTokenError ? error.retryAfterMs : 0;
  return Math.max(rateDelay, Math.min(60000, 2000 * 2 ** (attemptsMade - 1)));
}

export async function processJob(job: Job) {
  if (job.name === JOBS.ping) {
    const parsed = PingJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError(`Invalid PingJob: ${parsed.error.message}`);
    console.log(`Processed PingJob ${job.id} for user ${parsed.data.userId}`);
    return { processed: true, userId: parsed.data.userId };
  }
  if (job.name !== JOBS.syncAthlete) throw new UnrecoverableError(`Unsupported job: ${job.name}`);
  const parsed = SyncAthleteJobSchema.safeParse(job.data);
  if (!parsed.success) throw new UnrecoverableError("Invalid SyncAthleteJob");
  const run = await loadSyncRun(parsed.data.jobRunId);
  if (!run || run.jobType !== "STRAVA_SYNC") throw new UnrecoverableError("Sync record not found");
  if (run.status === "SUCCESS") return { activityCount: run.activityCount };
  if (run.status === "CANCELLED") throw new UnrecoverableError("Sync cancelled");

  try {
    const connection = run.user.stravaConnection;
    if (!connection || !connection.scopes.includes("activity:read_all")) {
      throw new UnrecoverableError("Please reconnect Strava with activity access.");
    }
    await startSyncRun(run.id);
    // Freeze the window at enqueue time so every retry covers the same range.
    const before = Math.floor(run.createdAt.getTime() / 1000);
    const after = before - SYNC_HISTORY_DAYS * 86400;
    let count = 0;
    for (let page = 1; ; page++) {
      let accessToken = await getValidStravaAccessToken(run.userId, refreshStravaTokens);
      let activities;
      try {
        activities = await fetchStravaActivities(accessToken, { after, before, page });
      } catch (error) {
        if (!(error instanceof StravaApiError) || error.status !== 401) throw error;
        // Refresh once on rejection, even if Postgres still says the token is valid.
        accessToken = await getValidStravaAccessToken(run.userId, refreshStravaTokens, accessToken);
        activities = await fetchStravaActivities(accessToken, { after, before, page });
      }
      if (activities.length === 0) break;
      if (activities.some(activity => BigInt(activity.athlete.id) !== connection.athleteId)) {
        throw new UnrecoverableError("Strava returned activities for a different athlete.");
      }
      count += activities.length;
      await saveActivityPage(run.id, run.userId, activities, count);
    }
    await finishSyncRun(run.id, run.userId);
    console.log(`Sync ${run.id} completed: ${count} activities processed`);
    return { activityCount: count };
  } catch (error) {
    const providerError = error instanceof StravaApiError || error instanceof StravaTokenError;
    const permanent = error instanceof UnrecoverableError || error instanceof StravaDataError ||
      (providerError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));
    const retrying = !permanent && job.attemptsMade + 1 < (job.opts.attempts ?? 1);
    const message = providerError && [400, 401, 403].includes(error.status)
      ? "Strava access was rejected. Please reconnect Strava."
      : providerError && error.status === 429
        ? "Strava's request limit was reached. Waiting before retrying."
        : error instanceof UnrecoverableError || error instanceof StravaDataError
          ? error.message
          : retrying ? "Sync interrupted. Retrying automatically." : "Sync failed. Please try again.";
    await recordSyncFailure(run.id, message, retrying);
    if (permanent) throw new UnrecoverableError(message);
    // Preserve only the safe provider error's rate-limit delay for BullMQ backoff.
    if (providerError) throw error;
    throw new Error(message);
  }
}
