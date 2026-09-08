import { Queue } from "bullmq";
import { listUnfinishedPlanRuns, failAbandonedPlanRun } from "@pkg/db";
import { JOBS, QUEUES, PLAN_ATTEMPTS, planJobId, reviewJobId, bullConnectionFromUrl, type GeneratePlanJob } from "@pkg/shared";

type PlanQueue = Queue<GeneratePlanJob, unknown, typeof JOBS.generatePlan | typeof JOBS.reviewBlock>;
export async function recoverMissingPlanJobs(queue: PlanQueue, jobType: "COMPUTE_PLAN" | "REVIEW_BLOCK" = "COMPUTE_PLAN") {
  const jobId = jobType === "REVIEW_BLOCK" ? reviewJobId : planJobId;
  const jobName = jobType === "REVIEW_BLOCK" ? JOBS.reviewBlock : JOBS.generatePlan;
  let afterId = 0;
  for (;;) {
    const rows = await listUnfinishedPlanRuns(afterId, jobType);
    if (!rows.length) return;
    for (const row of rows) {
      afterId = row.id;
      if ((row.leaseExpiresAt?.getTime() ?? 0) > Date.now()) continue;
      const job = await queue.getJob(jobId(row.id));
      if (job) {
        const state = await job.getState();
        if (state === "failed" || state === "completed") await failAbandonedPlanRun(row.id, row.attemptsStarted, jobType);
        if (state !== "unknown") continue;
      }
      if (row.attemptsStarted >= PLAN_ATTEMPTS) { await failAbandonedPlanRun(row.id, row.attemptsStarted, jobType); continue; }
      await queue.add(jobName, { jobRunId: row.id }, { jobId: jobId(row.id), attempts: PLAN_ATTEMPTS,
        delay: Math.max(0, (row.nextRetryAt?.getTime() ?? 0) - Date.now()), backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } });
    }
  }
}

export function startPlanRecovery() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function scan() {
    const queue: PlanQueue = new Queue(QUEUES.jobs, { prefix: process.env.BULLMQ_PREFIX ?? "bull", connection: {
      ...bullConnectionFromUrl(process.env.REDIS_URL), maxRetriesPerRequest: 0, enableOfflineQueue: false,
      connectTimeout: 5000, commandTimeout: 5000, retryStrategy: () => null,
    } });
    queue.on("error", () => {});
    try {
      // The connection has bounded timeouts. Await initialization even when
      // Postgres has no jobs, so close cannot race a pending Redis handshake.
      await queue.waitUntilReady();
      await recoverMissingPlanJobs(queue); await recoverMissingPlanJobs(queue, "REVIEW_BLOCK");
    }
    catch { console.error("Plan recovery unavailable; retrying automatically"); }
    finally { await queue.close().catch(() => {}); if (!stopped) timer = setTimeout(() => { pending = scan(); }, 30000); }
  }
  let pending = scan();
  return async () => { stopped = true; clearTimeout(timer); await pending; };
}
