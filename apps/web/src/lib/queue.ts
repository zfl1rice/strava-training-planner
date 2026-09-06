import { Queue } from "bullmq";
import { bullConnectionFromUrl, QUEUES, JOBS, SYNC_ATTEMPTS, PLAN_ATTEMPTS, type GeneratePlanJob, type PingJob, type SyncAthleteJob } from "@pkg/shared";

type PingQueue = Queue<PingJob, { processed: boolean; userId: number }, typeof JOBS.ping>;
type SyncQueue = Queue<SyncAthleteJob, { activityCount: number }, typeof JOBS.syncAthlete>;
// Cache both producers across Next.js hot reloads, preserving their distinct types.
type PlanQueue = Queue<GeneratePlanJob, unknown, typeof JOBS.generatePlan>;
const queueCache = globalThis as unknown as { planQueue?: PlanQueue; pingQueue?: PingQueue; syncQueue?: SyncQueue };

export function getSyncQueue(): SyncQueue {
  if (!queueCache.syncQueue) {
    const queue: SyncQueue = new Queue(QUEUES.jobs, {
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
    queueCache.syncQueue = queue;
  }
  return queueCache.syncQueue;
}

export function getPingQueue(): PingQueue {
  if (!queueCache.pingQueue) {
    const queue: PingQueue = new Queue(QUEUES.jobs, {
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
    queueCache.pingQueue = queue;
  }
  return queueCache.pingQueue;
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

export function getPlanQueue(): PlanQueue {
  if (!queueCache.planQueue) {
    queueCache.planQueue = new Queue(QUEUES.jobs, { prefix: process.env.BULLMQ_PREFIX ?? "bull", connection: {
      ...bullConnectionFromUrl(process.env.REDIS_URL), maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 5000,
    }, defaultJobOptions: { attempts: PLAN_ATTEMPTS, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } } });
    queueCache.planQueue.on("error", () => console.error("Plan queue unavailable"));
  }
  return queueCache.planQueue;
}
