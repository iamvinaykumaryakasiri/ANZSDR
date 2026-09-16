/**
 * Blackboard connection.
 *
 * Tests get a throwaway SQLite file and apply the committed migrations directly,
 * so they run against the same schema production does rather than a hand-rolled
 * approximation of it.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

// `import.meta.dirname` is rewritten to the entry module's directory under some
// bundlers and test transforms, which silently resolves repository paths to the
// wrong place. The URL of this module is not rewritten.
const HERE = dirname(fileURLToPath(import.meta.url));

const ROOT = resolve(HERE, '../..');
const MIGRATIONS_DIR = resolve(ROOT, 'prisma/migrations');

/**
 * Resolve a SQLite URL to an absolute path anchored at the repository root.
 *
 * A relative `file:` URL is resolved against the schema directory by the Prisma
 * CLI and against the working directory elsewhere, which quietly produces two
 * different databases and a very confusing afternoon. Anchoring it here means
 * one URL always means one file, whoever opens it and from where.
 */
export function resolveDatabaseUrl(url: string): string {
  if (!url.startsWith('file:')) return url;
  const path = url.slice('file:'.length);
  if (path.startsWith('/')) return `file:${path}`;
  return `file:${resolve(ROOT, path)}`;
}

export function createBlackboard(databaseUrl?: string): PrismaClient {
  const url = resolveDatabaseUrl(databaseUrl ?? process.env.DATABASE_URL ?? 'file:./data/anzsdr.db');
  return new PrismaClient({ datasources: { db: { url } } });
}

/** Every committed migration's SQL, in order. */
export function migrationStatements(): string[] {
  // An empty migration set would produce an empty database and a pile of
  // confusing "table does not exist" errors, so it is an error here instead.
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`no migrations directory at ${MIGRATIONS_DIR}`);
  }
  const statements = readdirSync(MIGRATIONS_DIR)
    .filter((d) => existsSync(join(MIGRATIONS_DIR, d, 'migration.sql')))
    .sort()
    .flatMap((d) =>
      readFileSync(join(MIGRATIONS_DIR, d, 'migration.sql'), 'utf8')
        .split(';')
        // Prisma prefixes each statement with a `-- CreateTable` style comment,
        // so comments are stripped line by line rather than used to skip chunks.
        .map((chunk) =>
          chunk
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('--'))
            .join('\n')
            .trim()
        )
        .filter((chunk) => chunk !== '')
    );
  if (statements.length === 0) {
    throw new Error(`no migration statements found under ${MIGRATIONS_DIR}`);
  }
  return statements;
}

export async function applyMigrations(prisma: PrismaClient): Promise<void> {
  for (const statement of migrationStatements()) {
    await prisma.$executeRawUnsafe(statement);
  }
}

/** A fresh, empty blackboard on disk. Callers disconnect it when they are done. */
export async function createTestBlackboard(): Promise<PrismaClient> {
  const dir = mkdtempSync(join(tmpdir(), 'anzsdr-bb-'));
  const prisma = createBlackboard(`file:${join(dir, 'test.db')}`);
  await applyMigrations(prisma);
  return prisma;
}

export type Blackboard = PrismaClient;
