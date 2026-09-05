import { Queue } from "bullmq";
import { bullConnectionFromUrl, QUEUES, JOBS, type PingJob } from "@pkg/shared";

type PingQueue = Queue<PingJob, { processed: boolean; userId: number }, typeof JOBS.ping>;
const globalForQueue = globalThis as unknown as { pingQueue?: PingQueue };

export function getPingQueue(): PingQueue {
  if (!globalForQueue.pingQueue) {
    const queue: PingQueue = new Queue<
      PingJob,
      { processed: boolean; userId: number },
      typeof JOBS.ping
    >(QUEUES.jobs, {
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

export async function waitForQueue(queue: PingQueue) {
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