/**
 * The knowledge drop, over HTTP.
 *
 * Vinay travels, and a folder you can only fill over SSH is a folder that stops
 * being filled. This puts the same drop folder behind the account desk: upload a
 * deck, sync it, read what came out, approve the lines worth saying.
 *
 * It is not the console in section 14 - that is Phase 8 and starts with a design
 * review. This is the admin surface that already exists, doing one more admin
 * job. When the console is built it mirrors this, the way the meeting desk in
 * section 14.4 mirrors the email flow.
 *
 * The safety property is the same one the CLI has, and it is the whole point:
 * an upload produces drafts. Nothing arriving through this route can be said to
 * a prospect until a person approves it line by line.
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ClaimIndex } from '../knowledge/claims.js';
import { mergeDrop, readDrop } from '../knowledge/ingest.js';
import { loadPack } from '../knowledge/pack.js';

/** Matches the CLI. Anything else is refused at the door rather than skipped later. */
const ALLOWED = new Set(['.pptx', '.md', '.txt']);
const MAX_BYTES = 20 * 1024 * 1024;

export interface KnowledgeApiOptions {
  /** The `knowledge/` directory. */
  dir: string;
  now?: () => Date;
}

const uploadSchema = z.object({
  filename: z.string().min(1).max(200),
  /** base64. Kept to JSON so the desk needs no multipart dependency. */
  content: z.string().min(1)
});

const rejectSchema = z.object({ reason: z.string().min(1).max(500) });
const approveSchema = z.object({ by: z.string().min(1).max(120).optional() });

/**
 * Reduce an uploaded name to something that cannot escape the drop folder.
 *
 * Everything up to the last separator is discarded, so `../../etc/passwd` and
 * `C:\Windows\x` both collapse to their final component; then anything that is
 * not a plain filename character goes. A name that survives to nothing is
 * refused rather than given a generated one - a file the operator cannot find
 * again by name is worse than an error.
 */
export function safeFilename(input: string): string | null {
  const base = input.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null;
  if (!ALLOWED.has(extname(cleaned).toLowerCase())) return null;
  return cleaned;
}

export function registerKnowledgeApi(app: FastifyInstance, options: KnowledgeApiOptions): void {
  const now = options.now ?? ((): Date => new Date());
  const indexPath = join(options.dir, 'approved-claims.json');
  const dropDir = join(options.dir, 'drop');

  const ensureDrop = (): void => {
    if (!existsSync(dropDir)) mkdirSync(dropDir, { recursive: true });
  };

  const state = (): Record<string, unknown> => {
    const index = ClaimIndex.load(indexPath);
    const pack = loadPack(options.dir);
    return {
      counts: index.counts(),
      conflicts: index.conflicts().map((c) => ({
        a: { id: c.a.id, text: c.a.text },
        b: { id: c.b.id, text: c.b.text },
        live: c.live
      })),
      claims: index.all().map((c) => ({
        id: c.id,
        text: c.text,
        kind: c.kind,
        status: c.status,
        markets: c.markets,
        notes: c.notes ?? '',
        approvedBy: c.approvedBy ?? '',
        rejectedReason: c.rejectedReason ?? '',
        source: c.sources[0] === undefined ? null : {
          kind: c.sources[0].kind,
          ref: c.sources[0].ref,
          quote: c.sources[0].quote,
          locator: c.sources[0].locator ?? ''
        }
      })),
      packMissing: pack.missing
    };
  };

  app.get('/api/knowledge', async () => state());

  app.get('/api/knowledge/files', async () => {
    ensureDrop();
    const { lines, skipped } = await readDrop(dropDir);
    const byFile = new Map<string, number>();
    for (const line of lines) byFile.set(line.file, (byFile.get(line.file) ?? 0) + 1);
    return {
      files: [...byFile].map(([name, candidates]) => ({
        name,
        candidates,
        bytes: statSync(join(dropDir, name)).size
      })),
      skipped
    };
  });

  app.post('/api/knowledge/files', async (request, reply) => {
    const parsed = uploadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'expected { filename, content }' });

    const name = safeFilename(parsed.data.filename);
    if (name === null) {
      return reply.code(400).send({ error: `only ${[...ALLOWED].join(', ')} files are read` });
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(parsed.data.content, 'base64');
    } catch {
      return reply.code(400).send({ error: 'content was not valid base64' });
    }
    if (bytes.length === 0) return reply.code(400).send({ error: 'the file is empty' });
    if (bytes.length > MAX_BYTES) {
      return reply.code(413).send({ error: `files are capped at ${MAX_BYTES / 1024 / 1024}MB` });
    }

    ensureDrop();
    const replaced = existsSync(join(dropDir, name));
    writeFileSync(join(dropDir, name), bytes);
    return reply.code(replaced ? 200 : 201).send({ name, bytes: bytes.length, replaced });
  });

  app.delete('/api/knowledge/files/:name', async (request, reply) => {
    const name = safeFilename((request.params as { name: string }).name);
    if (name === null) return reply.code(400).send({ error: 'not a file this folder holds' });
    const path = join(dropDir, name);
    if (!existsSync(path)) return reply.code(404).send({ error: 'no such file' });
    rmSync(path);
    // Deliberately not re-syncing here. Removing the file and orphaning the
    // claims it produced are two decisions, and the operator makes the second.
    return { removed: name };
  });

  app.post('/api/knowledge/sync', async () => {
    ensureDrop();
    const index = ClaimIndex.load(indexPath);
    const { lines, skipped } = await readDrop(dropDir);
    const result = mergeDrop(index.all(), lines, now());
    index.replaceAll(result.claims);
    index.save(indexPath);
    return {
      read: lines.length,
      added: result.added.length,
      unchanged: result.unchanged,
      orphaned: result.orphaned.length,
      skipped,
      ...state()
    };
  });

  app.post('/api/knowledge/claims/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = approveSchema.safeParse(request.body ?? {});
    const index = ClaimIndex.load(indexPath);
    if (index.find(id) === undefined) return reply.code(404).send({ error: `no claim "${id}"` });
    try {
      index.approve(id, parsed.success ? (parsed.data.by ?? 'operator') : 'operator', now());
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
    index.save(indexPath);
    return state();
  });

  app.post('/api/knowledge/claims/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = rejectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'a reason is required' });
    const index = ClaimIndex.load(indexPath);
    if (index.find(id) === undefined) return reply.code(404).send({ error: `no claim "${id}"` });
    index.reject(id, parsed.data.reason, now());
    index.save(indexPath);
    return state();
  });
}
