import { z } from "zod";
import type { TrainingSummary } from "./training.js";

export const StravaTokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().int().positive().max(8640000000000),
});

export const StravaAuthorizationSchema = StravaTokensSchema.extend({
  athlete: z.object({
    id: z.number().int().positive().safe(),
    firstname: z.string().nullish(),
    lastname: z.string().nullish(),
  }),
  scope: z.string().optional(),
});

export type StravaTokens = z.infer<typeof StravaTokensSchema>;
export type StravaAuthorization = z.infer<typeof StravaAuthorizationSchema>;

export const StravaActivitySchema = z.object({
  id: z.number().int().positive().safe(),
  athlete: z.object({ id: z.number().int().positive().safe() }),
  name: z.string(),
  sport_type: z.string().optional(),
  type: z.string(),
  start_date: z.string().datetime({ offset: true }),
  moving_time: z.number().int().nonnegative().max(2147483647),
  distance: z.number().finite().nonnegative().max(2147483647),
  total_elevation_gain: z.number().finite().nonnegative().max(2147483647).optional(),
});
export const StravaActivitiesSchema = z.array(StravaActivitySchema);
export type StravaActivity = z.infer<typeof StravaActivitySchema>;

export type SyncDashboard = {
  trainingSummary: TrainingSummary;
  lastSuccessfulSyncAt: string | null;
  latestSync: {
    id: number;
    status: string;
    activityCount: number;
    error: string | null;
    createdAt: string;
    finishedAt: string | null;
  } | null;
  activities: {
    id: number;
    name: string | null;
    type: string;
    startedAt: string;
    durationSeconds: number;
    distanceMeters: number | null;
    stravaActivityId: string | null;
  }[];
};

export function parseStravaScopes(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))].sort();
}
