/* snooze.js — an explicit, reader-chosen pause on interruptions
 *
 * Worth having before any inferred tolerance adaptation: it is explicit,
 * cheap, honest, and it produces a signal no inference engine will produce
 * better. A reader who snoozes constantly is telling you something directly.
 *
 * What it does and does not touch:
 *   - Suppresses the final render step only (content.js's onIntervention).
 *   - Detection, coverage tracking and the quiz gate all keep running —
 *     turning those off would mean the quiz gate never opens for a reader
 *     who reads with reminders snoozed, which is a worse outcome than a
 *     paused interruption.
 *   - Never auto-renews. A snooze that silently re-arms itself is not the
 *     reader's decision anymore, it is the product's, wearing the reader's
 *     choice as cover.
 *   - Persisted in chrome.storage.local, so it does survive a browser
 *     restart — the project notes' "no silent persistence across restarts" is
 *     satisfied by always showing the true remaining time wherever this is
 *     displayed (the popup, the confirmation toast), never a stale label.
 */

const STORAGE_KEY = 'sra_snooze_until';

/* `durationMs` takes `now` so "rest of today" can be computed relative to
 * the moment it is actually chosen, not module load time. */
export const SNOOZE_OPTIONS = Object.freeze([
  { id: '15m', label: '15 minutes', durationMs: () => 15 * 60000 },
  { id: '1h', label: '1 hour', durationMs: () => 60 * 60000 },
  {
    id: 'today',
    label: 'Rest of today',
    durationMs: (now) => {
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      // If it's already past 23:59:59.999 somehow, or exactly midnight,
      // still offer a real pause rather than a near-zero one.
      return Math.max(60000, end.getTime() - now);
    },
  },
]);

export function formatUntil(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function createSnoozeControl(opts = {}) {
  const storage = opts.storage || (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null);
  const now = opts.now || (() => Date.now());

  function storageGet() {
    return new Promise((resolve) => storage.get({ [STORAGE_KEY]: 0 }, (res) => resolve(Number(res[STORAGE_KEY]) || 0)));
  }
  function storageSet(until) {
    return new Promise((resolve) => storage.set({ [STORAGE_KEY]: until }, resolve));
  }

  async function until() {
    if (!storage) return 0;
    return storageGet();
  }

  async function remainingMs() {
    const u = await until();
    return Math.max(0, u - now());
  }

  async function isActive() {
    return (await remainingMs()) > 0;
  }

  /* Starts (or replaces) a snooze. Returns the absolute end timestamp so a
   * caller can display it immediately without a second read. */
  async function snooze(durationMs) {
    if (!storage || !(durationMs > 0)) return 0;
    const end = now() + durationMs;
    await storageSet(end);
    return end;
  }

  /* Explicit only — nothing in this module ever calls this itself. A
   * snooze that silently cancels is as much a violation of "the reader's
   * decision" as one that silently renews. */
  async function cancel() {
    if (!storage) return;
    await storageSet(0);
  }

  return { isActive, remainingMs, until, snooze, cancel };
}
