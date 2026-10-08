/**
 * What Scout can read, behind interfaces.
 *
 * Scout's research is a set of documents, each with the URL it came from and the
 * text that was actually retrieved. Everything the dossier says has to be
 * traceable to one of those documents, and the deterministic validator in
 * `validate.ts` checks that it is. So the unit of evidence is a document with a
 * URL, wherever it came from: a web page, a stock exchange announcement, a job
 * posting.
 *
 * The sources are interfaces so the real ones (a search provider, a fetcher that
 * honours robots.txt, Apollo's job postings) can be swapped for fixtures in
 * tests, and so a new one is one class.
 */

export type EvidenceKind = 'company-site' | 'newsroom' | 'announcement' | 'job-posting' | 'web';

export interface EvidenceDoc {
  /** The page it came from. This is what a fact's source URL has to match. */
  url: string;
  title: string;
  /** The retrieved text, as plain text. The validator looks for quotes in this. */
  text: string;
  kind: EvidenceKind;
  retrievedAt: string;
}

export interface SearchHit {
  url: string;
  title: string;
}

export interface SearchProvider {
  search(query: string): Promise<SearchHit[]>;
}

export type FetchFailure =
  | 'blocked-host'
  | 'robots-disallow'
  | 'robots-unreachable'
  | 'not-https'
  | 'invalid-url'
  | 'http-error'
  | 'too-large'
  | 'unsupported-type'
  | 'too-many-redirects'
  | 'timeout'
  | 'error';

export type FetchResult =
  | { ok: true; url: string; finalUrl: string; title: string; text: string; contentType: string; retrievedAt: string }
  | { ok: false; url: string; reason: FetchFailure; detail?: string };

export interface PageFetcher {
  fetch(url: string): Promise<FetchResult>;
}

export interface AnnouncementResult {
  docs: EvidenceDoc[];
  /** Why nothing was read, in plain English, for the dossier's `unverified` list. */
  skipped: string[];
}

export interface AnnouncementSource {
  forCompany(input: { domain: string; accountName: string }): Promise<AnnouncementResult>;
}

export interface JobPostingSource {
  forDomain(domain: string): Promise<EvidenceDoc[]>;
}

export interface ResearchTools {
  search: SearchProvider;
  fetcher: PageFetcher;
  announcements?: AnnouncementSource;
  jobs?: JobPostingSource;
}
