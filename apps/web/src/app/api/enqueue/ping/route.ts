import { NextResponse } from "next/server";
import { JOBS, PingJobSchema } from "@pkg/shared";
import { getPingQueue, waitForQueue } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(request: Request) {
  // Server-only opt-in, checked before reading the body or creating a queue client.
  if (process.env.ENABLE_PING_DIAGNOSTICS !== "true") {
    return NextResponse.json({ ok: false, message: "Not found" }, {
      status: 404, headers: { "Cache-Control": "no-store" },
    });
  }
  let input: unknown;
  try {
    const body = await request.text();
    input = body ? JSON.parse(body) : { userId: 1 };
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
  }
  const payload = PingJobSchema.safeParse(input);
  if (!payload.success) {
    return NextResponse.json({ ok: false, message: "Invalid PingJob" }, { status: 400 });
  }
  try {
    const queue = getPingQueue();
    await waitForQueue(queue);
    const job = await queue.add(JOBS.ping, payload.data);
    return NextResponse.json({ ok: true, jobId: job.id }, { status: 202 });
  } catch (error) {
    console.error("Failed to enqueue PingJob:", error);
    return NextResponse.json({ ok: false, message: "Queue unavailable" }, { status: 503 });
  }
}
