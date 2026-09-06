ALTER TABLE "User" ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE "WeeklyPlan" ADD COLUMN "workoutStates" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "AthleteProfile" (
    "userId" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AthleteProfile_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "RaceGoal" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "importance" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RaceGoal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RaceGoal_importance_check" CHECK ("importance" BETWEEN 0 AND 100)
);

CREATE TABLE "PerformanceEvidence" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "sport" "ActivityType" NOT NULL,
    "metric" TEXT NOT NULL,
    "benchmark" DOUBLE PRECISION NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "sourceActivityId" INTEGER,
    "source" TEXT NOT NULL,
    "isPersonalRecord" BOOLEAN NOT NULL,
    "methodVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PerformanceEvidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PerformanceEvidence_values_check" CHECK ("benchmark" > 0 AND "value" > 0),
    CONSTRAINT "PerformanceEvidence_metric_check" CHECK (
      ("metric" = 'POWER_DURATION' AND "sport" = 'BIKE') OR
      ("metric" = 'DISTANCE_TIME' AND "sport" IN ('RUN', 'BIKE', 'SWIM'))
    ),
    CONSTRAINT "PerformanceEvidence_source_check" CHECK ("source" IN ('MEASURED', 'MANUAL', 'ESTIMATED'))
);

CREATE INDEX "RaceGoal_userId_date_idx" ON "RaceGoal"("userId", "date");
CREATE INDEX "PerformanceEvidence_userId_sport_metric_benchmark_occurredAt_idx"
  ON "PerformanceEvidence"("userId", "sport", "metric", "benchmark", "occurredAt");
ALTER TABLE "AthleteProfile" ADD CONSTRAINT "AthleteProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RaceGoal" ADD CONSTRAINT "RaceGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PerformanceEvidence" ADD CONSTRAINT "PerformanceEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PerformanceEvidence" ADD CONSTRAINT "PerformanceEvidence_sourceActivityId_fkey" FOREIGN KEY ("sourceActivityId") REFERENCES "Activity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
