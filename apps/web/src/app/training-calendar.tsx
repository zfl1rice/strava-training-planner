"use client";

import Link from "next/link";
import ClearWeekButton from "./clear-week-button";
import WorkoutFeedbackForm from "./workout-feedback-form";
import StructuredWorkoutDetails from "./structured-workout-details";
import WorkoutChart from "./workout-chart";
import { useEffect, useRef, useState } from "react";
import { CalendarMonthSchema, calendarMonthRange, calendarMonday, type TrainingCalendarData, calendarWorkouts, localDateAt } from "@pkg/shared";

type CalendarEntry =
  | { kind: "completed"; date: string; activity: TrainingCalendarData["activities"][number] }
  | { kind: "planned"; date: string; plan: TrainingCalendarData["plans"][number]; workout: ReturnType<typeof calendarWorkouts>[number] };

const DAY_MS = 86400000;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const sportNames: Record<string, string> = { RUN: "Run", BIKE: "Bike", SWIM: "Swim", OTHER: "Activity" };
const formatDate = (date: string) => new Date(date).toLocaleDateString("en-US", {
  weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
});
const entryMinutes = (entry: CalendarEntry) => entry.kind === "planned"
  ? entry.workout.durationMinutes : entry.activity.durationSeconds / 60;
const entryTitle = (entry: CalendarEntry) => entry.kind === "planned"
  ? entry.workout.title : entry.activity.name || sportNames[entry.activity.type] || entry.activity.type;
const entryStatus = (entry: CalendarEntry) => entry.kind === "completed" ? "Recorded activity"
  : entry.plan.workoutStates?.find(state => (state.workoutId ?? `${state.date}:${state.templateId}`) === entry.workout.id)?.completion ?? "PLANNED";
const formatTotal = (minutes: number) => {
  const rounded = Math.round(minutes);
  return rounded >= 60 ? `${Math.floor(rounded / 60)}h ${rounded % 60}m` : `${rounded}m`;
};

function WorkoutDetails({ entry, onClose, onSaved, readOnly = false }: { entry: CalendarEntry | null; onClose: () => void; onSaved: () => void; readOnly?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (entry && !dialog.current?.open) dialog.current?.showModal();
    if (!entry && dialog.current?.open) dialog.current.close();
  }, [entry]);

  return (
    <dialog ref={dialog} onCancel={onClose} onClose={onClose}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
      aria-labelledby="workout-detail-title" className="workout-dialog">
      {entry && <div className="p-6 sm:p-8">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className={`mb-2 text-xs font-semibold uppercase tracking-widest ${entry.kind === "completed" ? "text-emerald-700" : "text-blue-700"}`}>
              {entry.kind === "completed" ? "Recorded activity" : `${entryStatus(entry)} workout`}
            </p>
            <h2 id="workout-detail-title" className="text-2xl font-semibold">{entryTitle(entry)}</h2>
            <p className="mt-2 text-sm text-slate-500">{formatDate(entry.date)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close workout details"
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xl hover:bg-slate-100">×</button>
        </div>
        <p className="mb-5 font-medium">{Math.round(entryMinutes(entry))} min
          {entry.kind === "planned" && ` · ${entry.workout.effort.toLowerCase()} effort${entry.workout.optional ? " · optional" : ""}`}
        </p>
        {entry.kind === "planned" ? (
          <div>{"blocks" in entry.workout ? <StructuredWorkoutDetails workout={entry.workout} /> : <ol className="space-y-3">
            {entry.workout.steps.map((step, index) => <li key={index} className="rounded-lg bg-slate-50 p-4">
              <h3 className="font-medium">{step.label} <span className="font-normal text-slate-500">· {step.minutes} min</span></h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">{step.instructions}</p>
            </li>)}
          </ol>}{!readOnly && <WorkoutFeedbackForm key={`${entry.plan.id}-${entry.workout.id}-${entry.plan.updatedAt}`} planId={entry.plan.id} updatedAt={entry.plan.updatedAt} workoutId={entry.workout.id}
            state={entry.plan.workoutStates?.find(state => (state.workoutId ?? `${state.date}:${state.templateId}`) === entry.workout.id)} onSaved={onSaved} />}</div>
        ) : <div className="space-y-4 text-sm text-slate-600">
          <p>{sportNames[entry.activity.type] || entry.activity.type} · Recorded moving time</p>
          <p>Distance: {entry.activity.distanceMeters === null ? "Unavailable" : entry.activity.type === "SWIM"
            ? `${entry.activity.distanceMeters.toLocaleString("en-US")} m`
            : `${(entry.activity.distanceMeters / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })} km`}</p>
          {entry.activity.stravaActivityId && <a className="inline-block font-medium text-orange-700 underline underline-offset-4"
            href={`https://www.strava.com/activities/${entry.activity.stravaActivityId}`} target="_blank" rel="noopener noreferrer">
            View activity on Strava ↗
          </a>}
        </div>}
      </div>}
    </dialog>
  );
}

export default function TrainingCalendar({ initialMonth, refreshKey, demoData, selectedWeek, onWeekChange, onPlanChanged }: {
  initialMonth: string; refreshKey: string; demoData?: TrainingCalendarData;
  selectedWeek?: string; onWeekChange?: (week: string) => void; onPlanChanged?: () => void;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: TrainingCalendarData; error?: string } | null>(null);
  const [selected, setSelected] = useState<CalendarEntry | null>(null);
  const [weekSelection, setWeekSelection] = useState("");
  const requestKey = `${month}:${refreshKey}:${retry}`;
  const loading = !demoData && result?.key !== requestKey;
  const data = demoData ?? (!loading ? result?.data : undefined);
  const error = !demoData && !loading ? result?.error : undefined;

  useEffect(() => {
    if (demoData) return;
    const controller = new AbortController();
    async function loadCalendar() {
      try {
        const response = await fetch(`/api/calendar?month=${month}`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load your calendar.");
        if (!controller.signal.aborted) setResult({ key: requestKey, data: body });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key: requestKey, error: error instanceof Error ? error.message : "Could not load your calendar." });
      }
    }
    void loadCalendar();
    return () => controller.abort();
  }, [month, requestKey, demoData]);

  const { start, end } = calendarMonthRange(month);
  const weeks = Array.from({ length: (end.getTime() - start.getTime()) / DAY_MS / 7 }, (_, index) =>
    Array.from({ length: 7 }, (_, day) => new Date(start.getTime() + (index * 7 + day) * DAY_MS).toISOString().slice(0, 10)));
  const entries: CalendarEntry[] = [
    ...(data?.activities.map(activity => ({ kind: "completed" as const, date: localDateAt(new Date(activity.startedAt), data?.timeZone ?? "UTC"), activity })) ?? []),
    ...(data?.plans.flatMap(plan => calendarWorkouts(plan.content).map(workout => ({ kind: "planned" as const, date: workout.date, workout, plan }))) ?? []),
  ];
  const restDates = new Set(data?.plans.flatMap(plan => plan.content.days.filter(day => day.kind === "REST").map(day => day.date)));
  const today = demoData ? demoData.plans[0]?.content.weekStart.slice(0, 10) ?? `${demoData.month}-01` : localDateAt(new Date(), data?.timeZone ?? "UTC");
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const activeWeek = selectedWeek || weekSelection || calendarMonday(today);
  const weekPlan = data?.plans.find(plan => plan.content.weekStart.slice(0, 10) === activeWeek);
  function changeMonth(offset: number) {
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + offset);
    const nextMonth = date.toISOString().slice(0, 7);
    if (CalendarMonthSchema.safeParse(nextMonth).success) setMonth(nextMonth);
  }

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" aria-labelledby="calendar-heading">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 p-5">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-slate-400">Your training</p>
          <h2 id="calendar-heading" className="text-2xl font-semibold tracking-tight">{monthLabel}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="calendar-nav" aria-label="Previous month" disabled={month === "1900-01"} onClick={() => changeMonth(-1)}>←</button>
          <button type="button" className="calendar-nav" onClick={() => setMonth(today.slice(0, 7))}>Today</button>
          <button type="button" className="calendar-nav" aria-label="Next month" disabled={month === "2199-12"} onClick={() => changeMonth(1)}>→</button>
          <input aria-label="Calendar month" type="month" min="1900-01" max="2199-12" value={month}
            onChange={event => { if (CalendarMonthSchema.safeParse(event.target.value).success) setMonth(event.target.value); }}
            className="calendar-nav max-w-44" />
          {!demoData && <>
            <label className="text-sm">Selected week <select aria-label="Selected week" className="calendar-nav" value={activeWeek} onChange={event => {
              setWeekSelection(event.target.value); onWeekChange?.(event.target.value);
            }}>{[...new Set([activeWeek, ...weeks.map(week => week[0])])].sort().map(week => <option key={week} value={week}>Week of {week}</option>)}</select></label>
            <ClearWeekButton plan={weekPlan} today={today} onCleared={() => { setSelected(null); setRetry(value => value + 1); onPlanChanged?.(); }} />
          </>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3 text-xs text-slate-500">
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />Completed</span>
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-blue-500" />Planned</span>
        <span>Monday–Sunday · {data?.timeZone ?? "UTC"} · Click a workout for details</span>
        <span role="status" className="ml-auto">{loading ? "Loading calendar…" : data && entries.length === 0 ? "No saved activities or workouts in this view." : ""}</span>
      </div>
      {error && <p role="alert" className="border-t border-red-100 bg-red-50 px-5 py-3 text-sm text-red-800">
        {error} <button type="button" className="ml-2 underline" onClick={() => setRetry(value => value + 1)}>Retry</button>
      </p>}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Training calendar, scroll horizontally on small screens" aria-busy={loading}>
        <table className="training-calendar w-full min-w-[980px] table-fixed border-collapse text-left">
          <caption className="sr-only">{monthLabel} training calendar. Completed activities and planned workouts are shown separately.</caption>
          <thead><tr>
            <th className="w-36" scope="col">Week totals</th>
            {WEEKDAYS.map(day => <th key={day} scope="col">{day}</th>)}
          </tr></thead>
          <tbody>{weeks.map(week => {
            const weekEntries = entries.filter(entry => entry.date >= week[0] && entry.date <= week[6]);
            const completedMinutes = weekEntries.filter(entry => entry.kind === "completed").reduce((sum, entry) => sum + entryMinutes(entry), 0);
            const plannedMinutes = weekEntries.filter(entry => entry.kind === "planned").reduce((sum, entry) => sum + entryMinutes(entry), 0);
            const savedWeek = data?.plans.find(plan => plan.content.weekStart.slice(0, 10) === week[0]);
            const goalMinutes = savedWeek ? Object.values(savedWeek.content.budgets).reduce((sum, budget) => sum + budget.targetMinutes, 0) : 0;
            return <tr key={week[0]}>
              <th scope="row" className="calendar-week">
                <p className="mb-4 font-medium text-slate-700">Week of {new Date(week[0]).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</p>
                <dl className="space-y-2 text-xs font-normal">
                  <div className="flex justify-between gap-2"><dt>Completed</dt><dd className="font-semibold text-emerald-700">{loading || error ? "—" : formatTotal(completedMinutes)}</dd></div>
                  <div className="flex justify-between gap-2"><dt>Planned</dt><dd className="font-semibold text-blue-700">{loading || error ? "—" : formatTotal(plannedMinutes)}</dd></div>
                </dl>
                {savedWeek && plannedMinutes < goalMinutes && <p className="mt-3 text-xs font-normal text-slate-500">{formatTotal(goalMinutes - plannedMinutes)} below goal. <Link href="/settings/goals" className="underline">Adjust goals</Link></p>}
              </th>
              {week.map(date => <td key={date} className={`${date.startsWith(month) ? "" : "calendar-outside"} ${date === today ? "calendar-today" : ""}`}>
                <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
                  <time dateTime={date} aria-current={date === today ? "date" : undefined} className={date === today ? "calendar-today-number" : ""}>{Number(date.slice(8))}</time>
                  {date === today && <span className="font-medium text-blue-600">Today</span>}
                </div>
                <div className="space-y-2">
                  {weekEntries.filter(entry => entry.date === date).map(entry => <button type="button"
                    key={entry.kind === "completed" ? `activity-${entry.activity.id}` : `plan-${entry.workout.id}`}
                    className={`calendar-entry calendar-entry-${entryStatus(entry) === "COMPLETED" ? "completed" : entry.kind}`} onClick={() => setSelected(entry)}
                    aria-label={`${entryStatus(entry)}: ${Math.round(entryMinutes(entry))} min ${entryTitle(entry)}, ${formatDate(date)}`}>
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide">{entryStatus(entry)} · {entry.kind === "completed" ? entry.activity.type : entry.workout.sport}</span>
                    {entry.kind === "planned" && "blocks" in entry.workout && <WorkoutChart workout={entry.workout} />}
                    {entry.kind === "planned" && <span className="block text-[10px]">{entry.workout.effort.toLowerCase()} effort</span>}
                    <span className="block text-xs font-medium leading-5">{Math.round(entryMinutes(entry))} min {entryTitle(entry)}</span>
                  </button>)}
                  {restDates.has(date) && <p className="py-1 text-xs text-slate-400">Rest day</p>}
                </div>
              </td>)}
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p className="border-t border-slate-200 px-5 py-3 text-xs text-slate-400">Recorded activities and prescribed workouts are separate entries. Green workouts reflect reported completion; completed totals count recorded activities only. On a small screen, scroll sideways to see the full week.</p>
      <WorkoutDetails readOnly={Boolean(demoData)} entry={selected} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); setRetry(value => value + 1); }} />
    </section>
  );
}
