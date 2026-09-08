import { PlanProviderError, type BlockReviewer } from "@pkg/shared";
import { readPlannerConfig } from "./planner-config.js";
import { createOpenAIBlockReviewer } from "./block-reviewer.js";

export function configuredBlockReviewer(): BlockReviewer {
  let selected: BlockReviewer | undefined;
  return { source: "OPENAI", review: (context, attempt) => {
    if (!selected) {
      const config = readPlannerConfig();
      if (config.provider !== "openai") throw new PlanProviderError("CONFIGURATION", "Block review requires PLANNER_PROVIDER=openai and OPENAI_API_KEY in the worker environment. Restart the worker after configuring it.");
      selected = createOpenAIBlockReviewer(config);
    }
    return selected.review(context, attempt);
  } };
}
