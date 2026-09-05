import { cookies } from "next/headers";
import { getStravaConnectionStatus, getSyncDashboard } from "@pkg/db";
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
  let storageError = false;
  try {
    const cookieStore = await cookies();
    user = await userFromSession(cookieStore.get(SESSION_COOKIE)?.value);
    if (user) connection = await getStravaConnectionStatus(user.id);
    if (user && connection) dashboard = await getSyncDashboard(user.id);
  } catch { storageError = true; }
  const message = params.strava ? messages[params.strava] : undefined;

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-6 py-16">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold">Triathlon training planner</h1>
        <p>Connect Strava to get started with your swim, bike, and run training.</p>
      </header>
      {message && <p role="status" className="rounded border p-4">{message}</p>}
      {storageError && <p role="alert">Connection status is unavailable. Check that Postgres is running.</p>}
      <section className="space-y-4 rounded-lg border p-6">
        <h2 className="text-xl font-semibold">Strava</h2>
        {connection ? (
          <p>Connected{user?.name ? ` as ${user.name}` : ""}. Athlete ID: {connection.athleteId}.</p>
        ) : <p>Strava is not connected.</p>}
        {!configured && <p>Strava connection is not configured yet. Follow the setup instructions in the project README.</p>}
        <form method="post" action="/api/strava/connect">
          <button disabled={!configured || storageError} className="rounded bg-orange-600 px-5 py-3 font-medium text-white disabled:opacity-50">
            {connection ? "Reconnect Strava" : "Connect Strava"}
          </button>
        </form>
      </section>
      {dashboard && <ActivityDashboard initialData={dashboard} />}
    </main>
  );
}
