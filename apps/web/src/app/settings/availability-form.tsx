"use client";

import { useState } from "react";
import { defaultDayAvailability, PlanSportSchema, type PlanningSettings } from "@pkg/shared";
import type { SaveSettings } from "./settings-editor";

type Availability = PlanningSettings["availability"];
type DaySettings = Availability["recurring"][number]["settings"];
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const restDay = (): DaySettings => ({ availableMinutes: 0, maxSessions: 0, allowedSports: [], poolAccess: false });

function DayFields({ value, change }: { value: DaySettings; change: (day: DaySettings) => void }) {
  return <div className="space-y-3">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.availableMinutes < 1440}
      onChange={event => change({ ...value, availableMinutes: event.target.checked ? 120 : 1440, maxSessions: value.maxSessions || 3 })} />Limit daily training time</label>
    <div className="grid grid-cols-2 gap-3">
      {value.availableMinutes < 1440 && <label className="settings-label">Total minutes<input type="number" required min="0" max="1440" step="1" value={value.availableMinutes}
        onChange={event => { const minutes = Number(event.target.value); change({ ...value, availableMinutes: minutes, maxSessions: minutes === 0 ? 0 : value.maxSessions || 3 }); }} /></label>}
      <label className="settings-label">Maximum sessions<input type="number" required min="0" max="24" step="1" value={value.maxSessions}
        onChange={event => { const sessions = Number(event.target.value); change({ ...value, maxSessions: sessions, availableMinutes: sessions === 0 ? 0 : value.availableMinutes || 1440 }); }} /></label>
    </div>
    <div className="flex flex-wrap gap-4 text-sm">
      {PlanSportSchema.options.map(sport => <label key={sport} className="flex items-center gap-2">
        <input type="checkbox" checked={value.allowedSports.includes(sport)} onChange={event => change({ ...value,
          allowedSports: event.target.checked ? [...value.allowedSports, sport] : value.allowedSports.filter(current => current !== sport) })} />
        {sport === "RUN" ? "Run" : sport === "BIKE" ? "Bike" : "Swim"}
      </label>)}
      <label className="flex items-center gap-2"><input type="checkbox" checked={value.poolAccess} onChange={event => change({ ...value, poolAccess: event.target.checked })} />Pool access</label>
    </div>
  </div>;
}

export default function AvailabilityForm({ settings, saving, save }: { settings: PlanningSettings; saving: boolean; save: SaveSettings }) {
  const [availability, setAvailability] = useState(settings.availability);
  const [overrideDate, setOverrideDate] = useState("");
  const [dateError, setDateError] = useState<string | null>(null);
  const changeRecurring = (weekday: number, day: DaySettings) => setAvailability(current => ({ ...current,
    recurring: [...current.recurring.filter(value => value.weekday !== weekday), { weekday, settings: day }].sort((a, b) => a.weekday - b.weekday),
  }));
  const changeOverride = (date: string, update: Partial<Availability["overrides"][number]>) => setAvailability(current => ({ ...current,
    overrides: current.overrides.map(value => value.date === date ? { ...value, ...update } : value),
  }));
  return <form className="space-y-5" onSubmit={event => {
    event.preventDefault();
    void save({ section: "AVAILABILITY", expectedUpdatedAt: settings.profileUpdatedAt, availability });
  }}>
    <fieldset disabled={saving} className="space-y-5">
      <legend className="sr-only">Availability settings</legend>
      <section className="settings-card space-y-4" aria-labelledby="recurring-heading">
        <h2 id="recurring-heading" className="text-lg font-semibold">Typical week</h2>
        <p className="text-sm text-slate-600">Dates use {settings.timeZone}. Every day starts available for all sports with pool access, up to three sessions, and no additional daily time cap. Weekly goals determine training volume. Uncheck unavailable days or customize the limits below; the planner still reserves a rest day.</p>
        <div className="grid gap-4 lg:grid-cols-2">
          {weekdays.map((name, weekday) => {
            const day = availability.recurring.find(value => value.weekday === weekday)?.settings ?? defaultDayAvailability();
            const available = day.maxSessions > 0 && day.availableMinutes > 0;
            return <fieldset key={name} className="rounded-lg border border-slate-200 p-4">
              <legend className="px-1 text-sm font-semibold">{name}</legend>
              <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={available} onChange={event => changeRecurring(weekday, event.target.checked ? defaultDayAvailability() : restDay())} />Available {name}</label>
              {available ? <DayFields value={day} change={value => changeRecurring(weekday, value)} /> : <p className="text-xs text-slate-500">Unavailable / rest day.</p>}
            </fieldset>;
          })}
        </div>
      </section>
      <section className="settings-card space-y-4" aria-labelledby="overrides-heading">
        <h2 id="overrides-heading" className="text-lg font-semibold">Date overrides</h2>
        <p className="text-sm text-slate-600">Replace one date&apos;s usual settings for travel, pool closures, or extra time. Removing an override restores the typical week for that date.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="settings-label">Override date<input type="date" value={overrideDate} min="1900-01-01" max="2199-12-31" onChange={event => { setOverrideDate(event.target.value); setDateError(null); }} /></label>
          <button type="button" className="settings-secondary" onClick={() => {
            if (!overrideDate) { setDateError("Choose a date first."); return; }
            if (availability.overrides.some(value => value.date === overrideDate)) { setDateError("An override already exists for this date. Edit it below."); return; }
            setAvailability(current => ({ ...current, overrides: [...current.overrides, { date: overrideDate, settings: restDay(), note: null }].sort((a, b) => a.date.localeCompare(b.date)) }));
            setOverrideDate(""); setDateError(null);
          }}>Add override</button>
        </div>
        {dateError && <p role="alert" className="text-sm text-red-700">{dateError}</p>}
        {!availability.overrides.length && <p className="text-sm text-slate-500">No date overrides.</p>}
        {availability.overrides.map(override => <fieldset key={override.date} className="space-y-3 rounded-lg border border-slate-200 p-4">
          <legend className="px-1 text-sm font-semibold">{override.date}</legend>
          <DayFields value={override.settings} change={value => changeOverride(override.date, { settings: value })} />
          <label className="settings-label">Reason (optional)<input maxLength={2000} value={override.note ?? ""} onChange={event => changeOverride(override.date, { note: event.target.value.trim() ? event.target.value : null })} placeholder="Travel, pool closed…" /></label>
          <button type="button" className="text-sm text-red-700 underline" onClick={() => setAvailability(current => ({ ...current, overrides: current.overrides.filter(value => value.date !== override.date) }))}>Remove override for {override.date}</button>
        </fieldset>)}
      </section>
      <button type="submit" className="settings-primary">{saving ? "Saving…" : "Save availability"}</button>
    </fieldset>
  </form>;
}
