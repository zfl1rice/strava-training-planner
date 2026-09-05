import IORedis from "ioredis";
import { prisma } from "@pkg/db";

export async function checkPostgresHealth() {
  try {
    // Also verify the application schema, without counting every user.
    await prisma.user.findFirst({ select: { id: true } });
    return { ok: true, db: "ok" };
  } catch {
    // Public diagnostics must not expose connection strings or database errors.
    return { ok: false, db: "error", message: "Postgres is unavailable" };
  }
}

export async function checkRedisHealth() {
  let client: IORedis | undefined;
  try {
    if (!process.env.REDIS_URL) throw new Error("REDIS_URL is missing");
    client = new IORedis(process.env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    // Connect/ping reject below; suppress ioredis's separate unhandled-error log.
    client.on("error", () => {});
    await client.connect();
    const pong = await client.ping();
    return { ok: pong === "PONG", pong };
  } catch {
    return { ok: false, message: "Redis is unavailable" };
  } finally {
    // A diagnostic owns this connection and closes it on both success and failure.
    client?.disconnect();
  }
}
