import { workoutEffort, type StructuredWorkout } from "@pkg/shared";

export default function WorkoutChart({ workout }: { workout: StructuredWorkout }) {
  const segments = workout.blocks.flatMap(block => Array.from({ length: block.repeat }, () => block.segments).flat());
  return <svg viewBox="0 0 600 90" className="my-2 w-full" role="img" aria-label="Workout intensity across time; colors indicate target intensity">
    {segments.map((segment, index) => {
      const target = (segment.target.lower + segment.target.upper) / 2;
      const level = segment.target.metric === "RPE" ? target / 10 : segment.target.metric === "THRESHOLD_PACE_PERCENT" ? 60 / target : target / (segment.target.metric === "MAX_HR_PERCENT" ? 110 : 160);
      const height = Math.max(8, Math.min(85, level * 85));
      const effort = workoutEffort({ ...workout, blocks: [{ repeat: 1, segments: [segment] }] });
      const width = segment.seconds / (workout.durationMinutes * 60) * 600;
      const x = segments.slice(0, index).reduce((sum, item) => sum + item.seconds, 0) / (workout.durationMinutes * 60) * 600;
      return <rect key={index} x={x} y={90 - height} width={width} height={height}
        fill={effort === "HARD" ? "#f97316" : effort === "MODERATE" ? "#eab308" : level > 0.35 ? "#22c55e" : "#5eead4"} stroke="white" strokeWidth="1"><title>{`${segment.label}: ${segment.seconds}s · ${effort.toLowerCase()} target`}</title></rect>;
    })}
  </svg>;
}
