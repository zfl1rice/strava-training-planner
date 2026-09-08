"use client";

import { useRef, useState } from "react";
import { addCalendarDays, clearableWorkouts, type SavedWeeklyPlan } from "@pkg/shared";

export default function ClearWeekButton({ plan, today, onCleared }: { plan?: SavedWeeklyPlan; today: string; onCleared: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState<{ plan: SavedWeeklyPlan; today: string; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = plan ? clearableWorkouts(plan, today).length : 0;
  const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  async function clear() {
    if (!confirmation) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/calendar", { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: confirmation.plan.id, expectedUpdatedAt: confirmation.plan.updatedAt, today: confirmation.today }), signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not clear this week.");
      dialog.current?.close(); onCleared();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not clear this week."); }
    finally { setBusy(false); }
  }
  return <>
    <button className="calendar-nav" disabled={!count || busy} title={!count ? "No eligible planned workouts in the selected week" : undefined} onClick={() => {
      if (!plan) return;
      setConfirmation({ plan, today, count }); setError(null); dialog.current?.showModal();
    }}>Clear This Week</button>
    <dialog ref={dialog} className="workout-dialog p-6" aria-labelledby="clear-week-title" onCancel={event => { if (busy) event.preventDefault(); }}>
      <h3 id="clear-week-title" className="text-xl font-semibold">Clear this week’s planned workouts?</h3>
      {confirmation && <p className="mt-3 text-sm">This will remove {confirmation.count} planned workouts from {dateLabel(confirmation.plan.content.weekStart.slice(0, 10))}–{dateLabel(addCalendarDays(confirmation.plan.content.weekStart.slice(0, 10), 6))}.</p>}
      <p className="mt-2 text-sm text-slate-600">Completed activities and training history will not be affected. Past, locked and feedback-bearing workouts are protected.</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <button autoFocus className="calendar-nav" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
        <button className="settings-primary" disabled={busy} onClick={() => void clear()}>{busy ? "Clearing…" : "Clear Week"}</button>
      </div>
    </dialog>
  </>;
}
