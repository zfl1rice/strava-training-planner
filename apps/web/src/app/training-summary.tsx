import type { SportTrainingTotals, TrainingSummary } from "@pkg/shared";

const formatMinutes = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const formatWeekDate = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function SportVolume({ totals, swim = false }: { totals: SportTrainingTotals; swim?: boolean }) {
  const allDistancesMissing = totals.activityCount > 0 && totals.missingDistanceCount === totals.activityCount;
  return (
    <>
      <span className="block font-medium">{formatMinutes(totals.durationMinutes)} min</span>
      <span className="block text-xs">
        {allDistancesMissing ? "Distance unavailable" : swim
          ? `${totals.distanceMeters.toLocaleString("en-US")} m`
          : `${(totals.distanceMeters / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })} km`}
        {!allDistancesMissing && totals.missingDistanceCount > 0 && " (partial)"}
      </span>
    </>
  );
}

export default function WeeklyTraining({ summary }: { summary: TrainingSummary }) {
  const currentWeek = summary.weeks[0];
  if (!currentWeek) return null;
  return (
    <section className="space-y-5 rounded-lg border p-6" aria-labelledby="weekly-training-heading">
      <h2 id="weekly-training-heading" className="text-xl font-semibold">Weekly training</h2>
      <p className="text-sm">Monday to Sunday, UTC. This week is in progress. Time is based on recorded moving time.</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div><h3 className="text-sm">Run this week</h3><SportVolume totals={currentWeek.run} /></div>
        <div><h3 className="text-sm">Bike this week</h3><SportVolume totals={currentWeek.bike} /></div>
        <div><h3 className="text-sm">Swim this week</h3><SportVolume totals={currentWeek.swim} swim /></div>
        <div><h3 className="text-sm">Total this week</h3><p className="font-medium">{formatMinutes(currentWeek.totalDurationMinutes)} min</p></div>
      </div>
      <p className="text-sm">Previous {summary.completedWeekCount} complete weeks: <strong>{formatMinutes(summary.completedWeekAverageMinutes)} min/week</strong> on average.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="mb-3 text-left font-medium">Last {summary.weeks.length} calendar weeks</caption>
          <thead><tr className="border-b">
            <th className="p-2" scope="col">Week</th><th className="p-2" scope="col">Run</th><th className="p-2" scope="col">Bike</th>
            <th className="p-2" scope="col">Swim</th><th className="p-2" scope="col">Other</th><th className="p-2" scope="col">Total time</th>
          </tr></thead>
          <tbody>{summary.weeks.map(week => (
            <tr key={week.weekStart} className="border-b">
              <th scope="row" className="whitespace-nowrap p-2 font-normal">
                {formatWeekDate(week.weekStart)} – {formatWeekDate(new Date(new Date(week.weekEnd).getTime() - 1).toISOString())}
                {week.isCurrentWeek && <span className="block text-xs">This week so far</span>}
              </th>
              <td className="whitespace-nowrap p-2"><SportVolume totals={week.run} /></td>
              <td className="whitespace-nowrap p-2"><SportVolume totals={week.bike} /></td>
              <td className="whitespace-nowrap p-2"><SportVolume totals={week.swim} swim /></td>
              <td className="whitespace-nowrap p-2">{formatMinutes(week.other.durationMinutes)} min</td>
              <td className="whitespace-nowrap p-2 font-medium">{formatMinutes(week.totalDurationMinutes)} min</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="text-xs">Totals include other activities. Distances sum known values; missing distances are marked. Weeks without stored activities count as zero. Values reflect activities synced so far.</p>
    </section>
  );
}
