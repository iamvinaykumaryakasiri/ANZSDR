/**
 * The template language for playbook text.
 *
 * Coach writes phrasing, and phrasing is the only thing it can write. A template
 * is literal words plus four kinds of placeholder, and nothing else:
 *
 *   {{firstName}}     the prospect's first name
 *   {{company}}       the account's name
 *   {{hook}}          one of the dossier's sourced hooks, verbatim
 *   {{claim:<id>}}    an APPROVED claim from the claim index, verbatim
 *
 * That is the whole mechanism by which a fact can enter a script. A figure, a
 * client, a capability or a certification can only be said on a call if it arrives
 * through a claim placeholder, which is resolved against the live claim index when
 * the prompt is built - so un-approving a claim silences every variant that used
 * it, without anyone having to find them.
 */

const BRACES = /\{\{([^{}]*)\}\}/g;
const CLAIM_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/;

export type Placeholder =
  | { kind: 'firstName' }
  | { kind: 'company' }
  | { kind: 'hook' }
  | { kind: 'claim'; id: string };

export interface ParsedTemplate {
  placeholders: Placeholder[];
  /** Anything that looked like a placeholder and was not one we recognise. */
  invalid: string[];
  /** The template with every placeholder removed: the words Coach actually wrote. */
  literal: string;
}

function parseToken(token: string): Placeholder | null {
  if (token === 'firstName') return { kind: 'firstName' };
  if (token === 'company') return { kind: 'company' };
  if (token === 'hook') return { kind: 'hook' };
  if (token.startsWith('claim:')) {
    const id = token.slice('claim:'.length);
    return CLAIM_ID.test(id) ? { kind: 'claim', id } : null;
  }
  return null;
}

export function parseTemplate(template: string): ParsedTemplate {
  const placeholders: Placeholder[] = [];
  const invalid: string[] = [];

  const stripped = template.replace(BRACES, (_whole, inner: string) => {
    const parsed = parseToken(inner.trim());
    if (parsed === null) invalid.push(`{{${inner}}}`);
    else placeholders.push(parsed);
    return ' ';
  });

  // A lone brace is either a typo for a placeholder or an attempt to smuggle one
  // past the parser. Neither is phrasing.
  if (/[{}]/.test(stripped)) invalid.push('a stray "{" or "}" outside any placeholder');

  return { placeholders, invalid, literal: stripped.replace(/\s+/g, ' ').trim() };
}

export function claimIdsIn(template: string): string[] {
  return parseTemplate(template)
    .placeholders.filter((p): p is { kind: 'claim'; id: string } => p.kind === 'claim')
    .map((p) => p.id);
}

export interface RenderValues {
  firstName: string;
  company: string;
  /** Absent when the dossier has no usable hook. */
  hook?: string;
  /** Resolves an APPROVED claim to its text, or undefined. Never a draft. */
  claimText: (id: string) => string | undefined;
}

export interface Rendered {
  text: string;
  /** Placeholders that could not be filled. A non-empty list means do not speak this. */
  unresolved: string[];
}

export function renderTemplate(template: string, values: RenderValues): Rendered {
  const unresolved: string[] = [];
  const text = template
    .replace(BRACES, (_whole, inner: string) => {
      const parsed = parseToken(inner.trim());
      if (parsed === null) {
        unresolved.push(`{{${inner}}}`);
        return '';
      }
      switch (parsed.kind) {
        case 'firstName':
          return values.firstName;
        case 'company':
          return values.company;
        case 'hook':
          if (values.hook === undefined || values.hook.trim() === '') {
            unresolved.push('hook');
            return '';
          }
          return values.hook.trim();
        case 'claim': {
          const claim = values.claimText(parsed.id);
          if (claim === undefined) {
            unresolved.push(`claim:${parsed.id}`);
            return '';
          }
          return claim;
        }
      }
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { text, unresolved };
}
