/**
 * Reading `.env`.
 *
 * `.env.example` has always said "copy to .env", and the Prisma CLI does read
 * it - which is why DATABASE_URL appeared to work. Nothing in the application
 * did, so a key placed there was silently ignored and the first symptom was a
 * "not set" error from a variable that was set. This closes that gap.
 *
 * A variable already present in the environment wins over the file, so a
 * secret exported in a shell or injected by a host is never overridden by a
 * stale line in a file. A missing file is normal (a deployed host has real
 * environment variables and no file), and is not an error.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Load `path` into `process.env` without overriding anything already set. Returns whether a file was read. */
export function loadDotEnv(path: string = resolve(REPO_ROOT, '.env')): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
