#!/usr/bin/env node
/**
 * Dev tooling: screenshots of the built console against the DEV-ONLY fixture
 * server. Needs `npm run build` first. Chromium comes from the machine
 * (PW_CHROMIUM, default /opt/pw-browsers/chromium); nothing is downloaded.
 *
 *   node scripts/screenshots.mjs            # everything, into web/screenshots/
 *   node scripts/screenshots.mjs home       # only shots whose name contains "home"
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'screenshots');
mkdirSync(out, { recursive: true });
const only = process.argv[2] ?? '';
const CHROMIUM = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium';
const API_PORT = 8081;
const WEB_PORT = 4173;

const children = [];
function run(cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  children.push(child);
  return child;
}
async function waitFor(url, headers = {}) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not come up`);
}
function stopAll() {
  while (children.length) children.pop()?.kill('SIGTERM');
}
process.on('exit', stopAll);

const sydneyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());

async function session(state, shots) {
  const fixture = run('node', ['dev/fixture-server.mjs'], { PORT: String(API_PORT), FIXTURE_STATE: state, FIXTURE_LOOP: '0' });
  const preview = run(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--mode', 'fixture', '--port', String(WEB_PORT), '--strictPort']);
  await waitFor(`http://localhost:${API_PORT}/healthz`);
  await waitFor(`http://localhost:${WEB_PORT}/`);

  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  for (const shot of shots) {
    if (only && !shot.name.includes(only)) continue;
    const context = await browser.newContext({
      viewport: shot.viewport,
      deviceScaleFactor: shot.scale ?? 1,
      isMobile: shot.mobile ?? false,
      hasTouch: shot.mobile ?? false,
      reducedMotion: 'reduce'
    });
    await context.addInitScript(
      ([day, fullLayout]) => {
        sessionStorage.setItem('anzsdr.console.token', 'demo');
        localStorage.setItem('anzsdr.console.briefing-seen', day);
        if (fullLayout) localStorage.setItem('anzsdr.console.layout', 'full');
      },
      [sydneyDay, shot.fullLayout ?? false]
    );
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(`[${shot.name}] page error:`, e.message));
    page.on('console', (m) => m.type() === 'error' && console.error(`[${shot.name}] console error:`, m.text()));
    await page.goto(`http://localhost:${WEB_PORT}/${shot.hash ?? ''}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main', { timeout: 10000 });
    await page.waitForTimeout(700);
    if (shot.act) await shot.act(page);
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(out, `${shot.name}.png`), fullPage: shot.full ?? false });
    console.log('wrote', `${shot.name}.png`);
    await context.close();
  }
  await browser.close();
  stopAll();
  await new Promise((r) => setTimeout(r, 400));
  void fixture;
  void preview;
}

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

await session('live', [
  { name: 'desktop-home-live', viewport: desktop, hash: '#/' },
  { name: 'desktop-home-live-full', viewport: desktop, hash: '#/', full: true },
  { name: 'desktop-meeting-desk', viewport: desktop, hash: '#/meetings' },
  { name: 'desktop-call-log', viewport: desktop, hash: '#/calls' },
  {
    name: 'desktop-call-log-open',
    viewport: desktop,
    hash: '#/calls',
    act: async (page) => {
      await page.locator('table a').first().click();
      await page.waitForSelector('article');
    }
  },
  {
    name: 'desktop-stop-armed',
    viewport: desktop,
    hash: '#/',
    act: async (page) => {
      await page.getByRole('button', { name: 'Stop all', exact: true }).click();
    }
  },
  {
    name: 'desktop-jarvis-confirm',
    viewport: desktop,
    hash: '#/',
    act: async (page) => {
      await page.keyboard.press('Control+k');
      await page.fill('#jarvis-input', 'Pause the NZ banking campaign');
      await page.keyboard.press('Enter');
      await page.waitForSelector('text=Nothing has happened yet');
    }
  },
  {
    name: 'desktop-curve-hover',
    viewport: desktop,
    hash: '#/',
    act: async (page) => {
      const bins = page.locator('button[aria-label*="Show them"]');
      const n = await bins.count();
      let best = 0;
      let bestIdx = 0;
      for (let i = 0; i < n; i++) {
        const label = (await bins.nth(i).getAttribute('aria-label')) ?? '';
        const c = Number(label.match(/: (\d+) call/)?.[1] ?? 0);
        if (c > best) {
          best = c;
          bestIdx = i;
        }
      }
      await bins.nth(bestIdx).scrollIntoViewIfNeeded();
      await bins.nth(bestIdx).hover();
      await page.waitForTimeout(200);
      await page.getByRole('heading', { name: /ended between/ }).scrollIntoViewIfNeeded();
    }
  },
  {
    name: 'desktop-funnel-filtered',
    viewport: desktop,
    hash: '#/',
    act: async (page) => {
      await page.getByRole('button', { name: /^Real conversation/ }).click();
      await page.getByRole('heading', { name: 'Where they drop' }).scrollIntoViewIfNeeded();
    }
  },
  { name: 'desktop-trace', viewport: desktop, hash: '#/trace' },
  { name: 'desktop-playbook', viewport: desktop, hash: '#/playbook' },
  { name: 'desktop-accounts', viewport: desktop, hash: '#/accounts' },
  { name: 'desktop-health', viewport: desktop, hash: '#/health' },
  { name: 'desktop-briefing', viewport: desktop, hash: '#/briefing' },
  { name: 'mobile-home-live', viewport: phone, mobile: true, scale: 2, hash: '#/' },
  { name: 'mobile-home-live-full', viewport: phone, mobile: true, scale: 2, hash: '#/', full: true },
  { name: 'mobile-briefing', viewport: phone, mobile: true, scale: 2, hash: '#/briefing' },
  {
    name: 'mobile-stop-armed',
    viewport: phone,
    mobile: true,
    scale: 2,
    hash: '#/',
    act: async (page) => {
      await page.getByRole('button', { name: 'Stop all', exact: true }).click();
    }
  },
  { name: 'zoom200-home', viewport: { width: 720, height: 450 }, hash: '#/', full: true },
  { name: 'tablet-meeting-desk', viewport: { width: 820, height: 1000 }, hash: '#/meetings' }
]);

await session('idle', [
  { name: 'desktop-home-idle', viewport: desktop, hash: '#/' },
  { name: 'mobile-home-idle', viewport: phone, mobile: true, scale: 2, hash: '#/' },
  { name: 'mobile-meeting-desk-full', viewport: phone, mobile: true, scale: 2, hash: '#/meetings', fullLayout: true }
]);
