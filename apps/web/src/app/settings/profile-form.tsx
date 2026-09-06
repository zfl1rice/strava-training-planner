"use client";

import { useState } from "react";
import type { PlanningSettings } from "@pkg/shared";
import type { SaveSettings } from "./settings-editor";

export default function ProfileForm({ settings, saving, save }: { settings: PlanningSettings; saving: boolean; save: SaveSettings }) {
  const [timeZone, setTimeZone] = useState(settings.timeZone);
  const [ftp, setFtp] = useState(settings.baselines.cyclingFtp?.toString() ?? "");
  const [maxHr, setMaxHr] = useState(settings.baselines.runningMaxHr?.toString() ?? "");
  const [swimPace, setSwimPace] = useState(settings.baselines.swimThresholdPace?.toString() ?? "");
  const [swimUnit, setSwimUnit] = useState(settings.baselines.swimPaceUnit);
  const nullableNumber = (value: string) => value === "" ? null : Number(value);
  return <form className="settings-card space-y-5" onSubmit={event => {
    event.preventDefault();
    void save({ section: "PROFILE", expectedUpdatedAt: settings.profileUpdatedAt, timeZone,
      baselines: { cyclingFtp: nullableNumber(ftp), runningMaxHr: nullableNumber(maxHr), swimThresholdPace: nullableNumber(swimPace), swimPaceUnit: swimUnit } });
  }}>
    <fieldset disabled={saving} className="space-y-5">
      <legend className="mb-3 text-lg font-semibold">Timezone &amp; fitness baselines</legend>
      <div className="space-y-2">
        <label className="settings-label">Timezone<input required value={timeZone} onChange={event => setTimeZone(event.target.value)} placeholder="America/Chicago" list="timezones" /></label>
        <datalist id="timezones">{["UTC", "America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Australia/Sydney", "Asia/Tokyo"].map(zone => <option key={zone} value={zone} />)}</datalist>
        <button type="button" className="text-sm text-blue-700 underline" onClick={() => setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use device timezone</button>
        <p className="text-xs text-slate-500">Used for availability dates and future planning summaries. The current calendar remains in UTC.</p>
      </div>
      <p className="text-sm text-slate-600">Manual values take precedence over estimates. Leave a value blank to remove your override; a saved estimate may then be used. Custom zones are preserved.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="settings-label">Cycling FTP (watts)<input type="number" min="1" step="any" value={ftp} onChange={event => setFtp(event.target.value)} placeholder="Not set" /></label>
        <label className="settings-label">Running max heart rate (bpm)<input type="number" min="1" step="1" value={maxHr} onChange={event => setMaxHr(event.target.value)} placeholder="Not set" /></label>
        <label className="settings-label">Swim threshold pace (seconds)<input type="number" min="1" step="any" value={swimPace} onChange={event => setSwimPace(event.target.value)} placeholder="Not set" /></label>
        <label className="settings-label">Swim pace unit<select value={swimUnit} disabled={settings.swimUnitLocked} onChange={event => {
          const next = event.target.value as typeof swimUnit;
          if (swimPace !== "") setSwimPace((Number(swimPace) * (next === "SECONDS_PER_100YD" ? 0.9144 : 1 / 0.9144)).toFixed(2));
          setSwimUnit(next);
        }}><option value="SECONDS_PER_100M">per 100 meters</option><option value="SECONDS_PER_100YD">per 100 yards</option></select></label>
      </div>
      {settings.swimUnitLocked && <p className="text-xs text-slate-500">Your saved swim estimate or custom zones use this pace unit, so it is fixed here.</p>}
      <button className="settings-primary" type="submit">{saving ? "Saving…" : "Save profile"}</button>
    </fieldset>
  </form>;
}
