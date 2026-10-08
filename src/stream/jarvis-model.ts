/**
 * Jarvis's free-text path, through Claude.
 *
 * Used only for a question the deterministic parser did not recognise, and only
 * when an API key is present. The model is handed read-only tools and nothing
 * else: there is no tool that writes, so there is nothing for a mistaken or
 * manipulated model to write with. Instructions never reach it; they are
 * recognised by jarvis-intents.ts and confirmed by a person.
 *
 * Untested against the real API in this build (no key in the test environment);
 * the tool loop is exercised against a scripted client in tests/stream.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { JarvisModel, JarvisReadTool } from './jarvis.js';

const MAX_TURNS = 5;
const MAX_TOOL_RESULT_CHARS = 20_000;

/** The slice of the SDK the loop needs, so a test can stand in for the network. */
export interface JarvisMessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export function claudeJarvisModel(options: { client: JarvisMessagesClient; model: string; maxTokens?: number }): JarvisModel {
  return {
    async answer({ question, system, tools }): Promise<string> {
      const byName = new Map<string, JarvisReadTool>(tools.map((t) => [t.name, t]));
      const apiTools: Anthropic.Tool[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema
      }));

      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await options.client.messages.create({
          model: options.model,
          max_tokens: options.maxTokens ?? 1024,
          system,
          messages,
          tools: apiTools
        });

        const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || calls.length === 0) {
          return response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
        }

        messages.push({ role: 'assistant', content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const call of calls) {
          const tool = byName.get(call.name);
          if (tool === undefined) {
            results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `no such tool: ${call.name}` });
            continue;
          }
          try {
            const output = JSON.stringify(await tool.run(call.input)) ?? 'null';
            results.push({ type: 'tool_result', tool_use_id: call.id, content: output.slice(0, MAX_TOOL_RESULT_CHARS) });
          } catch (error) {
            results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: (error as Error).message });
          }
        }
        messages.push({ role: 'user', content: results });
      }
      throw new Error('the model kept asking for more reads and did not answer');
    }
  };
}
