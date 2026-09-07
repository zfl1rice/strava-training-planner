import { PlanProviderError } from "@pkg/shared";

export const DEFAULT_PLANNER_MODEL = "gpt-5.6-luna";
export const DEFAULT_PLANNER_TIMEOUT_MS = 75000;
export const DEFAULT_PLANNER_MAX_OUTPUT_TOKENS = 16000;

function integerSetting(value: string | undefined, fallback: number, name: string, minimum: number, maximum: number) {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new PlanProviderError("CONFIGURATION", `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

export function readPlannerConfig(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.PLANNER_PROVIDER ?? "deterministic";
  if (provider === "deterministic") return { provider } as const;
  if (provider !== "openai") throw new PlanProviderError("CONFIGURATION", "PLANNER_PROVIDER must be deterministic or openai.");
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new PlanProviderError("CONFIGURATION", "Set OPENAI_API_KEY in the worker environment before selecting the OpenAI planner.");
  return { provider, apiKey, model: env.OPENAI_PLANNER_MODEL?.trim() || DEFAULT_PLANNER_MODEL,
    timeoutMs: integerSetting(env.OPENAI_PLANNER_TIMEOUT_MS, DEFAULT_PLANNER_TIMEOUT_MS, "OPENAI_PLANNER_TIMEOUT_MS", 1000, 90000),
    maxOutputTokens: integerSetting(env.OPENAI_PLANNER_MAX_OUTPUT_TOKENS, DEFAULT_PLANNER_MAX_OUTPUT_TOKENS, "OPENAI_PLANNER_MAX_OUTPUT_TOKENS", 1000, 32000),
  } as const;
}
export type OpenAIPlannerConfig = Extract<ReturnType<typeof readPlannerConfig>, { provider: "openai" }>;
