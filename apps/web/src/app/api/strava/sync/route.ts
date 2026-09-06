import { NextRequest, NextResponse } from "next/server";
import { TrainingBusyError, createOrReuseSyncRun, getStravaConnectionStatus, getSyncDashboard } from "@pkg/db";
import { JOBS, SyncAthleteJobSchema, syncJobId } from "@pkg/shared";
import { getSyncQueue, waitForQueue } from "@/lib/queue";
import { getStravaConfig, SESSION_COOKIE, userFromSession } from "@/lib/strava-auth";

export const runtime = "nodejs";
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

export async function GET(request: NextRequest) {
  try {
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava first" }, 401);
    return json(await getSyncDashboard(user.id));
  } catch {
    return json({ error: "Could not load activities. Please try again." }, 503);
  }
}

export async function POST(request: NextRequest) {
  let jobRunId: number | undefined;
  try {
    if (request.headers.get("origin") !== getStravaConfig().callbackUrl.origin) {
      return json({ error: "Invalid request origin" }, 403);
    }
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava first" }, 401);
    if (!await getStravaConnectionStatus(user.id)) return json({ error: "Reconnect Strava first" }, 409);
    const syncRun = await createOrReuseSyncRun(user.id);
    jobRunId = syncRun.id;
    const queue = getSyncQueue();
    await waitForQueue(queue);
    const payload = SyncAthleteJobSchema.parse({ jobRunId });
    await queue.add(JOBS.syncAthlete, payload, { jobId: syncJobId(jobRunId) });
    return json({ ok: true, jobRunId }, 202);
  } catch (error) {
    if (error instanceof TrainingBusyError) return json({ error: error.message }, 409);
    // A committed intent remains pending even if Redis rejected the write or its
    // acknowledgement was lost. The worker reconciles it; duplicate callers must
    // never mark another caller's successfully enqueued job as failed.
    if (jobRunId !== undefined) return json({ ok: true, jobRunId, recoveryPending: true }, 202);
    return json({ error: "Could not queue activities. Please try again." }, 503);
  }
}
