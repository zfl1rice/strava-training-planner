import { z } from "zod";

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

export function parseStravaScopes(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))].sort();
}
