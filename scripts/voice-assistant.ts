/**
 * Create or update the voice provider's assistant so that it calls our endpoint.
 *
 *   npm run voice:assistant -- --print   show the configuration that would be sent (secrets hidden)
 *   npm run voice:assistant              create it, or update the one already named in config/voice.yaml
 *
 * This places no call. It sets up the assistant that a call will use: our
 * endpoint as its brain, no first message of its own (the opening is ours),
 * recording on, our webhook as its server. Run it again after changing
 * config/voice.yaml; it is idempotent.
 */

import '../src/config/env-autoload.js';
import { buildVapiAdapter, loadCore } from '../src/voice/runtime.js';
import { buildVapiAssistant } from '../src/voice/vapi.js';

function need(name: string, why: string): string {
  const value = (process.env[name] ?? '').trim();
  if (value === '') {
    console.error(`${name} is not set: ${why}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const printOnly = process.argv.includes('--print');
  const publicBaseUrl = need('PUBLIC_BASE_URL', 'the provider needs a public https address to call back on (docs/VOICE-SETUP.md step 4)');
  if (!/^https:\/\//i.test(publicBaseUrl)) {
    console.error('PUBLIC_BASE_URL must start with https://');
    process.exit(1);
  }
  const llmSecret = need('VOICE_SHARED_SECRET', 'openssl rand -hex 24');
  const webhookSecret = need('VAPI_WEBHOOK_SECRET', 'openssl rand -hex 24');

  const core = loadCore(process.env);
  await core.db.$disconnect();

  const assistant = buildVapiAssistant({ config: core.voice, publicBaseUrl, webhookSecret, llmSecret });

  if (printOnly) {
    const shown = JSON.parse(JSON.stringify(assistant)) as Record<string, unknown>;
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact);
      if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /secret|apikey|x-vapi-secret/i.test(k) ? '<hidden>' : redact(v)]));
      }
      return value;
    };
    console.log(JSON.stringify(redact(shown), null, 2));
    return;
  }

  const adapter = buildVapiAdapter(process.env, { assistantRequired: false });
  if (adapter === null) {
    console.error('VAPI_API_KEY is not set.');
    process.exit(1);
  }
  try {
    const { id, created } = await adapter.upsertAssistant(assistant, (process.env.VAPI_ASSISTANT_ID ?? '').trim() || undefined);
    console.log(`${created ? 'Created' : 'Updated'} assistant ${id}`);
    if ((process.env.VAPI_ASSISTANT_ID ?? '').trim() !== id) console.log(`Put this in .env:  VAPI_ASSISTANT_ID=${id}`);
    console.log('Next: npm run voice:doctor -- --online');
  } catch (error) {
    console.error(`\nVapi refused the assistant:\n  ${(error as Error).message}\n`);
    console.error('The message names the field. The values most likely to need adjusting are in config/voice.yaml:');
    console.error('voice.provider / voice.voice_id and transcriber.model / transcriber.language.');
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
