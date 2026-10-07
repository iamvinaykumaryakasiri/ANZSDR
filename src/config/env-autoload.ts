/**
 * Import this first in an entry point (a script or a server start), and `.env`
 * is loaded before anything reads the environment. Library code never imports
 * it, so tests and embedded use see only the environment they were given.
 */

import { loadDotEnv } from './env.js';

loadDotEnv();

// Cloud sessions reserve ANTHROPIC_API_KEY for their own authentication and do
// not pass a user-set value through. LEXI_ANTHROPIC_API_KEY is the same key
// under a name they leave alone; an explicit ANTHROPIC_API_KEY still wins.
const alias = (process.env.LEXI_ANTHROPIC_API_KEY ?? '').trim();
if (alias !== '' && (process.env.ANTHROPIC_API_KEY ?? '').trim() === '') {
  process.env.ANTHROPIC_API_KEY = alias;
}
