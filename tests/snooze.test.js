import { describe, it, expect } from 'vitest';
import { createSnoozeControl, SNOOZE_OPTIONS, formatUntil } from '../alcoia/src/content/snooze.js';

function fakeStorage() {
  let data = {};
  return {
    get: (keys, cb) => {
      const out = {};
      for (const k of Object.keys(keys)) out[k] = k in data ? data[k] : keys[k];
      cb(out);
    },
    set: (obj, cb) => { data = { ...data, ...obj }; cb && cb(); },
  };
}

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('createSnoozeControl', () => {
  it('is inactive with nothing set', async () => {
    const control = createSnoozeControl({ storage: fakeStorage(), now: fixedClock().now });
    expect(await control.isActive()).toBe(false);
    expect(await control.remainingMs()).toBe(0);
  });

  it('becomes active for the chosen duration', async () => {
    const clock = fixedClock();
    const control = createSnoozeControl({ storage: fakeStorage(), now: clock.now });
    const until = await control.snooze(15 * 60000);
    expect(until).toBe(1_000_000 + 15 * 60000);
    expect(await control.isActive()).toBe(true);
    expect(await control.remainingMs()).toBe(15 * 60000);
  });

  it('expires correctly once the duration has passed', async () => {
    const clock = fixedClock();
    const control = createSnoozeControl({ storage: fakeStorage(), now: clock.now });
    await control.snooze(60000);
    clock.advance(59000);
    expect(await control.isActive()).toBe(true);
    clock.advance(2000);
    expect(await control.isActive()).toBe(false);
    expect(await control.remainingMs()).toBe(0);
  });

  it('cancel() ends it immediately, explicitly', async () => {
    const clock = fixedClock();
    const control = createSnoozeControl({ storage: fakeStorage(), now: clock.now });
    await control.snooze(60 * 60000);
    expect(await control.isActive()).toBe(true);
    await control.cancel();
    expect(await control.isActive()).toBe(false);
  });

  it('a second snooze() call replaces rather than stacks', async () => {
    const clock = fixedClock();
    const control = createSnoozeControl({ storage: fakeStorage(), now: clock.now });
    await control.snooze(60 * 60000);
    const secondUntil = await control.snooze(15 * 60000);
    expect(secondUntil).toBe(1_000_000 + 15 * 60000);
    expect(await control.remainingMs()).toBe(15 * 60000);
  });

  it('persists across separate control instances sharing the same storage — survives what a browser restart would be', async () => {
    const storage = fakeStorage();
    const clock = fixedClock();
    const a = createSnoozeControl({ storage, now: clock.now });
    await a.snooze(30 * 60000);
    const b = createSnoozeControl({ storage, now: clock.now });
    expect(await b.isActive()).toBe(true);
    expect(await b.remainingMs()).toBe(30 * 60000);
  });

  it('never auto-renews — once expired, stays expired without another snooze() call', async () => {
    const clock = fixedClock();
    const control = createSnoozeControl({ storage: fakeStorage(), now: clock.now });
    await control.snooze(60000);
    clock.advance(120000);
    expect(await control.isActive()).toBe(false);
    clock.advance(3600000);
    expect(await control.isActive()).toBe(false);
  });

  it('degrades to inactive with no storage available, rather than throwing', async () => {
    const control = createSnoozeControl({ storage: null });
    expect(await control.isActive()).toBe(false);
    expect(await control.snooze(60000)).toBe(0);
  });
});

describe('SNOOZE_OPTIONS', () => {
  it('offers a small, fixed set of durations', () => {
    expect(SNOOZE_OPTIONS.length).toBeGreaterThanOrEqual(2);
    expect(SNOOZE_OPTIONS.length).toBeLessThanOrEqual(4);
    for (const opt of SNOOZE_OPTIONS) {
      expect(typeof opt.id).toBe('string');
      expect(typeof opt.label).toBe('string');
      expect(typeof opt.durationMs).toBe('function');
    }
  });

  it('"rest of today" ends at local midnight, not a fixed offset', () => {
    const today = SNOOZE_OPTIONS.find((o) => o.id === 'today');
    const noon = new Date(2026, 0, 15, 12, 0, 0).getTime();
    const lateNight = new Date(2026, 0, 15, 23, 30, 0).getTime();
    const untilFromNoon = noon + today.durationMs(noon);
    const untilFromLate = lateNight + today.durationMs(lateNight);
    const endOfDay = new Date(2026, 0, 15, 23, 59, 59, 999).getTime();
    expect(untilFromNoon).toBe(endOfDay);
    // Both must land on the same clock time (midnight), regardless of when
    // during the day it was chosen — not "12 hours from now" or similar.
    expect(new Date(untilFromLate).getHours()).toBe(23);
    expect(new Date(untilFromLate).getMinutes()).toBe(59);
  });

  it('always returns a positive duration even called right at midnight', () => {
    const today = SNOOZE_OPTIONS.find((o) => o.id === 'today');
    const justBeforeMidnight = new Date(2026, 0, 15, 23, 59, 59, 999).getTime();
    expect(today.durationMs(justBeforeMidnight)).toBeGreaterThan(0);
  });
});

describe('formatUntil', () => {
  it('formats a timestamp as a time of day', () => {
    const t = new Date(2026, 0, 15, 14, 5, 0).getTime();
    expect(formatUntil(t)).toMatch(/2:05|14:05/);
  });

  it('returns an empty string for no timestamp', () => {
    expect(formatUntil(0)).toBe('');
    expect(formatUntil(null)).toBe('');
  });
});
