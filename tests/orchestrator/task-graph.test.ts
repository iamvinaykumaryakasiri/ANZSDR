import { afterEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from '../support/harness.js';

let open: Harness[] = [];
afterEach(async () => {
  for (const h of open) await h.close();
  open = [];
});

async function fresh(): Promise<Harness> {
  const h = await harness();
  open.push(h);
  return h;
}

const NOW = new Date('2026-03-11T00:00:00Z');

describe('task graph', () => {
  it('runs the oldest task of the highest priority first', async () => {
    const h = await fresh();
    await h.tasks.create({ kind: 'a', payload: {}, priority: 3 });
    const urgent = await h.tasks.create({ kind: 'b', payload: {}, priority: 1 });
    expect((await h.tasks.nextRunnable(NOW))?.id).toBe(urgent.id);
  });

  it('holds a task back until everything it depends on is done', async () => {
    const h = await fresh();
    const first = await h.tasks.create({ kind: 'first', payload: {} });
    const second = await h.tasks.create({ kind: 'second', payload: {}, dependsOn: [first.id] });

    expect((await h.tasks.nextRunnable(NOW))?.id).toBe(first.id);
    await h.tasks.markDone(first.id, { ok: true }, NOW);
    expect((await h.tasks.nextRunnable(NOW))?.id).toBe(second.id);
  });

  it('blocks a task whose dependency died, rather than leaving it pending forever', async () => {
    const h = await fresh();
    const first = await h.tasks.create({ kind: 'first', payload: {} });
    const second = await h.tasks.create({ kind: 'second', payload: {}, dependsOn: [first.id] });

    await h.tasks.markStopped(first.id, 'escalated', 'went wrong', NOW);
    expect(await h.tasks.nextRunnable(NOW)).toBeNull();

    const blocked = await h.tasks.get(second.id);
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.lastError).toContain(first.id);
  });

  it('does not run a task before its scheduled time', async () => {
    const h = await fresh();
    const later = new Date(NOW.getTime() + 3_600_000);
    await h.tasks.create({ kind: 'callback', payload: {}, runAfter: later });
    expect(await h.tasks.nextRunnable(NOW)).toBeNull();
    expect((await h.tasks.nextRunnable(later))?.kind).toBe('callback');
  });

  it('puts a released task back where it was', async () => {
    const h = await fresh();
    const task = await h.tasks.create({ kind: 'a', payload: {} });
    await h.tasks.markRunning(task.id, NOW);
    expect((await h.tasks.get(task.id))?.status).toBe('running');
    await h.tasks.release(task.id);
    const back = await h.tasks.get(task.id);
    expect(back?.status).toBe('pending');
    expect(back?.attempts).toBe(0);
  });

  it('refuses to hand back a row whose payload no longer matches its schema', async () => {
    const h = await fresh();
    const task = await h.tasks.create({ kind: 'a', payload: { fine: true } });
    await h.db.$executeRawUnsafe(`UPDATE Task SET payload = 'not json at all' WHERE id = ?`, task.id);
    await expect(h.tasks.get(task.id)).rejects.toThrow(/does not match its schema/);
  });
});
