"use client";

import { useEffect, useState } from "react";
import { PlanSportSchema, blockWeekPattern, weeksBetween, type TrainingBlockState, type TrainingFocus } from "@pkg/shared";
import TrainingFocusEditor from "./training-focus-editor";
import { focusRoleLabels, progressionLabels, readableLabel, reviewWeekLabel } from "./training-block-labels";

export function BlockSummary({ state }: { state: TrainingBlockState }) {
  const block = state.block;
  if (!block) return <p className="text-sm text-slate-600">Save your training focus, then create a strategy or generate your first week to get started.</p>;
  const review = block.reviews.at(-1);
  const pattern = blockWeekPattern(block);
  const index = weeksBetween(block.proposal.startDate, state.currentMonday);
  return <div className="space-y-4">
    <div>
      <h3 className="text-xl font-semibold">{readableLabel(block.proposal.phase)}</h3>
      <p className="mt-1 text-sm text-slate-600">{block.status !== "ACTIVE" ? `${block.status === "ABORTED" ? "Previous strategy" : "Completed block"} · Started ${block.proposal.startDate}`
        : index < 0 ? `Starts ${block.proposal.startDate} · ${pattern.length} weeks`
        : index >= pattern.length ? "Block schedule finished · Review before planning the next block"
        : `Week ${index + 1} of ${pattern.length} · ${readableLabel(pattern[index])}`}</p>
    </div>
    <details className="rounded-lg border border-slate-200 p-4">
      <summary className="cursor-pointer font-medium">Current emphasis</summary>
      <p className="mt-3 text-xs text-slate-500">These explanations reflect the goals and preferences used to create this strategy. Newly saved focus preferences apply when you start a new strategy.</p>
      <p className="mt-3 text-sm text-slate-600">{block.proposal.rationale}</p>
      <ul className="mt-4 grid gap-4 md:grid-cols-3">{block.proposal.focuses.map(focus => <li key={`${focus.sport}:${focus.capability}`} className="space-y-2 rounded-lg bg-slate-50 p-4 text-sm">
        <h4 className="font-semibold">{readableLabel(focus.sport)} — {readableLabel(focus.capability)}</h4>
        <p className="text-blue-700">{focusRoleLabels[focus.role]}</p>
        <p><strong>Why: </strong>{focus.rationale}</p>
        <p><strong>Progression: </strong>{progressionLabels[focus.progressionStrategy]}</p>
      </li>)}{PlanSportSchema.options.filter(sport => !block.proposal.focuses.some(focus => focus.sport === sport)).map(sport => <li key={sport} className="space-y-2 rounded-lg bg-slate-50 p-4 text-sm">
        <h4 className="font-semibold">{readableLabel(sport)} — No active focus</h4>
        <p>This saved strategy does not include a development focus for {readableLabel(sport).toLowerCase()}. Review your weekly goals and saved emphasis when selecting your next strategy.</p>
        <p><strong>Progression: </strong>No progression assigned.</p>
      </li>)}</ul>
    </details>
    <details className="rounded-lg border border-slate-200 p-4">
      <summary className="cursor-pointer font-medium">Week structure</summary>
      <ol className="mt-3 flex flex-wrap gap-2 text-sm" aria-label="Block week pattern">{pattern.map((role, week) => <li key={week} aria-current={week === index && block.status === "ACTIVE" ? "step" : undefined}
        className={`rounded px-3 py-2 ${week === index && block.status === "ACTIVE" ? "bg-blue-50 text-blue-800" : "bg-slate-50"}`}>Week {week + 1} · {readableLabel(role)}</li>)}</ol>
    </details>
    {review && <section className="space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4" aria-label="Latest block review">
      <h3 className="font-semibold">Review: {readableLabel(review.request.decision)}</h3>
      <p className="text-xs">Week of {review.request.reviewedWeekStart} · Effective {review.request.effectiveWeekStart}</p>
      <p className="text-sm">{review.request.rationale}</p>
      <ul className="space-y-2 text-sm">{review.request.focusGuidance?.map(focus => <li key={`${focus.sport}:${focus.capability}`}><strong>{readableLabel(focus.sport)} · {readableLabel(focus.capability)}: {readableLabel(focus.action)}</strong><p>{focus.rationale}</p></li>)}</ul>
      <p className="text-xs">{block.status === "ACTIVE" ? "This guidance informs your next generation. Existing calendar workouts stay as saved." : "This strategy has ended. Start a new strategy before generating another week; your review stays in history."}</p>
      <p className="text-xs">Reported completion is your feedback. Recorded activities do not yet verify that prescribed interval targets were achieved.</p>
    </section>}
  </div>;
}

export default function TrainingBlockPanel({ refreshKey, selectedWeek, onWeekChange }: {
  refreshKey: number; selectedWeek?: string; onWeekChange?: (week: string) => void;
}) {
  const [state, setState] = useState<TrainingBlockState | null>(null);
  const [week, setWeek] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const pending = state?.review?.status === "PENDING" || state?.review?.status === "RUNNING";
  const reviewWeek = selectedWeek || week || state?.currentMonday || "";
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch("/api/training-block", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load training strategy.");
        if (!controller.signal.aborted) { setState(body); setError(null); }
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load training strategy."); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), pending ? 2000 : 15000); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pending, reload, refreshKey]);

  async function submit(action: "CREATE" | "REPLACE" | "REVIEW" | "SAVE_FOCUS", focus?: TrainingFocus) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/training-block", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action,
          ...(action === "SAVE_FOCUS" ? { focus, expectedUpdatedAt: state?.profileUpdatedAt ?? null } : {}),
          ...(action === "REVIEW" ? { request: { blockId: state?.block?.id, revision: state?.block?.revision, weekStart: reviewWeek } } : {}),
        }), signal: AbortSignal.timeout(20000) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Request failed.");
      setState(body); setReload(value => value + 1);
      if (action === "SAVE_FOCUS") setMessage("Focus saved for future strategies. To apply it now, update your current strategy below. Calendar workouts stay unchanged until you regenerate them.");
      if (action === "REPLACE" || action === "CREATE") setMessage("Strategy ready. Generate or regenerate a week to apply it to the calendar. Previous strategies and training history are preserved.");
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : "Request failed."); return false; }
    finally { setBusy(false); }
  }
  const active = state?.block?.status === "ACTIVE";
  const complete = Boolean(state && reviewWeek < state.currentMonday);
  return <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="block-heading">
    <h2 id="block-heading" className="text-lg font-semibold">Training Plan</h2>
    {state && <TrainingFocusEditor key={JSON.stringify(state.trainingFocus)} saved={state.trainingFocus} busy={busy} onSave={focus => submit("SAVE_FOCUS", focus)} />}
    {state ? <BlockSummary state={state} /> : <p>Loading training strategy…</p>}
    <div className="space-y-2">
      <button className="calendar-nav" disabled={busy || pending || !state} onClick={() => {
        if (!active || window.confirm("Update your current strategy using saved focus and goals? Your previous strategy remains in history. Calendar workouts are unchanged until you regenerate.")) void submit(active ? "REPLACE" : "CREATE");
      }}>{active ? "Apply saved focus to a new strategy" : "Start training strategy"}</button>
      <p className="text-xs text-slate-500">Strategy updates use your saved goals, emphasis and race context. They do not use a paid AI call.</p>
    </div>
    {active && <section className="space-y-3 border-t border-slate-200 pt-4" aria-label="Week review">
      <label className="block text-sm font-medium">Week to review
        <select className="ml-2 max-w-full rounded border p-2" value={reviewWeek} onChange={event => { setWeek(event.target.value); onWeekChange?.(event.target.value); }}>
          {[...new Set([reviewWeek, ...(state?.reviewWeeks ?? [])])].filter(Boolean).sort().map(value => <option key={value} value={value}>{value}{value === state?.currentMonday ? " (in progress)" : value < (state?.currentMonday ?? "") ? " (completed week)" : " (upcoming)"}</option>)}
        </select>
      </label>
      <button className={complete ? "settings-primary" : "calendar-nav"} disabled={busy || pending || !state?.reviewWeeks.includes(reviewWeek)} onClick={() => {
        if (window.confirm(`${reviewWeekLabel(reviewWeek, state!.currentMonday)}? This requests an AI coaching review and uses paid API usage.`)) void submit("REVIEW");
      }}>{state ? reviewWeekLabel(reviewWeek, state.currentMonday) : "Review Week"}</button>
      <p className="text-xs text-slate-500">Reviews use paid AI usage. An in-progress review considers only feedback available so far.</p>
      {!state?.reviewWeeks.includes(reviewWeek) && <p className="text-xs text-slate-500">Choose a saved current or previous week within this strategy to review it.</p>}
    </section>}
    {message && <p role="status" className="text-sm text-blue-800">{message}</p>}
    {pending && <p role="status">{state?.review?.status === "RUNNING" ? "Reviewing your week…" : "Review queued. Your result will appear here."}</p>}
    {state?.review && ["FAILED", "CANCELLED"].includes(state.review.status) && <p role="alert" className="text-red-700">{state.review.error}</p>}
    {error && <p role="alert" className="text-red-700">{error} <button className="underline" onClick={() => setReload(value => value + 1)}>Reload</button></p>}
  </section>;
}
