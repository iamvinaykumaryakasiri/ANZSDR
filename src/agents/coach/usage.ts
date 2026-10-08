/** What a model call cost, in the terms the agent budget meters. */
export interface AgentUsage {
  tokensIn?: number;
  tokensOut?: number;
  usd?: number;
}

/** Dollars for a call from its token counts and a per-million-token price. */
export function costUsd(tokensIn: number, tokensOut: number, price: { input: number; output: number }): number {
  return (tokensIn * price.input + tokensOut * price.output) / 1_000_000;
}
