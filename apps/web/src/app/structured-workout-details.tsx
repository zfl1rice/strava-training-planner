import { targetDescription, type StructuredWorkout } from "@pkg/shared";
import WorkoutChart from "./workout-chart";

const duration = (seconds: number) => seconds % 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds / 60} min`;
export default function StructuredWorkoutDetails({ workout }: { workout: StructuredWorkout }) {
  return <div className="space-y-4">
    <WorkoutChart workout={workout} />
    <p className="text-sm leading-6 text-slate-600">{workout.explanation}</p>
    <ol className="space-y-3">{workout.blocks.map((block, index) => <li key={index} className="rounded-lg bg-slate-50 p-4">
      {block.repeat > 1 && <h3 className="mb-3 font-semibold">Repeat {block.repeat} times</h3>}
      <ol className="space-y-3">{block.segments.map((segment, segmentIndex) => <li key={segmentIndex}>
        <h4 className="font-medium">{segment.label} <span className="font-normal text-slate-500">· {duration(segment.seconds)}</span></h4>
        <p className="mt-1 text-sm">{segment.instructions}</p>
        <p className="mt-1 text-sm font-medium text-blue-800">Target: {targetDescription(segment)}</p>
      </li>)}</ol>
    </li>)}</ol>
    <p className="text-xs text-slate-500">Targets use the baseline captured when the plan was generated. Regenerate eligible workouts to apply changed settings.</p>
  </div>;
}
