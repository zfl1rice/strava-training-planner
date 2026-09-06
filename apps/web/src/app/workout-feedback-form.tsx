"use client";
import { useState } from "react";
import type { AthleteWorkoutStates } from "@pkg/shared";

export default function WorkoutFeedbackForm({ planId, updatedAt, workoutId, state, onSaved }: {
  planId: number; updatedAt: string; workoutId: string; state?: AthleteWorkoutStates[number]; onSaved: () => void;
}) {
  const [comment, setComment] = useState(state?.feedback?.comment ?? "");
  const [rpe, setRpe] = useState(state?.feedback?.rpe?.toString() ?? "");
  const [completion, setCompletion] = useState(state?.completion ?? "PLANNED");
  const [locked, setLocked] = useState(state?.locked ?? false);
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  return <form className="settings-editor mt-5 space-y-3 border-t pt-4" onSubmit={async event => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const response = await fetch("/api/workout-feedback", { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, workoutId, expectedUpdatedAt: updatedAt, comment, rpe: rpe === "" ? null : Number(rpe), completion, locked }), signal: AbortSignal.timeout(15000) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save feedback."); }
    finally { setSaving(false); }
  }}><fieldset disabled={saving} className="space-y-3">
    <legend className="font-semibold">Workout feedback</legend>
    <label className="settings-label">Completion<select value={completion} onChange={e => setCompletion(e.target.value as typeof completion)}>{["PLANNED", "COMPLETED", "MODIFIED", "STOPPED"].map(value => <option key={value}>{value}</option>)}</select></label>
    <label className="settings-label">Perceived effort (1–10, optional)<input type="number" min={1} max={10} value={rpe} onChange={e => setRpe(e.target.value)} /></label>
    <label className="settings-label">How did it feel? Were you able to finish?<textarea maxLength={4000} value={comment} onChange={e => setComment(e.target.value)} /></label>
    <label className="flex gap-2"><input type="checkbox" checked={locked} onChange={e => setLocked(e.target.checked)} />Keep this workout when regenerating</label>
    <p className="text-xs">Feedback is saved for future generation. Use Adjustments for an explicit volume or intensity change.</p>
    <button type="submit" className="settings-primary">Save feedback</button>{error && <p role="alert">{error}</p>}
  </fieldset></form>;
}
