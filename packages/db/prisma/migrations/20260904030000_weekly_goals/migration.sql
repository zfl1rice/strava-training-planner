CREATE TABLE "WeeklyGoals" (
    "userId" INTEGER NOT NULL,
    "runMinutes" INTEGER,
    "bikeMinutes" INTEGER,
    "swimMinutes" INTEGER,
    CONSTRAINT "WeeklyGoals_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "WeeklyGoals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
