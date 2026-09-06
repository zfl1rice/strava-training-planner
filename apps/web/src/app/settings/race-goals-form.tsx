"use client";

import { useState } from "react";
import { PlanSportSchema, type EditableRace, type PlanningSettings } from "@pkg/shared";
import type { SaveSettings } from "./settings-editor";

const emptyRace = (): EditableRace => ({ name: "", eventType: "", sports: ["BIKE"], date: "", distanceMeters: null,
  expectedDurationSeconds: null, performanceGoal: null, importance: 50 });

function RaceEditor({ initial, saving, submit, cancel }: { initial: EditableRace; saving: boolean;
  submit: (race: EditableRace) => Promise<void>; cancel?: () => void }) {
  const [race, setRace] = useState(initial);
  const change = (fields: Partial<EditableRace>) => setRace(current => ({ ...current, ...fields }));
  return <form className="settings-card space-y-4" onSubmit={event => { event.preventDefault(); void submit(race); }}>
    <fieldset disabled={saving} className="space-y-4">
      <legend className="mb-3 text-lg font-semibold">{cancel ? "Edit race" : "Add a race"}</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="settings-label">Race name<input required maxLength={200} value={race.name} onChange={event => change({ name: event.target.value })} placeholder="Autumn 70.3" /></label>
        <label className="settings-label">Race date<input required type="date" min="1900-01-01" max="2199-12-31" value={race.date} onChange={event => change({ date: event.target.value })} /></label>
        <label className="settings-label">Event type<input required maxLength={100} value={race.eventType} onChange={event => change({ eventType: event.target.value })} placeholder="70.3 triathlon, 2-minute time trial…" /></label>
        <label className="settings-label">Distance (meters, optional)<input type="number" min="1" step="any" value={race.distanceMeters ?? ""} onChange={event => change({ distanceMeters: event.target.value === "" ? null : Number(event.target.value) })} /></label>
        <label className="settings-label">Expected duration (seconds, optional)<input type="number" min="1" step="any" value={race.expectedDurationSeconds ?? ""} onChange={event => change({ expectedDurationSeconds: event.target.value === "" ? null : Number(event.target.value) })} /></label>
      </div>
      <fieldset className="space-y-2"><legend className="text-sm font-medium">Sports in this event</legend>
        <div className="flex gap-5">{PlanSportSchema.options.map(sport => <label key={sport} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={race.sports.includes(sport)} onChange={event => change({ sports: event.target.checked ? [...race.sports, sport] : race.sports.filter(value => value !== sport) })} />
          {sport === "RUN" ? "Run" : sport === "BIKE" ? "Bike" : "Swim"}
        </label>)}</div>
      </fieldset>
      <label className="settings-label">Performance goal (optional)<textarea rows={2} maxLength={2000} value={race.performanceGoal ?? ""} onChange={event => change({ performanceGoal: event.target.value.trim() ? event.target.value : null })} placeholder="What would a successful race look like?" /></label>
      <div className="space-y-2">
        <label className="settings-label">Importance: {race.importance}<input type="range" min="0" max="100" step="1" value={race.importance} onChange={event => change({ importance: Number(event.target.value) })} /></label>
        <div className="flex justify-between text-xs text-slate-500"><span>0 · Less important</span><span>100 · More important</span></div>
        <label className="settings-label max-w-36">Importance score<input type="number" required min="0" max="100" step="1" value={race.importance} onChange={event => change({ importance: Number(event.target.value) })} /></label>
      </div>
      <div className="flex gap-3"><button type="submit" className="settings-primary">{saving ? "Saving…" : cancel ? "Save race" : "Add race"}</button>
        {cancel && <button type="button" onClick={cancel} className="settings-secondary">Cancel editing</button>}
      </div>
    </fieldset>
  </form>;
}

export default function RaceGoalsForm({ settings, saving, save }: { settings: PlanningSettings; saving: boolean; save: SaveSettings }) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [newRaceKey, setNewRaceKey] = useState(0);
  const editing = settings.races.find(value => value.id === editingId);
  return <div className="space-y-5">
    <section className="settings-card space-y-4" aria-labelledby="race-list-heading">
      <h2 id="race-list-heading" className="text-lg font-semibold">Your races</h2>
      <p className="text-sm text-slate-600">Importance scores are independent and can be equal. They express your priorities, not a percentage of training time.</p>
      {!settings.races.length && <p className="text-sm text-slate-500">No races yet. Add the events you want to prepare for.</p>}
      {settings.races.map(entry => <article key={entry.id} className="space-y-3 border-t border-slate-100 pt-4" aria-label={entry.race.name}>
        <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-medium">{entry.race.name}</h3>
          <p className="text-sm text-slate-500">{entry.race.date} · {entry.race.eventType} · {entry.race.sports.join(" / ")}</p></div>
          <div className="flex gap-3"><button type="button" disabled={saving} className="settings-secondary" onClick={() => { setEditingId(entry.id); setDeletingId(null); }}>Edit</button>
            <button type="button" disabled={saving} className="text-sm text-red-700" onClick={() => setDeletingId(entry.id)}>Remove</button></div>
        </div>
        <div className="space-y-1"><div className="flex justify-between text-xs text-slate-500"><span>Less important</span><span>Importance {entry.race.importance} / 100</span><span>More important</span></div>
          <div className="relative mx-2 h-4" aria-hidden="true"><div className="absolute inset-x-0 top-2 h-px bg-slate-200" /><span className="absolute top-0.5 h-3 w-3 -translate-x-1/2 rounded-full bg-blue-600" style={{ left: `${entry.race.importance}%` }} /></div>
        </div>
        {deletingId === entry.id && <div className="flex flex-wrap items-center gap-3 rounded bg-red-50 p-3 text-sm"><p>Remove this race goal?</p>
          <button type="button" disabled={saving} className="text-red-700 underline" onClick={async () => {
            if (await save({ section: "RACE_DELETE", id: entry.id, expectedUpdatedAt: entry.updatedAt })) { setDeletingId(null); if (editingId === entry.id) setEditingId(null); }
          }}>Confirm removal</button>
          <button type="button" disabled={saving} className="underline" onClick={() => setDeletingId(null)}>Keep race</button>
        </div>}
      </article>)}
    </section>
    {editing ? <RaceEditor key={`${editing.id}:${editing.updatedAt}`} initial={editing.race} saving={saving} cancel={() => setEditingId(null)} submit={async race => {
      if (await save({ section: "RACE_UPDATE", id: editing.id, expectedUpdatedAt: editing.updatedAt, race })) setEditingId(null);
    }} /> : <RaceEditor key={`new-${newRaceKey}`} initial={emptyRace()} saving={saving} submit={async race => {
      if (await save({ section: "RACE_CREATE", race })) setNewRaceKey(value => value + 1);
    }} />}
  </div>;
}
