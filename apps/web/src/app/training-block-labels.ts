import type { DevelopmentFocus } from "@pkg/shared";

export function readableLabel(value: string) {
  const words = value.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
export const focusRoleLabels: Record<DevelopmentFocus["role"], string> = {
  PRIMARY: "Primary development focus", SECONDARY: "Supporting focus", MAINTENANCE: "Maintenance",
};
export const progressionLabels: Record<DevelopmentFocus["progressionStrategy"], string> = {
  LONG_SESSION: "Increase long-session duration", TIME_AT_INTENSITY: "Increase time at target intensity",
  MAINTAIN: "Maintain current exposure", VOLUME: "Increase training volume", REPETITIONS: "Increase interval repetitions",
  INTERVAL_DURATION: "Increase interval duration", FREQUENCY: "Increase session frequency",
};
export function reviewWeekLabel(week: string, currentMonday: string) {
  return week < currentMonday ? "Review Week" : "Review progress so far";
}
