/**
 * Import this first in an entry point (a script or a server start), and `.env`
 * is loaded before anything reads the environment. Library code never imports
 * it, so tests and embedded use see only the environment they were given.
 */

import { loadDotEnv } from './env.js';

loadDotEnv();
