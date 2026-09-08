import { z } from "zod";
import type { AthleteProfile } from "./athlete-profile.js";
import { PlanningContextSchema, type PlanningContext } from "./planning-context.js";
import { PlanSportSchema } from "./planner.js";
import { summarizeEstablishedTraining } from "./planning-history.js";
import {
  BlockMondaySchema, BlockWeekPatternSchema, DEFAULT_BLOCK_WEEK_PATTERN, DevelopmentBlockProposalSchema,
  DevelopmentFocusesSchema, TrainingPhaseSchema, type DevelopmentBlock, type DevelopmentBlockProposal, type DevelopmentFocus,
} from "./development-block.js";

// Explicit strategic direction for the initial local provider. A future block AI
// can make these choices behind the same contract, without changing weekly jobs.
export const BlockPlanningDirectionSchema = z.object({
  startDate: BlockMondaySchema, phase: TrainingPhaseSchema,
  focuses: DevelopmentFocusesSchema.optional(), weekPattern: BlockWeekPatternSchema.optional(),
  raceIds: z.array(z.number().int().positive()).max(50).default([]),
  rationale: z.string().trim().min(1).max(4000),
}).strict();
export type BlockPlanningDirection = z.infer<typeof BlockPlanningDirectionSchema>;
export interface BlockPlanningContext {
  version: 1;
  generatedAt: string;
  athlete: PlanningContext["athlete"];
  planningObjective: PlanningContext["planningObjective"];
  goals: PlanningContext["goals"];
  trainingFocus?: AthleteProfile["trainingFocus"];
  races: PlanningContext["races"];
  performanceProfile: PlanningContext["performanceProfile"];
  recentTraining: PlanningContext["recentTraining"];
  trainingHistory: PlanningContext["trainingHistory"];
  establishedTraining: Record<"RUN" | "BIKE" | "SWIM", ReturnType<typeof summarizeEstablishedTraining>>;
  availability: PlanningContext["availability"];
  availabilityOverrides: AthleteProfile["availability"]["overrides"];
  restrictions: PlanningContext["restrictions"];
  adjustments: PlanningContext["adjustments"];
  dataQuality: PlanningContext["dataQuality"];
  activeBlock: PlanningContext["developmentBlock"];
  recentBlocks: { id: number; status: DevelopmentBlock["status"]; proposal: DevelopmentBlockProposal }[];
  direction: BlockPlanningDirection;
}
export interface BlockPlanner {
  createBlock(context: BlockPlanningContext): Promise<DevelopmentBlockProposal>;
}

export function makeBlockPlanningContext(raw: PlanningContext, direction: BlockPlanningDirection,
  recentBlocks: BlockPlanningContext["recentBlocks"] = []): BlockPlanningContext {
  const context = PlanningContextSchema.parse(raw);
  return {
    version: 1, generatedAt: context.generatedAt, athlete: context.athlete, planningObjective: context.planningObjective,
    goals: context.goals, races: context.races, performanceProfile: context.performanceProfile,
    recentTraining: context.recentTraining, trainingHistory: context.trainingHistory,
    establishedTraining: Object.fromEntries(PlanSportSchema.options.map(sport => [sport,
      summarizeEstablishedTraining(context.trainingHistory?.weeks.map(week => week.sports[sport]) ?? []),
    ])) as BlockPlanningContext["establishedTraining"],
    availability: context.availability, availabilityOverrides: [], restrictions: context.restrictions, adjustments: context.adjustments,
    dataQuality: context.dataQuality, activeBlock: context.developmentBlock,
    recentBlocks: recentBlocks.slice(0, 3), direction: BlockPlanningDirectionSchema.parse(direction),
  };
}

/** Deterministic scaffolding, not an inferred coaching assessment. Explicit focuses
 * take precedence; no score threshold is treated as evidence of a weakness. */
export const deterministicBlockPlanner: BlockPlanner = {
  async createBlock(context) {
    const direction = BlockPlanningDirectionSchema.parse(context.direction);
    let focuses = direction.focuses;
    if (!focuses) {
      if (context.planningObjective.mode === "RACE_TARGETED") throw new Error("The local block planner requires explicit race-focused direction");
      const sports = PlanSportSchema.options.filter(sport => context.goals[sport] !== 0);
      if (!sports.length) throw new Error("Set a nonzero or history-based sport goal before creating a block");
      const previousPrimary = context.recentBlocks[0]?.proposal.focuses.find(focus => focus.role === "PRIMARY")?.sport;
      const rotated = sports[(sports.indexOf(previousPrimary!) + 1) % sports.length]!;
      const preference = context.trainingFocus;
      const preferred = preference ? sports.filter(sport => preference[sport] === Math.max(...sports.map(value => preference[value]))) : sports;
      const primary = preferred.includes(rotated) ? rotated : preferred[0]!;
      focuses = sports.map((sport): DevelopmentFocus => ({
        sport, capability: sport === "SWIM" ? "SUSTAINED_ENDURANCE" : "LONG_ENDURANCE",
        role: sport === primary ? "PRIMARY" : "MAINTENANCE",
        progressionStrategy: sport === primary ? "LONG_SESSION" : "MAINTAIN",
        rationale: sport === primary
          ? preference ? `Your saved ${preference[sport]}% emphasis is highest among sports with an enabled weekly goal. This block prioritizes endurance development in this sport; progression still depends on training response.`
            : "Broad development emphasis, rotated from the recent primary sport. This is not a diagnosed weakness; progression still needs response evidence."
          : preference ? `Your saved emphasis is ${preference[sport]}%. Keep supporting endurance exposure while ${primary.toLowerCase()} receives the main development focus. Your weekly minute goal is unchanged.`
            : "Maintain broad endurance while another sport receives development emphasis.",
      }));
    }
    const defaultPattern = direction.phase === "TAPER" ? ["TAPER"] : direction.phase === "RECOVERY_TRANSITION" ? ["RECOVERY"] : [...DEFAULT_BLOCK_WEEK_PATTERN];
    return DevelopmentBlockProposalSchema.parse({ version: 1, ...direction, focuses,
      weekPattern: direction.weekPattern ?? defaultPattern });
  },
};

export function validateBlockProposal(context: BlockPlanningContext, raw: unknown): DevelopmentBlockProposal {
  const proposal = DevelopmentBlockProposalSchema.parse(raw);
  if (proposal.startDate !== context.direction.startDate) throw new Error("Block proposal changed the requested start date");
  if (proposal.phase !== context.direction.phase) throw new Error("Block proposal changed the supplied season phase");
  if (proposal.raceIds.some(id => !context.races.some(race => race.id === id))) throw new Error("Block references a race outside the athlete's supplied context");
  if (proposal.focuses.some(focus => context.goals[focus.sport] === 0)) throw new Error("Block focus includes an explicitly excluded sport");
  if ((proposal.phase === "TAPER" || proposal.weekPattern.some(role => role === "TAPER" || role === "RACE")) && !proposal.raceIds.length) throw new Error("Taper and race weeks require a referenced event");
  return proposal;
}
