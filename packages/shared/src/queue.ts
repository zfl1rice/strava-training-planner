export const QUEUES = {
  jobs: "jobs",
} as const;

export const JOBS = {
  reviewBlock: "review_block",
  generatePlan: "generate_plan",
  ping: "ping",
  syncAthlete: "sync_athlete",
} as const;

export const SYNC_HISTORY_DAYS = 90;
export const SYNC_ATTEMPTS = 5;
export const SYNC_RECOVERY_INTERVAL_MS = 30000;
export const SYNC_LEASE_MS = 120000;
export const syncJobId = (jobRunId: number) => `sync-${jobRunId}`;

export const planJobId = (jobRunId: number) => `plan-${jobRunId}`;
export const reviewJobId = (jobRunId: number) => `review-${jobRunId}`;
export const PLAN_ATTEMPTS = 3;
export const PLAN_LEASE_MS = 120000;
export const PLAN_HEARTBEAT_MS = 20000;
