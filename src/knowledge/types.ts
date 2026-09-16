/**
 * The claim index: the hard boundary from brief section 6.
 *
 * Caller may assert a claim whose status is `approved`. It may not assert
 * anything else - however true, however obvious, however hard the prospect
 * pushes. Everything drafted by the build, and everything extracted from a
 * dropped deck, arrives as `draft` and is therefore unavailable until a person
 * reads it and says otherwise.
 *
 * A claim with no source cannot be constructed. That is enforced here by the
 * schema rather than by a prompt or a review habit, for the same reason Scout's
 * facts carry URLs: the cheapest way to avoid asserting something we cannot
 * stand behind is to make it structurally impossible to hold.
 */

import { z } from 'zod';

export const marketSchema = z.enum(['AU', 'NZ']);

/**
 * Where a claim came from.
 *
 * `url` is a public page a prospect could go and read. `operator` is Vinay -
 * no weaker, arguably stronger, but it must never be presented as something
 * lookup-able. `drop` is a file in `knowledge/drop/`.
 */
export const claimSourceSchema = z.object({
  kind: z.enum(['url', 'operator', 'drop']),
  ref: z.string().min(1),
  /** The words the claim is drawn from. Required: a source with no quote is a gesture. */
  quote: z.string().min(1),
  retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  /** Where in the source, for a reader going back to check: "slide 4", "## ANZ". */
  locator: z.string().min(1).optional()
});
export type ClaimSource = z.infer<typeof claimSourceSchema>;

/**
 * `orphaned` is what happens to an extracted claim whose source line has
 * disappeared from the file it came from. It is not deleted, because deleting
 * it would quietly discard an approval; it stops being assertable and says why.
 */
export const claimStatusSchema = z.enum(['draft', 'approved', 'rejected', 'orphaned']);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

export const claimKindSchema = z.enum(['fact', 'figure', 'capability', 'reference', 'framework']);
export type ClaimKind = z.infer<typeof claimKindSchema>;

export const claimSchema = z.object({
  id: z.string().min(1),
  /** What may be asserted, in words Caller may actually use. */
  text: z.string().min(1),
  kind: claimKindSchema,
  status: claimStatusSchema,
  markets: z.array(marketSchema).min(1).default(['AU', 'NZ']),
  sources: z.array(claimSourceSchema).min(1),
  /** Section 6: a client name is sayable only where this is explicitly true. */
  nameable: z.boolean().optional(),
  /** Other claim ids this one disagrees with. Surfaced, never silently reconciled. */
  conflictsWith: z.array(z.string()).default([]),
  notes: z.string().optional(),
  approvedBy: z.string().min(1).optional(),
  approvedAt: z.string().optional(),
  rejectedReason: z.string().min(1).optional()
});
export type Claim = z.infer<typeof claimSchema>;

export const claimIndexFileSchema = z.object({
  version: z.literal(1),
  note: z.string().optional(),
  claims: z.array(claimSchema)
});
export type ClaimIndexFile = z.infer<typeof claimIndexFileSchema>;
