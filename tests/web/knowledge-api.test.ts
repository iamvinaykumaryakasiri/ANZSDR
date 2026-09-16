/**
 * The knowledge drop over HTTP.
 *
 * This route accepts a file from a browser and writes it to disk, so the first
 * thing tested is that a filename cannot escape the folder. After that it is the
 * same guarantee the CLI has, which is the one that actually protects a
 * prospect: an upload produces drafts, and a draft cannot be said on a call.
 */

import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { buildServer } from '../../src/web/server.js';
import { safeFilename } from '../../src/web/knowledge-api.js';

const TOKEN = 'test-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };

let live: Array<{ app: FastifyInstance; db: Blackboard; dir: string }> = [];
afterEach(async () => {
  for (const { app, db, dir } of live) {
    await app.close();
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
  live = [];
});

async function desk(): Promise<{ app: FastifyInstance; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'anzsdr-knowledge-'));
  mkdirSync(join(dir, 'drop'));
  writeFileSync(
    join(dir, 'approved-claims.json'),
    JSON.stringify({ version: 1, claims: [] }, null, 2)
  );
  const db = await createTestBlackboard();
  const app = buildServer({ db, adminToken: TOKEN, knowledgeDir: dir });
  live.push({ app, db, dir });
  return { app, dir };
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

async function deckBase64(line: string): Promise<string> {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', `<a:p><a:t>${line}</a:t></a:p>`);
  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
}

describe('a filename cannot escape the folder', () => {
  it('strips every path it is given', () => {
    expect(safeFilename('../../etc/passwd.md')).toBe('passwd.md');
    expect(safeFilename('/etc/shadow.txt')).toBe('shadow.txt');
    expect(safeFilename('C:\\Windows\\system.md')).toBe('system.md');
    expect(safeFilename('a/b/c/deck.pptx')).toBe('deck.pptx');
  });

  it('refuses a name that is only dots, or that survives to nothing', () => {
    expect(safeFilename('..')).toBeNull();
    expect(safeFilename('../..')).toBeNull();
    expect(safeFilename('')).toBeNull();
    expect(safeFilename('   ')).toBeNull();
  });

  it('refuses an extension the folder does not read', () => {
    expect(safeFilename('payload.sh')).toBeNull();
    expect(safeFilename('notes.docx')).toBeNull();
    expect(safeFilename('index.html')).toBeNull();
  });

  it('keeps an ordinary name intact', () => {
    expect(safeFilename('ANZ Capability Deck v2.pptx')).toBe('ANZ Capability Deck v2.pptx');
  });

  it('does not write outside the drop folder when asked to', async () => {
    const { app, dir } = await desk();
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: auth,
      payload: { filename: '../escaped.md', content: b64('- A line that should not escape the folder\n') }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().name).toBe('escaped.md');
    expect(existsSync(join(dir, 'drop', 'escaped.md'))).toBe(true);
    expect(existsSync(join(dir, 'escaped.md'))).toBe(false);
  });
});

describe('the door', () => {
  it('refuses every knowledge route without the token', async () => {
    const { app } = await desk();
    for (const [method, url] of [
      ['GET', '/api/knowledge'],
      ['GET', '/api/knowledge/files'],
      ['POST', '/api/knowledge/sync']
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('a button that takes no arguments', () => {
  it('syncs on a POST whose JSON body is empty, which is what a browser sends', async () => {
    // fetch() sets content-type: application/json whether or not there is a
    // body, and Fastify's default parser calls an empty one malformed. The desk
    // hit this on the "read the folder" button; the API tests did not, because
    // inject() with no payload sends no content-type at all.
    const { app } = await desk();
    await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: auth,
      payload: { filename: 'a.md', content: b64('- Hexaware runs a governed AI delivery layer\n') }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/sync',
      headers: { ...auth, 'content-type': 'application/json' },
      body: ''
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().added).toBe(1);
  });

  it('approves on an empty body too, defaulting the approver', async () => {
    const { app } = await desk();
    await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: auth,
      payload: { filename: 'a.md', content: b64('- Hexaware runs a governed AI delivery layer\n') }
    });
    const sync = await app.inject({ method: 'POST', url: '/api/knowledge/sync', headers: auth });
    const id = (sync.json().claims as Array<{ id: string }>)[0]?.id as string;

    const response = await app.inject({
      method: 'POST',
      url: `/api/knowledge/claims/${id}/approve`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: ''
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().counts).toMatchObject({ approved: 1 });
  });

  it('still refuses a body that is genuinely malformed', async () => {
    const { app } = await desk();
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{ not json'
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('uploading', () => {
  it('accepts a deck and reads its slides', async () => {
    const { app } = await desk();
    await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: auth,
      payload: { filename: 'capability.pptx', content: await deckBase64('We run a governed AI delivery layer') }
    });

    const files = await app.inject({ method: 'GET', url: '/api/knowledge/files', headers: auth });
    expect(files.json().files[0]).toMatchObject({ name: 'capability.pptx', candidates: 1 });
  });

  it('refuses a file type the folder does not read', async () => {
    const { app } = await desk();
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: auth,
      payload: { filename: 'script.sh', content: b64('rm -rf /') }
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an empty file rather than creating an empty claim source', async () => {
    const { app } = await desk();
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: auth,
      payload: { filename: 'nothing.md', content: Buffer.from('').toString('base64') }
    });
    expect(response.statusCode).toBe(400);
  });

  it('replaces a re-uploaded file rather than duplicating it', async () => {
    const { app } = await desk();
    const payload = { filename: 'a.md', content: b64('- Hexaware runs a governed AI delivery layer\n') };
    await app.inject({ method: 'POST', url: '/api/knowledge/files', headers: auth, payload });
    const second = await app.inject({ method: 'POST', url: '/api/knowledge/files', headers: auth, payload });

    expect(second.statusCode).toBe(200);
    expect(second.json().replaced).toBe(true);
    const files = await app.inject({ method: 'GET', url: '/api/knowledge/files', headers: auth });
    expect(files.json().files).toHaveLength(1);
  });
});

describe('what an upload can and cannot do', () => {
  it('produces drafts, and nothing Lexi may say', async () => {
    const { app, dir } = await desk();
    await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: auth,
      payload: { filename: 'a.md', content: b64('- Hexaware runs a governed AI delivery layer\n') }
    });

    const sync = await app.inject({ method: 'POST', url: '/api/knowledge/sync', headers: auth });
    expect(sync.json().added).toBe(1);
    expect(sync.json().counts).toMatchObject({ draft: 1, approved: 0 });

    const written = JSON.parse(readFileSync(join(dir, 'approved-claims.json'), 'utf8')) as {
      claims: Array<{ status: string }>;
    };
    expect(written.claims.every((c) => c.status === 'draft')).toBe(true);
  });

  it('lets the operator approve one line, which is the only way anything becomes sayable', async () => {
    const { app } = await desk();
    await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: auth,
      payload: { filename: 'a.md', content: b64('- Hexaware runs a governed AI delivery layer\n') }
    });
    const sync = await app.inject({ method: 'POST', url: '/api/knowledge/sync', headers: auth });
    const id = (sync.json().claims as Array<{ id: string }>)[0]?.id as string;

    const approved = await app.inject({
      method: 'POST',
      url: `/api/knowledge/claims/${id}/approve`,
      headers: auth,
      payload: { by: 'Vinay Kumar' }
    });
    expect(approved.json().counts).toMatchObject({ approved: 1, draft: 0 });
    expect((approved.json().claims as Array<{ approvedBy: string }>)[0]?.approvedBy).toBe('Vinay Kumar');
  });

  it('requires a reason to reject, so the record says why', async () => {
    const { app } = await desk();
    await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: auth,
      payload: { filename: 'a.md', content: b64('- Hexaware runs a governed AI delivery layer\n') }
    });
    const sync = await app.inject({ method: 'POST', url: '/api/knowledge/sync', headers: auth });
    const id = (sync.json().claims as Array<{ id: string }>)[0]?.id as string;

    const noReason = await app.inject({
      method: 'POST',
      url: `/api/knowledge/claims/${id}/reject`,
      headers: auth,
      payload: {}
    });
    expect(noReason.statusCode).toBe(400);

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/knowledge/claims/${id}/reject`,
      headers: auth,
      payload: { reason: 'out of date' }
    });
    expect(rejected.json().counts).toMatchObject({ rejected: 1, approved: 0 });
  });

  it('refuses to approve a claim whose source has gone', async () => {
    const { app, dir } = await desk();
    await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: auth,
      payload: { filename: 'a.md', content: b64('- Hexaware runs a governed AI delivery layer\n') }
    });
    const sync = await app.inject({ method: 'POST', url: '/api/knowledge/sync', headers: auth });
    const id = (sync.json().claims as Array<{ id: string }>)[0]?.id as string;

    rmSync(join(dir, 'drop', 'a.md'));
    await app.inject({ method: 'POST', url: '/api/knowledge/sync', headers: auth });

    const response = await app.inject({
      method: 'POST',
      url: `/api/knowledge/claims/${id}/approve`,
      headers: auth,
      payload: {}
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/orphaned/);
  });

  it('keeps an approval when the same file is re-read', async () => {
    const { app } = await desk();
    const payload = { filename: 'a.md', content: b64('- Hexaware runs a governed AI delivery layer\n') };
    await app.inject({ method: 'POST', url: '/api/knowledge/files', headers: auth, payload });
    const sync = await app.inject({ method: 'POST', url: '/api/knowledge/sync', headers: auth });
    const id = (sync.json().claims as Array<{ id: string }>)[0]?.id as string;
    await app.inject({ method: 'POST', url: `/api/knowledge/claims/${id}/approve`, headers: auth, payload: {} });

    const again = await app.inject({ method: 'POST', url: '/api/knowledge/sync', headers: auth });
    expect(again.json().counts).toMatchObject({ approved: 1 });
  });
});

describe('removing a file', () => {
  it('deletes it without silently unsaying what it produced', async () => {
    const { app, dir } = await desk();
    await app.inject({
      method: 'POST',
      url: '/api/knowledge/files',
      headers: auth,
      payload: { filename: 'a.md', content: b64('- Hexaware runs a governed AI delivery layer\n') }
    });
    await app.inject({ method: 'POST', url: '/api/knowledge/sync', headers: auth });

    const removed = await app.inject({ method: 'DELETE', url: '/api/knowledge/files/a.md', headers: auth });
    expect(removed.json()).toEqual({ removed: 'a.md' });
    expect(existsSync(join(dir, 'drop', 'a.md'))).toBe(false);

    // Removing the file and orphaning its claims are two decisions. Until the
    // folder is re-read, the claim is exactly as it was.
    const state = await app.inject({ method: 'GET', url: '/api/knowledge', headers: auth });
    expect(state.json().counts).toMatchObject({ draft: 1, orphaned: 0 });
  });

  it('404s on a file it does not have', async () => {
    const { app } = await desk();
    const response = await app.inject({ method: 'DELETE', url: '/api/knowledge/files/ghost.md', headers: auth });
    expect(response.statusCode).toBe(404);
  });
});
