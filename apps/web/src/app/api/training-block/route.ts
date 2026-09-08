import { NextRequest, NextResponse } from "next/server";
import { createInitialTrainingBlock, createOrReuseReviewRun, getTrainingBlockState, saveTrainingFocus, TrainingBusyError, StaleBlockGenerationError } from "@pkg/db";
import { SaveTrainingFocusRequestSchema } from "@pkg/shared";
import { JOBS, ReviewWeekRequestSchema, reviewJobId } from "@pkg/shared";
import { getStravaConfig, SESSION_COOKIE, userFromSession } from "@/lib/strava-auth";
import { getReviewQueue, waitForQueue } from "@/lib/queue";

export const runtime = "nodejs";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(request: NextRequest) {
  try {
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava first." }, 401);
    return json(await getTrainingBlockState(user.id));
  } catch { return json({ error: "Could not load training block. Check Postgres and try again." }, 503); }
}
export async function POST(request: NextRequest) {
  try {
    if (request.headers.get("origin") !== getStravaConfig().callbackUrl.origin) return json({ error: "Invalid request origin" }, 403);
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava first." }, 401);
    const body = await request.json().catch(() => null);
    if (body?.action === "CREATE" || body?.action === "REPLACE") {
      await createInitialTrainingBlock(user.id, body.action === "REPLACE");
    } else if (body?.action === "SAVE_FOCUS") {
      const parsed = SaveTrainingFocusRequestSchema.safeParse(body);
      if (!parsed.success) return json({ error: "Provide whole focus percentages totaling 100% and reload your settings." }, 400);
      await saveTrainingFocus(user.id, parsed.data.focus, parsed.data.expectedUpdatedAt);
    } else if (body?.action === "REVIEW") {
      const parsed = ReviewWeekRequestSchema.safeParse(body.request);
      if (!parsed.success) return json({ error: "Choose a saved week and reload the current training block." }, 400);
      const run = await createOrReuseReviewRun(user.id, parsed.data);
      try {
        const queue = getReviewQueue(); await waitForQueue(queue);
        await queue.add(JOBS.reviewBlock, { jobRunId: run.id }, { jobId: reviewJobId(run.id) });
      } catch { /* Worker recovers the persistent request if Redis is unavailable. */ }
    } else return json({ error: "Choose Create, Replace, or Review Week." }, 400);
    return json(await getTrainingBlockState(user.id), 202);
  } catch (error) {
    if (error instanceof TrainingBusyError || error instanceof StaleBlockGenerationError) return json({ error: error.message }, 409);
    return json({ error: "Could not start this request. Review a saved week within the active block, or create a replacement block." }, 400);
  }
}
