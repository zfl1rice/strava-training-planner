"use client";

import { useEffect, useState } from "react";
import { SYNC_HISTORY_DAYS, type SyncDashboard, type PlannerState } from "@pkg/shared";
import WeeklyTraining from "./training-summary";
import TrainingBlockPanel from "./training-block-panel";
import WeeklyPlanner from "./weekly-planner";
import TrainingCalendar from "./training-calendar";

const formatUtcTimestamp = (date: string) => new Date(date).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export default function ActivityDashboard({ initialData, initialPlanner, initialGoalsOpen = false }: { initialData: SyncDashboard; initialPlanner: PlannerState; initialGoalsOpen?: boolean }) {
  const [data, setData] = useState(initialData);
  const [submitting, setSubmitting] = useState(false);
  const [planRevision, setPlanRevision] = useState(0);
  const [selectedWeek, setSelectedWeek] = useState("");
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
  const calendarRefreshKey = `${data.lastSuccessfulSyncAt}:${status}:${planRevision}`;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4">
        <div className="space-y-1 text-sm text-slate-500">
          <p>Last synced: {data.lastSuccessfulSyncAt ? formatUtcTimestamp(data.lastSuccessfulSyncAt) : "Not synced yet"}</p>
          <div role="status" aria-live="polite">
            {status === "PENDING" && <p>{data.latestSync?.error ?? "Sync requested. Waiting for it to start or resume automatically."}</p>}
            {status === "RUNNING" && <p>Syncing: {data.latestSync?.activityCount} activities processed…</p>}
            {status === "FAILED" && <p className="text-red-700">{data.latestSync?.error ?? "Sync failed. Please try again."}</p>}
            {status === "SUCCESS" && <p>{data.latestSync?.activityCount} activities processed · Last {SYNC_HISTORY_DAYS} days</p>}
          </div>
          {error && <p role="alert" className="text-red-700">{error}</p>}
        </div>
        <button onClick={() => void startActivitySync()} disabled={submitting || syncActive}
          className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">
          {submitting ? "Starting…" : syncActive ? "Syncing…" : "Sync Activities"}
        </button>
      </div>
      <TrainingCalendar initialMonth={initialData.trainingSummary.generatedAt.slice(0, 7)} refreshKey={calendarRefreshKey}
        selectedWeek={selectedWeek} onWeekChange={setSelectedWeek} onPlanChanged={() => setPlanRevision(value => value + 1)} />
      <TrainingBlockPanel refreshKey={planRevision} selectedWeek={selectedWeek} onWeekChange={setSelectedWeek} />
      <details className="rounded-xl border border-slate-200 bg-white" open={initialGoalsOpen}>
        <summary className="cursor-pointer px-5 py-4 font-medium">Plan settings &amp; weekly goals</summary>
        <WeeklyPlanner initialData={initialPlanner} refreshKey={planRevision} syncActive={syncActive || submitting}
          onPlanSaved={() => setPlanRevision(value => value + 1)} />
      </details>
      <details className="rounded-xl border border-slate-200 bg-white">
        <summary className="cursor-pointer px-5 py-4 font-medium">Training summaries</summary>
        <WeeklyTraining summary={data.trainingSummary} />
      </details>
    </div>
  );
}
