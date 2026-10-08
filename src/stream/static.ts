/**
 * Serving the built console (web/dist) at /console/.
 *
 * Only the compiled assets, which are public by nature: every piece of data the
 * console shows comes over /api/console, behind the admin token. Registered only
 * when a build exists, so a checkout that has not built the web app serves
 * nothing here rather than a broken page.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/** Returns whether a build was found and mounted. */
export function registerConsoleStatic(app: FastifyInstance, dir: string): boolean {
  const root = resolve(dir);
  const index = join(root, 'index.html');
  if (!existsSync(index)) return false;

  app.get('/console', async (_request, reply) => reply.redirect('/console/'));

  // A build whose Vite `base` is the default refers to its bundles as /assets/...
  // from wherever the page is. Serving those too means the app works at /console/
  // whichever base it was built with.
  app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
    const target = resolve(root, 'assets', normalize(request.params['*']));
    if (!target.startsWith(join(root, 'assets') + sep) || !existsSync(target) || !statSync(target).isFile()) {
      return reply.code(404).send({ error: 'not found' });
    }
    reply.header('content-type', TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream');
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return readFile(target);
  });

  app.get<{ Params: { '*': string } }>('/console/*', async (request, reply) => {
    let relative: string;
    try {
      relative = normalize(decodeURIComponent(request.params['*']));
    } catch {
      return reply.code(400).send({ error: 'bad path' });
    }
    const target = resolve(root, relative === '' || relative === '.' ? 'index.html' : relative);
    // A path that climbs out of the build directory is refused outright.
    if (target !== root && !target.startsWith(root + sep)) return reply.code(404).send({ error: 'not found' });

    const isFile = existsSync(target) && statSync(target).isFile();
    // A path with an extension that is not there is a missing asset, not a route
    // for the app to handle.
    if (!isFile && extname(target) !== '') return reply.code(404).send({ error: 'not found' });

    const file = isFile ? target : index;
    const hashed = file.startsWith(join(root, 'assets') + sep);
    reply.header('content-type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    reply.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    return readFile(file);
  });

  return true;
}
