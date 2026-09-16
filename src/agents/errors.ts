/** Why a run stopped. Each maps to a distinct escalation the operator can act on. */
export type AgentFailureKind =
  | 'input-contract'
  | 'output-contract'
  | 'budget'
  | 'tool-contract'
  | 'unhandled';

export class AgentFailure extends Error {
  readonly kind: AgentFailureKind;
  readonly detail: Record<string, unknown>;

  constructor(kind: AgentFailureKind, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AgentFailure';
    this.kind = kind;
    this.detail = detail;
  }
}

export class BudgetExceeded extends AgentFailure {
  constructor(
    readonly limit: string,
    message: string,
    detail: Record<string, unknown> = {}
  ) {
    super('budget', message, { ...detail, limit });
    this.name = 'BudgetExceeded';
  }
}
