"use client";

import { useState } from "react";
import { DEFAULT_TRAINING_FOCUS, PlanSportSchema, normalizeTrainingFocus, type TrainingFocus } from "@pkg/shared";
import { readableLabel } from "./training-block-labels";

export default function TrainingFocusEditor({ saved, busy, onSave }: {
  saved?: TrainingFocus; busy: boolean; onSave: (focus: TrainingFocus) => Promise<boolean>;
}) {
  const [weights, setWeights] = useState(saved ?? DEFAULT_TRAINING_FOCUS);
  let normalized: TrainingFocus | null = null;
  try { normalized = normalizeTrainingFocus(weights); } catch { /* Show the invalid total beside the controls. */ }
  const changed = !saved || PlanSportSchema.options.some(sport => normalized?.[sport] !== saved[sport]);
  async function save() {
    if (!normalized) return;
    if (await onSave(normalized)) setWeights(normalized);
  }
  return <section className="space-y-3" aria-labelledby="training-focus-heading">
    <h3 id="training-focus-heading" className="font-semibold">Training focus</h3>
    <p className="text-sm text-slate-600">Choose relative emphasis. Weekly minute goals and availability stay separate; races, recovery and your constraints can take priority. A 0% preference does not disable a sport.</p>
    {!saved && <p className="text-xs text-slate-500">No preference saved yet. Start with a balanced mix, then adjust.</p>}
    <div className="grid gap-4 sm:grid-cols-3">{PlanSportSchema.options.map(sport => <label key={sport} className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm">
      <span className="flex justify-between font-medium"><span>{readableLabel(sport)}</span><output>{normalized?.[sport] ?? 0}%</output></span>
      <input className="w-full accent-blue-600" aria-label={`${readableLabel(sport)} emphasis`} type="range" min="0" max="100" step="1" value={weights[sport]} disabled={busy}
        onChange={event => setWeights(current => ({ ...current, [sport]: Number(event.target.value) }))} />
    </label>)}</div>
    <p className="text-xs text-slate-500">{normalized ? "Total 100%. Sliders are relative weights; displayed percentages are normalized and saved." : "Give at least one sport some emphasis."}</p>
    <button className="settings-primary" disabled={busy || !normalized || !changed} onClick={() => void save()}>Save focus</button>
  </section>;
}
