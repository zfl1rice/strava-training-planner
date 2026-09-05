import type { StravaAuthorization, StravaTokens } from "@pkg/shared";
import { prisma } from "./client.js";

export async function createOAuthState(tokenHash: string, expiresAt: Date) {
  await prisma.oAuthState.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  await prisma.oAuthState.create({ data: { tokenHash, expiresAt } });
}

export async function consumeOAuthState(tokenHash: string): Promise<boolean> {
  const result = await prisma.oAuthState.deleteMany({
    where: { tokenHash, expiresAt: { gt: new Date() } },
  });
  return result.count === 1;
}

export async function saveStravaAuthorization(
  authorization: StravaAuthorization,
  scopes: string[],
  session: { tokenHash: string; expiresAt: Date; previousTokenHash?: string },
) {
  const athleteId = BigInt(authorization.athlete.id);
  const name = [authorization.athlete.firstname, authorization.athlete.lastname].filter(Boolean).join(" ");
  return prisma.$transaction(async (tx) => {
    // Serialize first connections for the same athlete, including concurrent callbacks.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${athleteId})`;
    const connection = await tx.stravaConnection.upsert({
      where: { athleteId },
      create: {
        athleteId,
        user: { create: { name: name || null } },
        accessToken: authorization.access_token,
        refreshToken: authorization.refresh_token,
        expiresAt: new Date(authorization.expires_at * 1000),
        scopes,
      },
      update: {
        accessToken: authorization.access_token,
        refreshToken: authorization.refresh_token,
        expiresAt: new Date(authorization.expires_at * 1000),
        scopes,
        ...(name ? { user: { update: { name } } } : {}),
      },
    });
    await tx.session.deleteMany({ where: {
      OR: [
        { expiresAt: { lte: new Date() } },
        ...(session.previousTokenHash ? [{ tokenHash: session.previousTokenHash }] : []),
      ],
    } });
    await tx.session.create({ data: {
      tokenHash: session.tokenHash, expiresAt: session.expiresAt, userId: connection.userId,
    } });
    return connection.userId;
  });
}

export async function getSessionUser(tokenHash: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    select: { expiresAt: true, user: { select: { id: true, name: true } } },
  });
  return session && session.expiresAt > new Date() ? session.user : null;
}

export async function getStravaConnectionStatus(userId: number) {
  const connection = await prisma.stravaConnection.findUnique({
    where: { userId },
    select: { athleteId: true, expiresAt: true, scopes: true },
  });
  return connection ? {
    athleteId: connection.athleteId.toString(),
    expiresAt: connection.expiresAt.toISOString(),
    scopes: connection.scopes,
  } : null;
}

// Web and worker supply the shared Strava refresh function. All storage stays here.
export async function getValidStravaAccessToken(
  userId: number,
  refresh: (refreshToken: string) => Promise<StravaTokens>,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    // Reload after obtaining the row lock so competing refreshes use the latest token.
    await tx.$queryRaw`SELECT "userId" FROM "StravaConnection" WHERE "userId" = ${userId} FOR UPDATE`;
    const connection = await tx.stravaConnection.findUnique({ where: { userId } });
    if (!connection) throw new Error("Strava is not connected");
    if (connection.expiresAt.getTime() > Date.now() + 60000) return connection.accessToken;
    const tokens = await refresh(connection.refreshToken);
    if (tokens.expires_at * 1000 <= Date.now()) throw new Error("Strava returned an expired token");
    await tx.stravaConnection.update({ where: { userId }, data: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(tokens.expires_at * 1000),
    } });
    return tokens.access_token;
  }, { timeout: 20000, maxWait: 20000 });
}
