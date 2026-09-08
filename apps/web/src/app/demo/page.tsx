import Link from "next/link";
import { validateStoredPlan, DevelopmentBlockSchema, type TrainingCalendarData, type TrainingBlockState } from "@pkg/shared";
import TrainingCalendar from "../training-calendar";
import { BlockSummary } from "../training-block-panel";
import sample from "./sample.json";

export default function Demo() {
  const calendar: TrainingCalendarData = { ...sample.calendar, plans: sample.calendar.plans.map(plan => ({ ...plan, content: validateStoredPlan(plan.content) })) };
  const state: TrainingBlockState = { ...sample.block, block: DevelopmentBlockSchema.parse(sample.block.block) };
  return <main className="mx-auto max-w-[1680px] space-y-6 p-6">
    <header className="space-y-3"><p className="text-sm font-semibold text-blue-700">INTERACTIVE DEMO · SYNTHETIC DATA</p>
      <h1 className="text-3xl font-semibold">A week of training, with a longer-term strategy</h1>
      <p className="max-w-3xl text-slate-600">Explore the calendar and click a workout to inspect intervals and power targets. This read-only example uses hand-authored sample data, a 250 W cycling baseline, and an illustrative review. It makes no API calls and displays no private athlete records.</p>
      <Link href="/" className="inline-block rounded bg-slate-900 px-4 py-2 text-white">Open your planner / Connect Strava</Link>
    </header>
    <section className="grid gap-4 sm:grid-cols-3" aria-label="Sample weekly goals">{[["Run",120],["Bike",240],["Swim",60]].map(([sport, minutes]) => <div key={sport} className="rounded-lg border bg-white p-4"><p className="text-sm text-slate-500">{sport} goal</p><p className="text-2xl font-semibold">{minutes} min / week</p></div>)}</section>
    <TrainingCalendar initialMonth="2026-09" refreshKey="demo" demoData={calendar} />
    <section className="space-y-4 rounded-xl border bg-white p-5"><h2 className="text-xl font-semibold">Illustrative block review</h2><BlockSummary state={state} /></section>
  </main>;
}
