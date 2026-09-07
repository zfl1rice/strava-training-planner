import { readFile } from "node:fs/promises";
import { config } from "dotenv";
import { z } from "zod";
import { deterministicBlockPlanner, validateBlockProposal, simulatedBlockReviewer } from "@pkg/shared";

// Local administrative tool, not a public endpoint. Never selects a live provider.
config({ path: new URL("../.env", import.meta.url), quiet: true });
const { prisma, getActiveDevelopmentBlock, buildBlockPlanningContext, createDevelopmentBlock, recordBlockReview, buildBlockReviewContext, reviewAndSaveBlockWeek } = await import("@pkg/db");
const [action, rawUserId, file] = process.argv.slice(2);
try {
  const userId = z.coerce.number().int().positive().parse(rawUserId);
  if (!["show", "preview", "create", "replan", "review", "review-context", "review-week"].includes(action)) throw new Error("Usage: npm run blocks -- <show|preview|create|replan|review|review-context|review-week> <userId> [request.json]");
  if (action !== "show" && !file) throw new Error("Provide a JSON request file; see docs/development-blocks.md");
  const request = file ? JSON.parse(await readFile(file, "utf8")) : null;
  let result;
  if (action === "show") result = await getActiveDevelopmentBlock(userId);
  if (action === "preview") {
    const context = await buildBlockPlanningContext(userId, request);
    result = { context, proposal: validateBlockProposal(context, await deterministicBlockPlanner.createBlock(context)) };
  }
  if (action === "create") result = await createDevelopmentBlock(userId, request);
  if (action === "replan") {
    const expectedBlock = z.object({ id: z.number().int().positive(), revision: z.number().int().positive() }).strict().parse(request.expectedBlock);
    result = await createDevelopmentBlock(userId, request.direction, { mode: "REPLAN", expectedBlock });
  }
  if (action === "review") {
    const ids = z.object({ blockId: z.number().int().positive(), expectedRevision: z.number().int().positive() }).parse(request);
    result = await recordBlockReview(userId, ids.blockId, ids.expectedRevision, request.review);
  }
  if (action === "review-context" || action === "review-week") {
    const blockId = z.number().int().positive().parse(request.blockId);
    result = action === "review-context" ? await buildBlockReviewContext(userId, blockId, request.weekStart)
      : await reviewAndSaveBlockWeek(userId, blockId, z.number().int().positive().parse(request.expectedRevision),
        request.weekStart, simulatedBlockReviewer(request.proposal));
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
