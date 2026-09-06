import { Queue } from "bullmq";
import { listUnfinishedPlanRuns, failAbandonedPlanRun } from "@pkg/db";
import { JOBS, QUEUES, PLAN_ATTEMPTS, planJobId, bullConnectionFromUrl, type GeneratePlanJob } from "@pkg/shared";

type PlanQueue = Queue<GeneratePlanJob, unknown, typeof JOBS.generatePlan>;
export async function recoverMissingPlanJobs(queue: PlanQueue) {
  let afterId = 0;
  for (;;) {
    const rows = await listUnfinishedPlanRuns(afterId);
    if (!rows.length) return;
    for (const row of rows) {
      afterId = row.id;
      if ((row.leaseExpiresAt?.getTime() ?? 0) > Date.now()) continue;
      const job = await queue.getJob(planJobId(row.id));
      if (job) {
        const state = await job.getState();
        if (state === "failed" || state === "completed") await failAbandonedPlanRun(row.id, row.attemptsStarted);
        if (state !== "unknown") continue;
      }
      if (row.attemptsStarted >= PLAN_ATTEMPTS) { await failAbandonedPlanRun(row.id, row.attemptsStarted); continue; }
      await queue.add(JOBS.generatePlan, { jobRunId: row.id }, { jobId: planJobId(row.id), attempts: PLAN_ATTEMPTS,
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
    try { await recoverMissingPlanJobs(queue); }
    catch { console.error("Plan recovery unavailable; retrying automatically"); }
    finally { await queue.close().catch(() => {}); if (!stopped) timer = setTimeout(() => { pending = scan(); }, 30000); }
  }
  let pending = scan();
  return async () => { stopped = true; clearTimeout(timer); await pending; };
}
