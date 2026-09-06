"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PlanSportSchema, WeeklyGoalsSchema, type WeeklyGoals, type PlannerState, type SavedWeeklyPlan } from "@pkg/shared";

const formatPlanDate = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const formatMinutes = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const goalsToFormFields = (goals: WeeklyGoals) => ({ RUN: goals.RUN?.toString() ?? "", BIKE: goals.BIKE?.toString() ?? "", SWIM: goals.SWIM?.toString() ?? "" });

function PlanDetails({ saved }: { saved: SavedWeeklyPlan }) {
  const plan = saved.content;
  const hasSparseHistory = Object.values(plan.budgets).some(budget => budget.activeWeeks < 3);
  const targetTotalMinutes = Object.values(plan.budgets).reduce((sum, budget) => sum + budget.targetMinutes, 0);
  return (
    <div className="mt-4 space-y-4">
      <p><strong>{plan.totalMinutes} planned minutes</strong> · {plan.mode === "STARTER" ? "Optional starter schedule" : plan.mode === "CUSTOM" ? "Custom weekly goals" : "Based on recent training"}</p>
      {plan.mode === "CUSTOM" && <p className="text-sm">Uses your saved custom goals. Blank sports use recent training history.</p>}
      {plan.mode !== "STARTER" && hasSparseHistory && <p className="text-sm">Some sports have limited recorded history. Review the assumptions below.</p>}
      {targetTotalMinutes !== plan.totalMinutes && <p role="status" className="text-sm">Goal total: {targetTotalMinutes} min. Planned: {formatMinutes(plan.totalMinutes)} min. Review the explanation below for differences; your saved goals are unchanged.</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="mb-2 text-left">Minutes by sport</caption>
          <thead>
            <tr className="border-b">
              <th className="p-2" scope="col">Sport</th>
              <th className="p-2" scope="col">Recent weekly average</th>
              <th className="p-2" scope="col">Goal</th>
              <th className="p-2" scope="col">Planned</th>
            </tr>
          </thead>
          <tbody>{PlanSportSchema.options.map(sport => (
            <tr key={sport} className="border-b">
              <th scope="row" className="p-2 font-normal">{sport}</th>
              <td className="p-2">{formatMinutes(plan.budgets[sport].averageMinutes)}</td>
              <td className="p-2">{plan.budgets[sport].targetMinutes} ({plan.goals[sport] === null ? "automatic" : "custom"})</td>
              <td className="p-2">{plan.budgets[sport].plannedMinutes}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <details className="rounded border p-3" open={plan.totalMinutes === 0 || plan.mode === "STARTER" || hasSparseHistory}>
        <summary className="cursor-pointer font-medium">How this plan was chosen</summary>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">{plan.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul>
        <p className="mt-3 text-xs">History snapshot: {formatPlanDate(plan.sourceGeneratedAt)}. Regenerate after syncing if you want to use updated history.</p>
      </details>
    </div>
  );
}

export default function WeeklyPlanner({ initialData, syncActive, onPlanSaved }: {
  initialData: PlannerState; syncActive: boolean; onPlanSaved: () => void;
}) {
  const [plannerState, setPlannerState] = useState(initialData);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [goalFields, setGoalFields] = useState(() => goalsToFormFields(initialData.goals));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = plannerState.generation;
  const pending = generation?.status === "PENDING" || generation?.status === "RUNNING";
  const busy = generating || pending;
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/planner", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        const state = await response.json();
        if (!response.ok) throw new Error(state.error ?? "Could not check generation status.");
        if (controller.signal.aborted) return;
        setPlannerState(state);
        if (state.generation?.status === "SUCCESS") {
          const latest = state.nextPlan?.updatedAt > (state.currentPlan?.updatedAt ?? "") ? state.nextPlan : state.currentPlan;
          setMessage(latest?.content.totalMinutes === 0 ? "Generation finished, but no workouts could be scheduled. Review availability and the explanation below." : "Weekly plan saved.");
          onPlanSaved(); return;
        }
        if (["FAILED", "CANCELLED"].includes(state.generation?.status)) { setError(state.generation.error ?? "Generation did not complete."); return; }
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not check generation status."); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pending, generation?.id, onPlanSaved]);
  const savedGoalFields = goalsToFormFields(plannerState.goals);
  const hasUnsavedGoals = PlanSportSchema.options.some(sport => goalFields[sport] !== savedGoalFields[sport]);
  const customTotal = PlanSportSchema.options.reduce((sum, sport) => sum + (Number(goalFields[sport]) || 0), 0);
  const savedNextPlan = plannerState.nextPlan;
  const savedPlanUsesDifferentGoals = savedNextPlan && PlanSportSchema.options.some(sport => plannerState.goals[sport] !== savedNextPlan.content.goals[sport]);

  async function saveGoals() {
    setError(null);
    setMessage(null);
    const goalValues = Object.fromEntries(PlanSportSchema.options.map(sport => [
      sport, goalFields[sport] === "" ? null : Number(goalFields[sport]),
    ]));
    const parsed = WeeklyGoalsSchema.safeParse(goalValues);
    if (!parsed.success) {
      setError("Use minutes in multiples of 5 from 0 to 10080, or leave a field blank for automatic targets.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/planner", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save your goals.");
      setPlannerState(previous => ({ ...previous, goals: result.goals }));
      setGoalFields(goalsToFormFields(result.goals));
      setMessage("Goals saved. Generate or regenerate next week's plan to apply them.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save your goals.");
    } finally {
      setSaving(false);
    }
  }

  async function generatePlan(scope: "NEXT_WEEK" | "REMAINING_WEEK" = "NEXT_WEEK") {
    setGenerating(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/planner", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope }), signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not generate your plan.");
      setPlannerState(result);
      setMessage("Generation queued. Your calendar updates when the worker finishes.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not generate your plan.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border p-6" aria-labelledby="planner-heading">
      <h2 id="planner-heading" className="text-xl font-semibold">Weekly plan</h2>
      <p className="text-sm">Generate an easy swim, bike, and run schedule for the week starting {formatPlanDate(plannerState.nextWeekStart)} using your profile timezone and availability.</p>
      <p className="text-sm">Every day is available by default. <Link href="/settings/availability" className="underline">Adjust availability</Link> to exclude days, limit time, or change pool access. The planner still reserves a rest day.</p>
      <form onSubmit={event => { event.preventDefault(); void saveGoals(); }} className="space-y-3 rounded border p-4">
        <fieldset disabled={saving || busy} className="space-y-3">
          <legend className="font-medium">Weekly goal minutes</legend>
          <p id="goal-help" className="text-sm">Leave blank for automatic targets, or enter 0 to skip a sport. Use 5-minute increments. With custom goals, blank sports without recorded history get no sessions.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {PlanSportSchema.options.map(sport => <label key={sport} className="space-y-1 text-sm">
              <span className="block">{sport === "RUN" ? "Run" : sport === "BIKE" ? "Bike" : "Swim"} minutes / week</span>
              <input type="number" min={0} max={10080} step={5} value={goalFields[sport]} placeholder="Automatic" aria-describedby="goal-help"
                onChange={event => { setGoalFields(previous => ({ ...previous, [sport]: event.target.value })); setMessage(null); }} className="w-full rounded border bg-transparent p-2" />
            </label>)}
          </div>
          <p className="text-sm">Custom entries total: {formatMinutes(customTotal)} min{PlanSportSchema.options.some(sport => goalFields[sport] === "") ? "; automatic targets are additional." : "."} Minutes that cannot fit your availability will be shown as unscheduled.</p>
          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={!hasUnsavedGoals} className="rounded border px-3 py-2 disabled:opacity-50">{saving ? "Saving..." : "Save goals"}</button>
            <button type="button" onClick={() => { setGoalFields({ RUN: "", BIKE: "", SWIM: "" }); setMessage(null); }} className="rounded border px-3 py-2">Use automatic targets</button>
          </div>
        </fieldset>
      </form>
      {hasUnsavedGoals && <p className="text-sm">Save your goal changes before generating a plan.</p>}
      {savedPlanUsesDifferentGoals && <p className="text-sm">The saved plan uses different goals. Regenerate to apply your current goals.</p>}
      <button onClick={() => void generatePlan()} disabled={busy || saving || hasUnsavedGoals || syncActive}
        className="rounded bg-orange-600 px-4 py-2 font-medium text-white disabled:opacity-50">
        {busy ? "Generating..." : plannerState.nextPlan ? "Regenerate next week's plan" : "Generate next week's plan"}
      </button>
      <button type="button" className="calendar-nav ml-3" disabled={busy || saving || hasUnsavedGoals || syncActive} onClick={() => void generatePlan("REMAINING_WEEK")}>Regenerate the rest of this week</button>
      <p className="text-xs">Regeneration replaces eligible workouts from today onward. Past, completed, stopped, modified, and locked workouts are preserved.</p>
      {plannerState.nextPlan && <p className="text-xs">Regenerating uses saved goals, availability, adjustments, and latest stored history.</p>}
      {pending && <p role="status">{generation?.status === "RUNNING" ? "Generating your plan?" : "Waiting for the worker?"} You can leave this page; generation continues in the background.</p>}
      {syncActive && <p className="text-sm">Wait for activity sync to finish before generating a plan.</p>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {!plannerState.currentPlan && !plannerState.nextPlan && <p>No plan saved yet. Your saved goals and recent completed weeks will set the workout targets.</p>}
      {plannerState.currentPlan && <details className="rounded border p-4" open={plannerState.currentPlan.content.totalMinutes === 0}>
        <summary className="cursor-pointer font-medium">This week&apos;s plan: {formatPlanDate(plannerState.currentPlan.content.weekStart)}</summary>
        <PlanDetails saved={plannerState.currentPlan} />
      </details>}
      {plannerState.nextPlan && <details className="rounded border p-4" open={plannerState.nextPlan.content.totalMinutes === 0}>
        <summary className="cursor-pointer font-medium">Next week&apos;s plan: {formatPlanDate(plannerState.nextPlan.content.weekStart)}</summary>
        <PlanDetails saved={plannerState.nextPlan} />
      </details>}
    </section>
  );
}
