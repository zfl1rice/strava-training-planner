import type { Prisma } from "@prisma/client";

// Both sync creation and plan generation must take this transaction-scoped lock.
// Negative user IDs preserve the existing namespace, separate from OAuth athlete locks.
export async function lockUserTraining(transaction: Prisma.TransactionClient, userId: number) {
  // Bound contention; never hold an HTTP request indefinitely behind another transaction.
  await transaction.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${-BigInt(userId)})`;
}
