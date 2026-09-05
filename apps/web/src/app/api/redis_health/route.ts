import { NextResponse } from "next/server";

export async function GET() {
  try {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is missing");

    // lazy import so it stays server-only
    const { default: IORedis } = await import("ioredis");
    const redis = new IORedis(url);

    const pong = await redis.ping();
    await redis.quit();

    return NextResponse.json({ ok: true, pong, redisUrlPresent: true });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, message: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
