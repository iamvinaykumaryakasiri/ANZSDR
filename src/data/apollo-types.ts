/**
 * What Apollo returns, and the one shape the rest of the system sees.
 *
 * Apollo's responses are lenient in the loosest sense: fields appear and vanish
 * by plan and by endpoint version (the older People Search returned full last
 * names and a placeholder email; the current one obfuscates the last name and
 * returns `has_email` flags). The raw schemas here accept both, and the
 * normalisers turn either into the same small record, so nothing downstream
 * ever branches on which endpoint version answered.
 */

import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Raw wire shapes                                                     */
/* ------------------------------------------------------------------ */

const nullishString = z.string().nullish();

const rawOrganizationSchema = z
  .object({
    id: nullishString,
    name: nullishString,
    primary_domain: nullishString,
    website_url: nullishString,
    industry: nullishString,
    estimated_num_employees: z.number().nullish(),
    short_description: nullishString
  })
  .passthrough();

const rawPhoneSchema = z
  .object({
    raw_number: nullishString,
    sanitized_number: nullishString,
    type_cd: nullishString,
    status_cd: nullishString,
    confidence_cd: nullishString,
    dnc_status_cd: nullishString
  })
  .passthrough();

export const rawPersonSchema = z
  .object({
    id: z.string().min(1),
    first_name: nullishString,
    last_name: nullishString,
    last_name_obfuscated: nullishString,
    name: nullishString,
    title: nullishString,
    seniority: nullishString,
    linkedin_url: nullishString,
    email: nullishString,
    email_status: nullishString,
    personal_emails: z.array(z.string()).nullish(),
    city: nullishString,
    state: nullishString,
    country: nullishString,
    organization_id: nullishString,
    organization: rawOrganizationSchema.nullish(),
    phone_numbers: z.array(rawPhoneSchema).nullish(),
    has_email: z.boolean().nullish(),
    has_direct_phone: z.union([z.boolean(), z.string()]).nullish()
  })
  .passthrough();
export type RawPerson = z.infer<typeof rawPersonSchema>;

export const peopleSearchResponseSchema = z
  .object({
    people: z.array(rawPersonSchema).default([]),
    contacts: z.array(rawPersonSchema).default([]),
    total_entries: z.number().nullish(),
    pagination: z
      .object({
        page: z.number().nullish(),
        per_page: z.number().nullish(),
        total_entries: z.number().nullish(),
        total_pages: z.number().nullish()
      })
      .passthrough()
      .nullish()
  })
  .passthrough();

export const matchResponseSchema = z
  .object({ person: rawPersonSchema.nullish() })
  .passthrough();

export const bulkMatchResponseSchema = z
  .object({
    status: nullishString,
    error_code: nullishString,
    error_message: nullishString,
    total_requested_enrichments: z.number().nullish(),
    unique_enriched_records: z.number().nullish(),
    missing_records: z.number().nullish(),
    credits_consumed: z.number().nullish(),
    matches: z.array(rawPersonSchema.nullable()).default([])
  })
  .passthrough();

export const organizationEnrichResponseSchema = z
  .object({ organization: rawOrganizationSchema.nullish() })
  .passthrough();

export const jobPostingsResponseSchema = z
  .object({
    organization_job_postings: z
      .array(
        z
          .object({
            id: nullishString,
            title: nullishString,
            url: nullishString,
            city: nullishString,
            state: nullishString,
            country: nullishString,
            posted_at: nullishString,
            last_seen_at: nullishString
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough();

export const contactCreateResponseSchema = z
  .object({ contact: z.object({ id: z.string() }).passthrough().nullish() })
  .passthrough();

/** The body Apollo POSTs to our webhook when phone numbers are ready. */
export const phoneWebhookPayloadSchema = z
  .object({
    status: nullishString,
    people: z
      .array(
        z
          .object({
            id: z.string().min(1),
            status: nullishString,
            phone_numbers: z.array(rawPhoneSchema).nullish()
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough();
export type PhoneWebhookPayload = z.infer<typeof phoneWebhookPayloadSchema>;

/* ------------------------------------------------------------------ */
/* Normalised records                                                  */
/* ------------------------------------------------------------------ */

export const phoneKindSchema = z.enum(['mobile', 'work_direct', 'work_hq', 'home', 'other', 'unknown']);
export type PhoneKind = z.infer<typeof phoneKindSchema>;

export const phoneNumberRecordSchema = z.object({
  /** E.164 where Apollo gave us one, otherwise the raw string. Geo-tagging re-parses it. */
  number: z.string().min(1),
  kind: phoneKindSchema,
  status: z.string().optional(),
  confidence: z.string().optional()
});
export type PhoneNumberRecord = z.infer<typeof phoneNumberRecordSchema>;

export const personRecordSchema = z.object({
  apolloId: z.string().min(1),
  firstName: z.string(),
  lastName: z.string(),
  /** True when Apollo returned only a masked surname (People Search does). */
  lastNameObfuscated: z.boolean().default(false),
  title: z.string(),
  seniority: z.string().optional(),
  linkedinUrl: z.string().optional(),
  organizationApolloId: z.string().optional(),
  organizationName: z.string().optional(),
  organizationDomain: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  /** Search-only hints. Not proof: an email only exists once enrichment says so. */
  hasEmail: z.boolean().optional(),
  hasDirectPhone: z.boolean().optional()
});
export type PersonRecord = z.infer<typeof personRecordSchema>;

export const enrichedPersonSchema = personRecordSchema.extend({
  email: z.string().optional(),
  /** Apollo's own word for how sure it is the address works: verified, unverified, likely to engage, ... */
  emailStatus: z.string().optional(),
  personalEmails: z.array(z.string()).default([]),
  phones: z.array(phoneNumberRecordSchema).default([])
});
export type EnrichedPerson = z.infer<typeof enrichedPersonSchema>;

/** Older People Search returned this literal in place of an address it would not reveal. */
const PLACEHOLDER_EMAIL = /^email_not_unlocked@/i;

function clean(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function realEmail(value: string | null | undefined): string | undefined {
  const cleaned = clean(value);
  if (cleaned === undefined || PLACEHOLDER_EMAIL.test(cleaned) || !cleaned.includes('@')) return undefined;
  return cleaned.toLowerCase();
}

function phoneKindOf(code: string | null | undefined): PhoneKind {
  const parsed = phoneKindSchema.safeParse((code ?? '').toLowerCase());
  return parsed.success ? parsed.data : 'unknown';
}

export function normalisePhones(raw: RawPerson['phone_numbers']): PhoneNumberRecord[] {
  const out: PhoneNumberRecord[] = [];
  for (const p of raw ?? []) {
    const number = clean(p.sanitized_number) ?? clean(p.raw_number);
    if (number === undefined) continue;
    out.push({
      number,
      kind: phoneKindOf(p.type_cd),
      ...(clean(p.status_cd) !== undefined ? { status: clean(p.status_cd) as string } : {}),
      ...(clean(p.confidence_cd) !== undefined ? { confidence: clean(p.confidence_cd) as string } : {})
    });
  }
  return out;
}

export function normalisePerson(raw: RawPerson): PersonRecord {
  const obfuscated = clean(raw.last_name) === undefined && clean(raw.last_name_obfuscated) !== undefined;
  const nameParts = (clean(raw.name) ?? '').split(/\s+/).filter((p) => p !== '');
  const firstName = clean(raw.first_name) ?? nameParts[0] ?? '';
  const lastName =
    clean(raw.last_name) ?? clean(raw.last_name_obfuscated) ?? (nameParts.length > 1 ? nameParts.slice(1).join(' ') : '');
  const org = raw.organization ?? undefined;
  const hasDirectPhone =
    typeof raw.has_direct_phone === 'boolean'
      ? raw.has_direct_phone
      : typeof raw.has_direct_phone === 'string'
        ? /^(yes|true)/i.test(raw.has_direct_phone)
        : undefined;
  const orgDomain = clean(org?.primary_domain);

  return {
    apolloId: raw.id,
    firstName,
    lastName,
    lastNameObfuscated: obfuscated,
    title: clean(raw.title) ?? '',
    ...(clean(raw.seniority) !== undefined ? { seniority: (clean(raw.seniority) as string).toLowerCase() } : {}),
    ...(clean(raw.linkedin_url) !== undefined ? { linkedinUrl: clean(raw.linkedin_url) as string } : {}),
    ...(clean(raw.organization_id ?? org?.id) !== undefined
      ? { organizationApolloId: clean(raw.organization_id ?? org?.id) as string }
      : {}),
    ...(clean(org?.name) !== undefined ? { organizationName: clean(org?.name) as string } : {}),
    ...(orgDomain !== undefined ? { organizationDomain: orgDomain.toLowerCase() } : {}),
    ...(clean(raw.city) !== undefined ? { city: clean(raw.city) as string } : {}),
    ...(clean(raw.state) !== undefined ? { state: clean(raw.state) as string } : {}),
    ...(clean(raw.country) !== undefined ? { country: clean(raw.country) as string } : {}),
    ...(typeof raw.has_email === 'boolean' ? { hasEmail: raw.has_email } : {}),
    ...(hasDirectPhone !== undefined ? { hasDirectPhone } : {})
  };
}

export function normaliseEnrichedPerson(raw: RawPerson): EnrichedPerson {
  const base = normalisePerson(raw);
  const email = realEmail(raw.email);
  return {
    ...base,
    ...(email !== undefined ? { email } : {}),
    ...(clean(raw.email_status) !== undefined ? { emailStatus: (clean(raw.email_status) as string).toLowerCase() } : {}),
    personalEmails: (raw.personal_emails ?? []).map((e) => realEmail(e)).filter((e): e is string => e !== undefined),
    phones: normalisePhones(raw.phone_numbers)
  };
}

export interface JobPosting {
  title: string;
  url: string;
  location?: string;
  postedAt?: string;
}

export const organizationRecordSchema = z.object({
  apolloId: z.string().min(1),
  name: z.string(),
  domain: z.string().min(1),
  industry: z.string().optional(),
  employees: z.number().optional(),
  description: z.string().optional()
});
export type OrganizationRecord = z.infer<typeof organizationRecordSchema>;

export function normaliseOrganization(
  raw: z.infer<typeof rawOrganizationSchema>,
  fallbackDomain: string
): OrganizationRecord | undefined {
  const id = clean(raw.id);
  if (id === undefined) return undefined;
  return {
    apolloId: id,
    name: clean(raw.name) ?? fallbackDomain,
    domain: (clean(raw.primary_domain) ?? fallbackDomain).toLowerCase(),
    ...(clean(raw.industry) !== undefined ? { industry: clean(raw.industry) as string } : {}),
    ...(typeof raw.estimated_num_employees === 'number' ? { employees: raw.estimated_num_employees } : {}),
    ...(clean(raw.short_description) !== undefined ? { description: clean(raw.short_description) as string } : {})
  };
}
