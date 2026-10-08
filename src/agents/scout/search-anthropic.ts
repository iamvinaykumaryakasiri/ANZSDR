/**
 * Web search through Anthropic's server-side search tool.
 *
 * This is used to find pages, not to read them. The tool returns result URLs and
 * titles; the pages themselves are fetched by `PolicyFetcher`, which honours
 * robots.txt and refuses the hosts whose terms prohibit automated access. That
 * split is the point: the search provider decides where to look, and our own
 * code decides what we are allowed to read.
 *
 * The same deny list is also passed to the tool as `blocked_domains`, so those
 * sites are not returned in the first place.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { DENIED_HOSTS } from './fetcher.js';
import type { SearchHit, SearchProvider } from './sources.js';

/** The slice of the SDK this needs, so a test can hand in a fake. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface AnthropicSearchOptions {
  client: MessagesClient;
  /** A small, fast model: it only has to run one search. */
  model: string;
  maxResults?: number;
  blockedDomains?: readonly string[];
}

export class AnthropicWebSearch implements SearchProvider {
  constructor(private readonly options: AnthropicSearchOptions) {}

  async search(query: string): Promise<SearchHit[]> {
    const response = await this.options.client.messages.create({
      model: this.options.model,
      max_tokens: 1024,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 1,
          blocked_domains: [...(this.options.blockedDomains ?? DENIED_HOSTS)]
        }
      ],
      messages: [{ role: 'user', content: `Search the web once for: ${query}` }]
    });

    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const block of response.content) {
      // Server-tool errors arrive as a 200 with an error object in place of the list.
      if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
      for (const result of block.content) {
        if (seen.has(result.url)) continue;
        seen.add(result.url);
        hits.push({ url: result.url, title: result.title });
      }
    }
    return hits.slice(0, this.options.maxResults ?? 8);
  }
}
