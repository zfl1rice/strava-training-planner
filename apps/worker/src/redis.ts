import { bullConnectionFromUrl } from "@pkg/shared";

export function bullConnectionFromEnv() {
  return {
    ...bullConnectionFromUrl(process.env.REDIS_URL),
    maxRetriesPerRequest: null,
  };
}