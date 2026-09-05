import { NextResponse } from "next/server";
import { checkRedisHealth } from "@/lib/health";

export const runtime = "nodejs";

export async function GET() {
  const health = await checkRedisHealth();
  return NextResponse.json(health, {
    status: health.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
