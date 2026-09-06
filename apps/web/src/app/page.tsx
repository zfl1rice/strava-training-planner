import { cookies } from "next/headers";
import { getStravaConnectionStatus, getSyncDashboard, getPlannerState } from "@pkg/db";
import ActivityDashboard from "./activity-dashboard";
import { getStravaConfig, SESSION_COOKIE, userFromSession } from "@/lib/strava-auth";

export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  connected: "Strava connected successfully.",
  config_error: "Strava connection is not configured yet.",
  storage_error: "Could not save the connection. Check that Postgres is running, then try again.",
  invalid_state: "This connection attempt expired or could not be verified. Please try again.",
  denied: "Strava access was cancelled. You can connect whenever you are ready.",
  missing_code: "Strava did not return an authorization code. Please try again.",
  missing_scope: "Please allow access to your activities, including private activities, to connect.",
  exchange_failed: "Could not complete Strava authorization. Please try connecting again.",
};

export default async function Home({ searchParams }: {
  searchParams: Promise<{ strava?: string }>;
}) {
  const params = await searchParams;
  let configured = true;
  try { getStravaConfig(); } catch { configured = false; }
  let user = null;
  let connection = null;
  let dashboard = null;
  let planner = null;
  let storageError = false;
  try {
    const cookieStore = await cookies();
    user = await userFromSession(cookieStore.get(SESSION_COOKIE)?.value);
    if (user) connection = await getStravaConnectionStatus(user.id);
    if (user && connection) dashboard = await getSyncDashboard(user.id);
    if (user && connection) planner = await getPlannerState(user.id);
  } catch { storageError = true; }
  const message = params.strava ? messages[params.strava] : undefined;

  return (
    <main className="mx-auto max-w-[1680px] space-y-5 px-4 py-6 sm:px-8">
      <header className="space-y-1 border-b border-slate-200 pb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Swim · Bike · Run</p>
        <h1 className="text-2xl font-semibold tracking-tight">Training planner</h1>
        <p className="text-sm text-slate-500">Your training history and the week ahead, in one place.</p>
      </header>
      {message && <p role="status" className="rounded border p-4">{message}</p>}
      {storageError && <p role="alert">Connection status is unavailable. Check that Postgres is running.</p>}
      <section className="flex flex-wrap items-center justify-between gap-4 text-sm">
        <h2 className="font-semibold">Strava</h2>
        {connection ? (
          <p className="mr-auto text-emerald-700">● Connected{user?.name ? ` as ${user.name}` : ""}</p>
        ) : <p>Strava is not connected.</p>}
        {!configured && <p>Strava connection is not configured yet. Follow the setup instructions in the project README.</p>}
        <form method="post" action="/api/strava/connect">
          <button disabled={!configured || storageError} className="rounded-lg border border-slate-200 bg-white px-4 py-2 font-medium hover:bg-slate-50 disabled:opacity-50">
            {connection ? "Reconnect Strava" : "Connect Strava"}
          </button>
        </form>
      </section>
      {dashboard && planner && <ActivityDashboard initialData={dashboard} initialPlanner={planner} />}
    </main>
  );
}
