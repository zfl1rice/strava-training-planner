export const QUEUES = {
  jobs: "jobs",
} as const;

export const JOBS = {
  ping: "ping",
  syncAthlete: "sync_athlete",
} as const;

export const SYNC_HISTORY_DAYS = 90;
export const SYNC_ATTEMPTS = 5;
export const syncJobId = (jobRunId: number) => `sync-${jobRunId}`;
