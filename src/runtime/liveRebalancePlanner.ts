import type { Position } from "../domain/entities/Position.js";

export function resolveLiveRedeployAmounts(position: Position): {
  amountBase: number;
  amountQuote: number;
} {
  return {
    amountBase: Math.max(position.currentValueBase, 0),
    amountQuote: Math.max(
      position.currentValueQuote ?? position.deployAmountQuote,
      0,
    ),
  };
}
