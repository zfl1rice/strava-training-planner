import { deterministicPlanProvider, type PlanProvider } from "@pkg/shared";
import { readPlannerConfig } from "./planner-config.js";
import { createOpenAIPlanProvider } from "./openai-planner.js";

// Lazy initialization keeps missing-key/configuration failures inside job handling.
// A fresh adapter per execution avoids retaining another athlete's conversation.
export function configuredPlanProvider(): PlanProvider {
  let selected: PlanProvider | undefined;
  return (input, attempt) => {
    if (!selected) {
      const config = readPlannerConfig();
      selected = config.provider === "deterministic" ? deterministicPlanProvider : createOpenAIPlanProvider(config);
    }
    return selected(input, attempt);
  };
}
