import { summarizeTraining, trainingWindowStart, type TrainingSummary } from "@pkg/shared";
import { prisma } from "./client.js";
import type { Prisma } from "@prisma/client";

export async function getTrainingSummary(userId: number, now = new Date(), database: Prisma.TransactionClient = prisma): Promise<TrainingSummary> {
  // Query every activity in the window, independently of the dashboard's 30-row list.
  const activities = await database.activity.findMany({
    where: { userId, startedAt: { gte: trainingWindowStart(now), lte: now } },
    select: { type: true, startedAt: true, durationSeconds: true, distanceMeters: true },
  });
  return summarizeTraining(activities, now);
}
