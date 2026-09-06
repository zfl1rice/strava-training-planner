"use client";
import { useState } from "react";
import { PlanSportSchema, type PlanningSettings } from "@pkg/shared";
import type { SaveSettings } from "./settings-editor";

export default function AdjustmentsForm({ settings, saving, save }: { settings: PlanningSettings; saving: boolean; save: SaveSettings }) {
  const [adjustments, setAdjustments] = useState(settings.adjustments);
  const [restrictions, setRestrictions] = useState(settings.restrictions);
  const [start, setStart] = useState(""); const [end, setEnd] = useState("");
  const [sport, setSport] = useState("ALL"); const [volume, setVolume] = useState(100); const [intensity, setIntensity] = useState(100);
  const [comment, setComment] = useState(""); const [kind, setKind] = useState("NO_TRAINING"); const [minutes, setMinutes] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const selectedSport = sport === "ALL" ? null : PlanSportSchema.parse(sport);
  function validDates() { if (!start || !end || end < start) { setError("Choose a start and end date in order."); return false; } setError(null); return true; }
  return <form className="settings-card space-y-5" onSubmit={event => { event.preventDefault(); void save({ section: "ADJUSTMENTS", expectedUpdatedAt: settings.profileUpdatedAt, adjustments, restrictions }); }}>
    <fieldset disabled={saving} className="space-y-4">
      <legend className="text-lg font-semibold">Temporary adjustments and restrictions</legend>
      <p className="text-sm">100% keeps the usual amount; 50% halves it. Weekly goals stay unchanged. Add an entry, save, then generate to apply it. The latest matching adjustment takes precedence; percentages do not stack.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="settings-label">Start date<input type="date" min="1900-01-01" max="2199-12-31" value={start} onChange={e => setStart(e.target.value)} /></label>
        <label className="settings-label">End date (inclusive)<input type="date" min="1900-01-01" max="2199-12-31" value={end} onChange={e => setEnd(e.target.value)} /></label>
        <label className="settings-label">Sport<select value={sport} onChange={e => setSport(e.target.value)}><option value="ALL">All sports</option>{PlanSportSchema.options.map(value => <option key={value}>{value}</option>)}</select></label>
      </div>
      <label className="settings-label">Reason / how you feel<textarea maxLength={2000} value={comment} onChange={e => setComment(e.target.value)} /></label>
      <label className="settings-label">Volume: {volume}%<input type="range" min={0} max={200} step={25} value={volume} onChange={e => setVolume(Number(e.target.value))} /></label>
      <label className="settings-label">Intensity: {intensity}%<input type="range" min={25} max={175} step={25} value={intensity} onChange={e => setIntensity(Number(e.target.value))} /></label>
      <button type="button" className="calendar-nav" onClick={() => { if (validDates()) setAdjustments([...adjustments, { id: crypto.randomUUID(), sport: selectedSport, startDate: start, endDate: end, volumePercent: volume, intensityPercent: intensity, comment }]); }}>Add temporary adjustment</button>
      <p className="text-sm">For an injury or other limitation, set an explicit restriction below. A context-only note is recorded, but the deterministic planner does not interpret free text.</p>
      <label className="settings-label">Restriction<select value={kind} onChange={e => setKind(e.target.value)}><option value="NO_TRAINING">No training</option><option value="MAX_SESSION_MINUTES">Maximum session duration</option><option value="CONTEXT_ONLY">Context only</option></select></label>
      {kind === "MAX_SESSION_MINUTES" && <label className="settings-label">Maximum minutes<input type="number" min={1} max={1440} value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></label>}
      <button type="button" className="calendar-nav" onClick={() => {
        if (validDates()) setRestrictions([...restrictions, { id: crypto.randomUUID(), sport: selectedSport, startDate: start, endDate: end,
          kind: kind as PlanningSettings["restrictions"][number]["kind"], maxSessionMinutes: kind === "MAX_SESSION_MINUTES" ? minutes : null, description: comment || "User restriction" }]);
      }}>Add restriction</button>
      {error && <p role="alert">{error}</p>}
      <ul className="space-y-3">{adjustments.map(item => <li key={item.id}>{item.startDate} – {item.endDate}: {item.sport ?? "All"}, volume {item.volumePercent}%, intensity {item.intensityPercent}%. {item.comment} <button type="button" className="text-red-700 underline" onClick={() => setAdjustments(adjustments.filter(value => value.id !== item.id))}>Remove adjustment</button></li>)}</ul>
      <ul className="space-y-3">{restrictions.map(item => <li key={item.id}>{item.startDate} – {item.endDate ?? "Until removed"}: {item.sport ?? "All"}, {item.kind.replaceAll("_", " ")} {item.maxSessionMinutes ?? ""}. {item.description} <button type="button" className="text-red-700 underline" onClick={() => setRestrictions(restrictions.filter(value => value.id !== item.id))}>Remove restriction</button></li>)}</ul>
      <button className="settings-primary" type="submit">Save adjustments and restrictions</button>
    </fieldset>
  </form>;
}
