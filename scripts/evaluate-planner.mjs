import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { generatePlanWithCorrections, deterministicPlanProvider } from "@pkg/shared";
import { planningScenarios } from "../tests/fixtures/planning-scenarios.mjs";

// Import this function to compare another provider against the same inputs.
// CLI runs the deterministic fallback only; no provider credentials or network.
export async function evaluatePlanner(provider = deterministicPlanProvider) {
  const results = [];
  for (const scenario of planningScenarios()) {
    try {
      const plan = await generatePlanWithCorrections(scenario.input, provider);
      results.push({ id: scenario.id, description: scenario.description, valid: true, plan });
    } catch (error) {
      results.push({ id: scenario.id, description: scenario.description, valid: false, errors: error.issues ?? [{ message: error.message }] });
    }
  }
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const results = await evaluatePlanner();
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.valid)) process.exitCode = 1;
}
