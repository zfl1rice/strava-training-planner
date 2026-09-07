CREATE TYPE "DevelopmentBlockStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ABORTED');

CREATE TABLE "DevelopmentBlock" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "startDate" DATE NOT NULL,
  "plannedEndDate" DATE NOT NULL,
  "phase" TEXT NOT NULL,
  "status" "DevelopmentBlockStatus" NOT NULL DEFAULT 'ACTIVE',
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "content" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DevelopmentBlock_dates_check" CHECK ("plannedEndDate" > "startDate")
);
CREATE INDEX "DevelopmentBlock_userId_startDate_idx" ON "DevelopmentBlock"("userId", "startDate");
CREATE UNIQUE INDEX "DevelopmentBlock_one_active_per_user" ON "DevelopmentBlock"("userId") WHERE "status" = 'ACTIVE';

CREATE TABLE "DevelopmentBlockReview" (
  "id" SERIAL PRIMARY KEY,
  "blockId" INTEGER NOT NULL REFERENCES "DevelopmentBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "revision" INTEGER NOT NULL CHECK ("revision" > 1),
  "reviewedWeekStart" DATE NOT NULL,
  "effectiveWeekStart" DATE NOT NULL,
  "decision" TEXT NOT NULL,
  "content" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DevelopmentBlockReview_dates_check" CHECK ("effectiveWeekStart" > "reviewedWeekStart")
);
CREATE UNIQUE INDEX "DevelopmentBlockReview_blockId_revision_key" ON "DevelopmentBlockReview"("blockId", "revision");
