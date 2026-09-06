"use client";

import Link from "next/link";
import { useState } from "react";
import { PlanningSettingsMutationSchema, type PlanningSettings, type PlanningSettingsMutation } from "@pkg/shared";
import ProfileForm from "./profile-form";
import AvailabilityForm from "./availability-form";
import RaceGoalsForm from "./race-goals-form";

export type SaveSettings = (change: PlanningSettingsMutation) => Promise<boolean>;

export default function SettingsEditor({ section, initialSettings }: {
  section: "profile" | "availability" | "goals"; initialSettings: PlanningSettings;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const save: SaveSettings = async change => {
    setError(null); setMessage(null); setConflict(false);
    const parsed = PlanningSettingsMutationSchema.safeParse(change);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue.path.join(" → ")}: ${issue.message}`);
      return false;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/planning-settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data), signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok) { setConflict(response.status === 409); throw new Error(result.error ?? "Could not save settings."); }
      setSettings(result);
      setMessage(change.section === "RACE_DELETE" ? "Race removed." : "Settings saved. Your calendar workouts have not changed.");
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save settings. Please try again.");
      return false;
    } finally { setSaving(false); }
  };

  return <div className="space-y-5 settings-editor">
    <p className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900">
      These settings are saved for future adaptive planning. The current basic planner still uses fixed days and UTC; it does not yet apply your races, fitness, or availability.
    </p>
    {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <p>{error}</p>{conflict && <button type="button" className="mt-2 underline" onClick={() => window.location.reload()}>Discard unsaved edits and reload</button>}
    </div>}
    {section === "profile" && <ProfileForm key={settings.profileUpdatedAt ?? "new"} settings={settings} saving={saving} save={save} />}
    {section === "availability" && <AvailabilityForm key={settings.profileUpdatedAt ?? "new"} settings={settings} saving={saving} save={save} />}
    {section === "goals" && <>
      <RaceGoalsForm settings={settings} saving={saving} save={save} />
      <div className="settings-card space-y-2"><h2 className="text-lg font-semibold">Weekly volume goals</h2>
        <p className="text-sm text-slate-600">Your run, bike, and swim targets are configured under “Plan settings &amp; weekly goals” on the calendar.</p>
        <Link className="text-sm text-blue-700 underline" href="/?goals=open">Edit weekly volume goals</Link>
      </div>
    </>}
  </div>;
}
