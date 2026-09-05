"use client";

import { useEffect, useState } from "react";
import { SYNC_HISTORY_DAYS, type SyncDashboard, type PlannerState } from "@pkg/shared";
import WeeklyTraining from "./training-summary";
import WeeklyPlanner from "./weekly-planner";

const formatUtcTimestamp = (date: string) => new Date(date).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export default function ActivityDashboard({ initialData, initialPlanner }: { initialData: SyncDashboard; initialPlanner: PlannerState }) {
  const [data, setData] = useState(initialData);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncActive = data.latestSync?.status === "PENDING" || data.latestSync?.status === "RUNNING";

  useEffect(() => {
    if (!syncActive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/strava/sync", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        if (!response.ok) throw new Error("Could not refresh sync progress. Please reload if this continues.");
        setData(await response.json());
        setError(null);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load sync progress.");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [syncActive]);

  async function startActivitySync() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/strava/sync", { method: "POST", signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not start sync.");
      // Start polling immediately, including when the worker has already completed.
      setData(current => ({ ...current, latestSync: {
        id: result.jobRunId, status: "PENDING", activityCount: 0, error: null,
        createdAt: new Date().toISOString(), finishedAt: null,
      } }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not start sync.");
    } finally { setSubmitting(false); }
  }

  const status = data.latestSync?.status;
  return (
    <>
    <WeeklyTraining summary={data.trainingSummary} />
    <WeeklyPlanner initialData={initialPlanner} syncActive={syncActive || submitting} />
    <section className="space-y-5 rounded-lg border p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">Activities</h2>
        <button onClick={() => void startActivitySync()} disabled={submitting || syncActive}
          className="rounded bg-orange-600 px-4 py-2 font-medium text-white disabled:opacity-50">
          {submitting ? "Starting..." : syncActive ? "Syncing..." : "Sync Activities"}
        </button>
      </div>
      <p className="text-sm">Syncs the last {SYNC_HISTORY_DAYS} days from Strava. Repeated syncs update existing activities.</p>
      <p>Last successful sync: {data.lastSuccessfulSyncAt ? formatUtcTimestamp(data.lastSuccessfulSyncAt) : "Not synced yet"}</p>
      <div role="status" aria-live="polite">
        {status === "PENDING" && <p>{data.latestSync?.error ?? "Sync requested. Waiting for it to start or resume automatically."}</p>}
        {status === "RUNNING" && <p>Syncing: {data.latestSync?.activityCount} activities processed...</p>}
        {status === "SUCCESS" && <p>Sync complete: {data.latestSync?.activityCount} activities processed.</p>}
        {status === "FAILED" && <p>{data.latestSync?.error ?? "Sync failed. Please try again."}</p>}
      </div>
      {error && <p role="alert">{error}</p>}
      {data.activities.length === 0 ? <p>No activities synced yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="mb-3 text-left font-medium">Most recent {data.activities.length} activities</caption>
            <thead><tr className="border-b"><th className="p-2">Activity</th><th className="p-2">Date (UTC)</th><th className="p-2">Moving time</th><th className="p-2">Distance</th></tr></thead>
            <tbody>{data.activities.map(activity => (
              <tr key={activity.id} className="border-b">
                <td className="p-2">
                  {activity.stravaActivityId ? <a className="underline" href={`https://www.strava.com/activities/${activity.stravaActivityId}`} target="_blank" rel="noopener noreferrer">{activity.name || activity.type}</a> : (activity.name || activity.type)}
                  <span className="block text-xs">{activity.type}</span>
                </td>
                <td className="whitespace-nowrap p-2">{activity.startedAt.slice(0, 10)}</td>
                <td className="whitespace-nowrap p-2">{Math.round(activity.durationSeconds / 60)} min</td>
                <td className="whitespace-nowrap p-2">{activity.distanceMeters === null ? "—" : activity.type === "SWIM" ? `${activity.distanceMeters} m` : `${(activity.distanceMeters / 1000).toFixed(2)} km`}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
    </>
  );
}
