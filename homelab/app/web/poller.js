// @ts-check
// Polling controller (design §4.4, UX §6.3): api/state every 5 s while the
// panel is visible, api/config again whenever the state's rev differs, a fast
// 1 s poll while a manual refresh runs, and an immediate poll when the panel
// becomes visible again. No DOM access; dependencies are injected so the
// logic is unit-tested with fakes (test/unit/web-poller.test.js).

import { POLL_MS, clockSkew, flattenTiles, healthChanges, reloadToast } from "./model.js";

/** @typedef {import("./model.js").Config} Config */
/** @typedef {import("./model.js").Snapshot} Snapshot */

/**
 * @typedef {object} PollerState
 * @property {Config | null} config
 * @property {Snapshot | null} snap
 * @property {number} lastPollAt   ms of the last successful api/state (0 = never)
 * @property {string | null} error  last failure, null after a success
 * @property {boolean} refreshBusy
 * @property {number} skew        server clock minus browser clock, ms, from the last snapshot (review F1)
 * @property {number} configAt    browser ms when api/config first loaded (0 = never)
 */

/**
 * @typedef {object} PollerDeps
 * @property {() => Promise<Config>} getConfig
 * @property {(rev: number | null) => Promise<Snapshot>} getState
 * @property {() => Promise<{ accepted: true } | { accepted: false, retryAfterS: number }>} postRefresh
 * @property {() => number} now
 * @property {() => boolean} isHidden
 * @property {(fn: () => void, ms: number) => unknown} setTimer
 * @property {(handle: unknown) => void} clearTimer
 * @property {(s: PollerState) => void} onChange
 * @property {(t: { text: string, showProblems: boolean }) => void} [onToast]
 * @property {(c: { down: string[], up: string[] }) => void} [onHealthChange]
 */

export const FAST_POLL_MS = 1000;
export const REFRESH_MAX_MS = 10_000;

/** @param {PollerDeps} deps */
export function createPoller(deps) {
  /** @type {PollerState} */
  const state = { config: null, snap: null, lastPollAt: 0, error: null, refreshBusy: false, skew: 0, configAt: 0 };
  /** @type {unknown} */
  let timer = null;
  let inFlight = false;
  let again = false;
  let stopped = true;
  let busyUntil = 0;
  /** Poll count since the refresh was accepted; the first poll may predate the round. */
  let pollsSinceRefresh = 0;

  const emit = () => deps.onChange({ ...state });

  /** @param {number} ms */
  function schedule(ms) {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    if (stopped || deps.isHidden()) return;
    timer = deps.setTimer(() => {
      timer = null;
      void tick();
    }, ms);
  }

  async function tick() {
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    if (deps.isHidden()) return;
    inFlight = true;
    try {
      if (!state.config) {
        state.config = await deps.getConfig();
        state.configAt = deps.now();
      }
      let snap = await deps.getState(state.config.rev);
      if (snap.rev !== state.config.rev) {
        const next = await deps.getConfig();
        const toast = reloadToast(state.config, next);
        state.config = next;
        if (toast) deps.onToast?.(toast);
        // The snapshot may belong to a config we haven't drawn yet; that's
        // fine: tiles look results up by id, missing ids show as loading.
      }
      const changes = healthChanges(flattenTiles(state.config.groups), state.snap, snap);
      if (changes.down.length || changes.up.length) deps.onHealthChange?.(changes);
      state.snap = snap;
      state.lastPollAt = deps.now();
      state.skew = clockSkew(snap.now, state.lastPollAt);
      state.error = null;
      if (state.refreshBusy) {
        pollsSinceRefresh++;
        if ((pollsSinceRefresh >= 2 && !snap.refreshing) || deps.now() >= busyUntil) state.refreshBusy = false;
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : "Unknown error";
      if (state.refreshBusy && deps.now() >= busyUntil) state.refreshBusy = false;
    } finally {
      inFlight = false;
    }
    emit();
    if (again) {
      again = false;
      schedule(0);
    } else {
      schedule(state.refreshBusy ? FAST_POLL_MS : POLL_MS);
    }
  }

  return {
    start() {
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      schedule(0);
    },
    /** Call on visibilitychange. Hidden: pause; visible: poll now. */
    visibilityChanged() {
      if (deps.isHidden()) schedule(0);
      else void tick();
    },
    /** Manual refresh (UX §6.3). Button stays disabled while it runs (max 10 s). */
    async refresh() {
      if (state.refreshBusy) return;
      state.refreshBusy = true;
      pollsSinceRefresh = 0;
      busyUntil = deps.now() + REFRESH_MAX_MS;
      emit();
      try {
        const r = await deps.postRefresh();
        if (!r.accepted) busyUntil = deps.now() + r.retryAfterS * 1000;
      } catch (err) {
        state.refreshBusy = false;
        state.error = err instanceof Error ? err.message : "Refresh failed";
        emit();
        return;
      }
      schedule(FAST_POLL_MS);
    },
    /** Current state (for tests). */
    get state() {
      return { ...state };
    },
  };
}
