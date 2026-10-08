/**
 * Job postings from Apollo (section 5.3: "a strong tech-direction signal").
 *
 * What a company is hiring for says what it is building. Apollo supplies the
 * postings from licensed data, which is why this goes through the Apollo client
 * and not through a job board: the boards that carry the same postings prohibit
 * automated access, and Scout does not read them.
 *
 * Each posting becomes its own evidence document, so a claim about a particular
 * role cites that posting and quotes its title.
 */

import type { JobPosting, OrganizationRecord } from '../../data/apollo-types.js';
import type { EvidenceDoc, JobPostingSource } from './sources.js';

/** The part of the Apollo client this needs. */
export interface JobPostingsApi {
  enrichOrganization(domain: string): Promise<OrganizationRecord | undefined>;
  organizationJobPostings(organizationApolloId: string): Promise<JobPosting[]>;
}

export class ApolloJobPostings implements JobPostingSource {
  constructor(
    private readonly api: JobPostingsApi,
    private readonly now: () => Date = () => new Date(),
    private readonly limit = 10
  ) {}

  async forDomain(domain: string): Promise<EvidenceDoc[]> {
    const organization = await this.api.enrichOrganization(domain);
    if (organization === undefined) return [];
    const postings = await this.api.organizationJobPostings(organization.apolloId);
    const retrievedAt = this.now().toISOString();
    return postings.slice(0, this.limit).map((p) => ({
      url: p.url,
      title: `${p.title} - ${organization.name}`,
      text: [p.title, organization.name, p.location, p.postedAt !== undefined ? `posted ${p.postedAt}` : undefined]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' - '),
      kind: 'job-posting' as const,
      retrievedAt
    }));
  }
}
