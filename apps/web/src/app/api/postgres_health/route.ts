import { NextResponse } from "next/server";
import { checkPostgresHealth } from "@/lib/health";

export const runtime = "nodejs";

export async function GET() {
  const health = await checkPostgresHealth();
  return NextResponse.json({ ...health, ts: new Date().toISOString() }, {
    status: health.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
