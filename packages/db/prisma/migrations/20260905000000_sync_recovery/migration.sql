ALTER TABLE "JobRun"
  ADD COLUMN "attemptsStarted" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextRetryAt" TIMESTAMP(3),
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

-- Give any pre-upgrade running worker time to finish before recovery begins.
UPDATE "JobRun" SET "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '2 minutes'
WHERE "jobType" = 'STRAVA_SYNC' AND "status" = 'RUNNING';
