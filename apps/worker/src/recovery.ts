import { Queue } from "bullmq";
import { failUnleasedSyncRun, listUnfinishedSyncRuns } from "@pkg/db";
import {
  bullConnectionFromUrl, JOBS, QUEUES, SYNC_ATTEMPTS, SYNC_RECOVERY_INTERVAL_MS, syncJobId,
  type SyncAthleteJob,
} from "@pkg/shared";

type SyncRecoveryQueue = Queue<SyncAthleteJob, { activityCount: number }, typeof JOBS.syncAthlete>;

export async function recoverMissingSyncJobs(queue: SyncRecoveryQueue) {
  let afterId = 0;
  let enqueuedCount = 0;
  // Cursor paging prevents old pending jobs from starving newer records.
  for (;;) {
    const syncRuns = await listUnfinishedSyncRuns(afterId);
    if (syncRuns.length === 0) return enqueuedCount;
    for (const syncRun of syncRuns) {
      afterId = syncRun.id;
      // A lost Redis job may still have a live processor. Wait for its DB lease.
      if (syncRun.leaseExpiresAt && syncRun.leaseExpiresAt.getTime() > Date.now()) continue;
      const job = await queue.getJob(syncJobId(syncRun.id));
      if (job) {
        const state = await job.getState();
        if (state === "failed" || state === "completed") {
          // Postgres success is written before BullMQ completion. Do not invent
          // success or restart a terminal queue job when that DB write is missing.
          await failUnleasedSyncRun(syncRun.id, syncRun.attemptsStarted);
        }
        if (state !== "unknown") continue; // Includes active, waiting, paused, delayed.
      }
      if (syncRun.attemptsStarted >= SYNC_ATTEMPTS) {
        await failUnleasedSyncRun(syncRun.id, syncRun.attemptsStarted);
        continue;
      }
      await queue.add(JOBS.syncAthlete, { jobRunId: syncRun.id }, {
        jobId: syncJobId(syncRun.id), attempts: SYNC_ATTEMPTS,
        delay: Math.max(0, (syncRun.nextRetryAt?.getTime() ?? 0) - Date.now()),
        backoff: { type: "strava" },
        removeOnComplete: { count: 100 }, removeOnFail: { count: 100 },
      });
      enqueuedCount++;
    }
  }
}

export function startSyncRecovery(intervalMs = SYNC_RECOVERY_INTERVAL_MS) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingScan: Promise<void>;
  async function scan() {
    let queue: SyncRecoveryQueue | undefined;
    try {
      // Each scan owns a short-lived connection. A down Redis cannot leave the
      // startup scan waiting forever or prevent a later scan from reconnecting.
      queue = new Queue(QUEUES.jobs, {
        prefix: process.env.BULLMQ_PREFIX ?? "bull",
        connection: {
          ...bullConnectionFromUrl(process.env.REDIS_URL), maxRetriesPerRequest: 0,
          enableOfflineQueue: false, connectTimeout: 5000, commandTimeout: 5000,
          retryStrategy: () => null,
        },
      });
      queue.on("error", () => {}); // Log one safe scan failure below.
      const enqueuedCount = await recoverMissingSyncJobs(queue);
      if (enqueuedCount) console.log(`Sync recovery checked/enqueued ${enqueuedCount} missing jobs`);
    } catch {
      console.error("Sync recovery unavailable; will retry automatically");
    } finally {
      await queue?.close().catch(() => {});
      if (!stopped) timer = setTimeout(() => { pendingScan = scan(); }, intervalMs);
    }
  }
  pendingScan = scan();
  return async function stopSyncRecovery() {
    stopped = true;
    clearTimeout(timer);
    await pendingScan;
  };
}
