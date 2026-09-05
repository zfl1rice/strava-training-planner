import { Queue } from "bullmq";
import { bullConnectionFromUrl, QUEUES, JOBS, SYNC_ATTEMPTS, type PingJob, type SyncAthleteJob } from "@pkg/shared";

type PingQueue = Queue<PingJob, { processed: boolean; userId: number }, typeof JOBS.ping>;
const globalForQueue = globalThis as unknown as { pingQueue?: PingQueue };
type SyncQueue = Queue<SyncAthleteJob, { activityCount: number }, typeof JOBS.syncAthlete>;
const globalForSyncQueue = globalThis as unknown as { syncQueue?: SyncQueue };

export function getSyncQueue(): SyncQueue {
  if (!globalForSyncQueue.syncQueue) {
    const queue: SyncQueue = new Queue<SyncAthleteJob, { activityCount: number }, typeof JOBS.syncAthlete>(QUEUES.jobs, {
      prefix: process.env.BULLMQ_PREFIX ?? "bull",
      connection: {
        ...bullConnectionFromUrl(process.env.REDIS_URL), maxRetriesPerRequest: 1,
        enableOfflineQueue: false, connectTimeout: 5000,
      },
      defaultJobOptions: {
        attempts: SYNC_ATTEMPTS, backoff: { type: "strava" },
        removeOnComplete: { count: 100 }, removeOnFail: { count: 100 },
      },
    });
    queue.on("error", (error) => console.error("Sync queue error:", error.message));
    globalForSyncQueue.syncQueue = queue;
  }
  return globalForSyncQueue.syncQueue;
}

export function getPingQueue(): PingQueue {
  if (!globalForQueue.pingQueue) {
    const queue: PingQueue = new Queue<
      PingJob,
      { processed: boolean; userId: number },
      typeof JOBS.ping
    >(QUEUES.jobs, {
      prefix: process.env.BULLMQ_PREFIX ?? "bull",
      connection: {
        ...bullConnectionFromUrl(process.env.REDIS_URL),
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 5000,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });
    queue.on("error", (error) => console.error("Queue error:", error.message));
    globalForQueue.pingQueue = queue;
  }
  return globalForQueue.pingQueue;
}

export async function waitForQueue(queue: { waitUntilReady(): Promise<unknown> }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      queue.waitUntilReady(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Redis connection timed out")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
