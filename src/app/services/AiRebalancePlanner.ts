import type {
  AiRebalanceDecision,
  RebalanceReviewInput,
} from "../../domain/entities/RebalanceDecision.js";

export interface AiRebalancePlanner {
  reviewRebalanceDecision(
    input: RebalanceReviewInput,
  ): Promise<AiRebalanceDecision>;
}
