import OpenAI from "openai";
import type { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { PlanProviderError, type ProposalAttempt, type ProviderCallMetadata } from "@pkg/shared";
import type { OpenAIPlannerConfig } from "./planner-config.js";

type StructuredRequest = {
  instructions: string;
  input: unknown;
  format: ReturnType<typeof zodTextFormat>;
  schema: z.ZodTypeAny;
};

// Shared Responses transport: one timeout/retry/error/usage policy for weekly
// proposals and opt-in review evaluations. Domain validators stay separate.
function retryDelay(headers?: Headers) {
  const value = headers?.get("retry-after");
  if (!value) return 0;
  const milliseconds = Number.isFinite(Number(value)) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(300000, milliseconds)) : 0;
}

export function createStructuredResponder(config: OpenAIPlannerConfig, client = new OpenAI({
  apiKey: config.apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 0, timeout: config.timeoutMs,
})) {
  return async (request: StructuredRequest, attempt: ProposalAttempt): Promise<unknown> => {
    const started = Date.now();
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), config.timeoutMs);
    const signal = attempt.signal ? AbortSignal.any([attempt.signal, timer.signal]) : timer.signal;
    let metadata: ProviderCallMetadata = { provider: "openai", model: config.model, responseId: null,
      proposalAttempt: attempt.attempt, latencyMs: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, category: "PROVIDER_ERROR" };
    try {
      signal.throwIfAborted();
      const response = await client.responses.create({
        model: config.model, store: false, instructions: request.instructions,
        input: [{ role: "user", content: JSON.stringify(request.input) }],
        text: { format: request.format }, max_output_tokens: config.maxOutputTokens,
      }, { signal, timeout: config.timeoutMs, maxRetries: 0 });
      metadata = { ...metadata, model: response.model, responseId: response.id,
        inputTokens: response.usage?.input_tokens ?? null, cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null, totalTokens: response.usage?.total_tokens ?? null };
      signal.throwIfAborted();
      if (response.output.some(item => item.type === "message" && item.content.some(part => part.type === "refusal"))) {
        throw new PlanProviderError("REFUSAL", "The model declined to produce a plan. Review the request before trying again.");
      }
      if (response.status === "incomplete") throw new PlanProviderError("INCOMPLETE", "The model response was incomplete. Review the output-token budget or request before retrying.");
      if (response.status !== "completed" || response.error) throw new PlanProviderError("PROVIDER_ERROR", "The provider did not complete the plan response.", response.error?.code === "server_error" || response.error?.code === "rate_limit_exceeded");
      const parts = response.output.flatMap(item => item.type === "message" ? item.content.filter(part => part.type === "output_text").map(part => part.text) : []);
      // A malformed successful response enters the existing correction loop as an
      // invalid proposal. Refusals/incomplete responses above are terminal instead.
      try {
        const proposal: unknown = JSON.parse(parts.join(""));
        metadata.category = request.schema.safeParse(proposal).success ? "RESPONSE" : "MALFORMED";
        return proposal;
      } catch { metadata.category = "MALFORMED"; return null; }
    } catch (error) {
      if (attempt.signal?.aborted) { metadata.category = "CANCELLED"; throw attempt.signal.reason; }
      if (timer.signal.aborted || error instanceof OpenAI.APIConnectionTimeoutError) {
        metadata.category = "TIMEOUT"; throw new PlanProviderError("TIMEOUT", "OpenAI planning timed out; retrying within the job attempt limit.", true);
      }
      if (error instanceof PlanProviderError) { metadata.category = error.category; throw error; }
      if (error instanceof OpenAI.APIConnectionError || (error instanceof OpenAI.APIError && [408, 409, 429].includes(error.status ?? 0)) || (error instanceof OpenAI.APIError && (error.status ?? 0) >= 500)) {
        metadata.category = "TRANSIENT"; throw new PlanProviderError("TRANSIENT", "OpenAI is temporarily unavailable; retrying within the job attempt limit.", true, error instanceof OpenAI.APIError ? retryDelay(error.headers) : 0);
      }
      metadata.category = "CONFIGURATION";
      throw new PlanProviderError("CONFIGURATION", "OpenAI rejected the request. Check worker credentials, model access, and Structured Outputs configuration.");
    } finally {
      clearTimeout(timeout);
      metadata.latencyMs = Date.now() - started;
      await attempt.reportCall?.(metadata);
    }
  };
}
