/**
 * Loading, querying and amending the claim index.
 *
 * The only question this module really answers is "may the agent say this?",
 * and the only answer that means yes is an approved claim. Everything else -
 * drafted, rejected, orphaned, absent - is a no, and the no is the default.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  claimIndexFileSchema,
  type Claim,
  type ClaimIndexFile,
  type ClaimStatus
} from './types.js';
import type { Market } from '../compliance/types.js';

export interface ClaimCounts {
  total: number;
  approved: number;
  draft: number;
  rejected: number;
  orphaned: number;
}

/** Two claims that cannot both be true, kept side by side rather than merged. */
export interface ClaimConflict {
  a: Claim;
  b: Claim;
  /** True when both are approved, which is the case that matters. */
  live: boolean;
}

export class ClaimIndex {
  private constructor(
    private readonly file: ClaimIndexFile,
    private readonly byId: Map<string, Claim>
  ) {}

  static fromObject(raw: unknown): ClaimIndex {
    const file = claimIndexFileSchema.parse(raw);
    const byId = new Map<string, Claim>();
    for (const claim of file.claims) {
      if (byId.has(claim.id)) {
        // A duplicate id means one claim silently shadows another, and which one
        // wins depends on file order. Refuse rather than pick.
        throw new Error(`duplicate claim id "${claim.id}" in the claim index`);
      }
      byId.set(claim.id, claim);
    }
    return new ClaimIndex(file, byId);
  }

  static load(path: string): ClaimIndex {
    return ClaimIndex.fromObject(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  }

  /**
   * Everything the agent is permitted to assert, optionally narrowed to one
   * market. This is the whole point of the module: nothing else is sayable.
   */
  assertable(market?: Market): Claim[] {
    return this.file.claims.filter(
      (c) => c.status === 'approved' && (market === undefined || c.markets.includes(market))
    );
  }

  /** Every claim, in whatever state, for the review tooling. */
  all(): Claim[] {
    return [...this.file.claims];
  }

  find(id: string): Claim | undefined {
    return this.byId.get(id);
  }

  withStatus(status: ClaimStatus): Claim[] {
    return this.file.claims.filter((c) => c.status === status);
  }

  counts(): ClaimCounts {
    return {
      total: this.file.claims.length,
      approved: this.withStatus('approved').length,
      draft: this.withStatus('draft').length,
      rejected: this.withStatus('rejected').length,
      orphaned: this.withStatus('orphaned').length
    };
  }

  /**
   * Claims that contradict each other, declared rather than inferred. A pair
   * where both sides are approved is the dangerous one: the agent could say
   * either, and which it said would depend on nothing.
   */
  conflicts(): ClaimConflict[] {
    const seen = new Set<string>();
    const out: ClaimConflict[] = [];
    for (const a of this.file.claims) {
      for (const otherId of a.conflictsWith) {
        const b = this.byId.get(otherId);
        if (b === undefined) continue;
        const key = JSON.stringify([a.id, b.id].sort());
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ a, b, live: a.status === 'approved' && b.status === 'approved' });
      }
    }
    return out;
  }

  /**
   * A claim naming a client is sayable only where section 6 says it is. Kept
   * here rather than in Guardian so the rule has one home.
   */
  nameableReferences(): Claim[] {
    return this.assertable().filter((c) => c.kind === 'reference' && c.nameable === true);
  }

  approve(id: string, by: string, at: Date): Claim {
    const claim = this.require(id);
    if (claim.status === 'orphaned') {
      throw new Error(
        `claim "${id}" is orphaned: the source it came from no longer contains it, so there is nothing to approve`
      );
    }
    claim.status = 'approved';
    claim.approvedBy = by;
    claim.approvedAt = at.toISOString();
    delete claim.rejectedReason;
    return claim;
  }

  reject(id: string, reason: string, at: Date): Claim {
    const claim = this.require(id);
    claim.status = 'rejected';
    claim.rejectedReason = reason;
    claim.approvedAt = at.toISOString();
    delete claim.approvedBy;
    return claim;
  }

  /** Replace the whole claim set. Used by the drop sync. */
  replaceAll(claims: Claim[]): void {
    this.file.claims = claims;
    this.byId.clear();
    for (const c of claims) this.byId.set(c.id, c);
  }

  save(path: string): void {
    writeFileSync(path, `${JSON.stringify(this.file, null, 2)}\n`, 'utf8');
  }

  private require(id: string): Claim {
    const claim = this.byId.get(id);
    if (claim === undefined) throw new Error(`no claim with id "${id}"`);
    return claim;
  }
}
