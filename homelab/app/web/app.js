// @ts-check
// Homelab Dashboard frontend entry (WS5). Preact + htm, plain ES modules, no
// bundler. All URLs are relative to the page (HA ingress sub-path). All text
// is rendered through htm/Preact as text nodes: no HTML sinks anywhere.
import { render } from "../vendor/preact.mjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "../vendor/hooks.mjs";
import { html } from "./lib.js";
import { getConfig, getState, postRefresh } from "./api.js";
import { defaultLocale } from "./format.js";
import {
  BACKEND_STALE_MS,
  allProblems,
  announcement,
  flattenTiles,
  headerSummary,
  health,
  pageMode,
  warningCount,
} from "./model.js";
import { createPoller } from "./poller.js";
import { startThemeBridge } from "./theme.js";
import { ConfigBanner } from "./components/ConfigBanner.js";
import { Group } from "./components/Group.js";
import { Header } from "./components/Header.js";
import { Booting, Empty, FatalError, Toast, Unreachable } from "./components/Pages.js";
import { Problems } from "./components/Problems.js";
import { tileDomId } from "./components/Tile.js";
import { Welcome } from "./components/Welcome.js";

/** @typedef {import("./model.js").Config} Config */
/** @typedef {import("./model.js").Group} GroupT */
/** @typedef {import("./poller.js").PollerState} PollerState */

const ANNOUNCE_GAP_MS = 10_000;
const TOAST_MS = 4000;

/** localStorage, wrapped: private mode and disabled storage must not break the page. */
const store = {
  /** @param {string} k */
  get(k) {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  /** @param {string} k @param {string} v */
  set(k, v) {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      // Storage unavailable: the choice lasts for this page view only.
    }
  },
};
const COLLAPSE_KEY = (/** @type {string} */ id) => `hl:collapsed:${id}`;
const WELCOME_KEY = "hl:welcome-dismissed";

/** Group ids from the top down to the group containing the tile. @param {GroupT[]} groups @param {string} tileId @returns {string[]} */
function groupPathOf(groups, tileId) {
  for (const g of groups) {
    if (g.tiles.some((t) => t.id === tileId)) return [g.id];
    const sub = groupPathOf(g.groups, tileId);
    if (sub.length) return [g.id, ...sub];
  }
  return [];
}

/** @param {GroupT[]} groups @param {Map<string, boolean>} out @param {boolean} all */
function collectDefaults(groups, out, all) {
  for (const g of groups) {
    out.set(g.id, g.collapsed || all);
    collectDefaults(g.groups, out, all);
  }
  return out;
}

function App() {
  const [ps, setPs] = useState(/** @type {PollerState} */ ({ config: null, snap: null, lastPollAt: 0, error: null, refreshBusy: false }));
  const [now, setNow] = useState(Date.now());
  const [overrides, setOverrides] = useState(/** @type {Record<string, boolean>} */ ({}));
  const [dismissedRev, setDismissedRev] = useState(-1);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => store.get(WELCOME_KEY) === "1");
  const [toast, setToast] = useState(/** @type {{ text: string, showProblems: boolean } | null} */ (null));
  const [spoken, setSpoken] = useState("");
  const poller = useRef(/** @type {ReturnType<typeof createPoller> | null} */ (null));
  const theme = useRef(/** @type {ReturnType<typeof startThemeBridge> | null} */ (null));
  const locale = defaultLocale();

  // Live region (UX §10): one message per 10 s at most; a flap keeps the latest state.
  const pending = useRef({
    down: /** @type {Set<string>} */ (new Set()),
    up: /** @type {Set<string>} */ (new Set()),
    last: 0,
    timer: /** @type {any} */ (null),
  });
  const flush = useCallback(() => {
    const p = pending.current;
    p.timer = null;
    const text = announcement({ down: [...p.down], up: [...p.up] });
    p.down.clear();
    p.up.clear();
    if (!text) return;
    p.last = Date.now();
    setSpoken(text);
  }, []);
  const onHealthChange = useCallback(
    (/** @type {{ down: string[], up: string[] }} */ ch) => {
      const p = pending.current;
      for (const n of ch.down) {
        p.up.delete(n);
        p.down.add(n);
      }
      for (const n of ch.up) {
        p.down.delete(n);
        p.up.add(n);
      }
      if (p.timer) return;
      p.timer = setTimeout(flush, Math.max(0, p.last + ANNOUNCE_GAP_MS - Date.now()));
    },
    [flush],
  );

  useEffect(() => {
    theme.current = startThemeBridge("auto");
    const p = createPoller({
      getConfig: () => getConfig(),
      getState: (rev) => getState(rev),
      postRefresh: () => postRefresh(),
      now: () => Date.now(),
      isHidden: () => document.hidden,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(/** @type {any} */ (h)),
      onChange: (s) => {
        setPs(s);
        setNow(Date.now());
      },
      onToast: (t) => {
        setToast(t);
        setSpoken(t.text);
      },
      onHealthChange,
    });
    poller.current = p;
    p.start();
    const onVis = () => p.visibilityChanged();
    document.addEventListener("visibilitychange", onVis);
    const ticker = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 5000);
    return () => {
      p.stop();
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(ticker);
    };
  }, [onHealthChange]);

  const config = ps.config;
  useEffect(() => {
    if (config) theme.current?.setOption(config.theme);
  }, [config?.theme]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (config) document.title = config.title;
  }, [config?.title]);

  const defaults = useMemo(
    () => (config ? collectDefaults(config.groups, new Map(), config.settings.groupsInitiallyCollapsed) : new Map()),
    [config],
  );
  const isCollapsed = useCallback(
    (/** @type {string} */ id) => {
      if (Object.hasOwn(overrides, id)) return overrides[id] === true;
      const saved = store.get(COLLAPSE_KEY(id));
      if (saved === "1" || saved === "0") return saved === "1";
      return defaults.get(id) === true;
    },
    [overrides, defaults],
  );
  const onToggle = useCallback(
    (/** @type {string} */ id) => {
      const next = !isCollapsed(id);
      store.set(COLLAPSE_KEY(id), next ? "1" : "0");
      setOverrides((o) => ({ ...o, [id]: next }));
    },
    [isCollapsed],
  );

  if (!config) return ps.error ? html`<${Unreachable} message=${ps.error} />` : html`<${Booting} />`;

  const backendStale = ps.lastPollAt > 0 && now - ps.lastPollAt > BACKEND_STALE_MS;
  /** @type {import("./model.js").ViewCtx} */
  const ctx = { settings: config.settings, now, backendStale, lastPollAt: ps.lastPollAt, locale };
  const tiles = flattenTiles(config.groups);
  const h = health(tiles, ps.snap, ctx);
  const summary = headerSummary(h, ps.snap !== null);
  const downIds = new Set(h.down.map((t) => t.id));
  const snap = ps.snap;
  const upIds = new Set(
    snap ? tiles.filter((t) => t.check !== "none" && snap.status[t.id]?.state === "up").map((t) => t.id) : [],
  );
  const mode = pageMode(config);
  const problems = allProblems(config);
  const warnings = warningCount(config);
  const bannerVisible = !!config.error && mode === "dashboard" && dismissedRev !== config.rev;

  const focusFirstProblem = () => {
    const target = h.down[0] ?? h.issues[0];
    if (!target) return;
    const path = groupPathOf(config.groups, target.id);
    setOverrides((o) => {
      const next = { ...o };
      for (const id of path) {
        next[id] = false;
        store.set(COLLAPSE_KEY(id), "0");
      }
      return next;
    });
    setTimeout(() => {
      const el = document.getElementById(tileDomId(target.id));
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "auto" });
      el.focus({ preventScroll: true });
    }, 0);
  };

  /** @type {{ text: string, onClick: () => void, expanded?: boolean } | null} */
  let chip = null;
  if (config.error && mode === "dashboard" && dismissedRev === config.rev) {
    chip = { text: "Config error", onClick: () => setDismissedRev(-1) };
  } else if (!config.error && warnings > 0) {
    chip = {
      text: `${warnings} config ${warnings === 1 ? "warning" : "warnings"}`,
      onClick: () => setProblemsOpen((o) => !o),
      expanded: problemsOpen,
    };
  }
  const showFooterToggle = problems.length > 0 && !bannerVisible && !chip && mode === "dashboard";

  return html`<div class="page">
    <${Header}
      title=${config.title}
      summary=${summary}
      onSummary=${focusFirstProblem}
      lastPollAt=${ps.lastPollAt}
      now=${now}
      stale=${backendStale}
      refreshBusy=${ps.refreshBusy}
      onRefresh=${() => poller.current?.refresh()}
      chip=${chip}
      announcement=${spoken}
      locale=${locale}
    />
    <main class="main">
      ${bannerVisible && config.error
        ? html`<${ConfigBanner}
            key=${config.rev}
            error=${config.error}
            loadedAt=${config.loadedAt}
            problemCount=${problems.length}
            problemsOpen=${problemsOpen}
            onToggleProblems=${() => setProblemsOpen((o) => !o)}
            onDismiss=${() => setDismissedRev(config.rev)}
            locale=${locale}
          />`
        : null}
      ${problemsOpen && problems.length > 0
        ? html`<${Problems} problems=${problems} onClose=${() => setProblemsOpen(false)} />`
        : null}
      ${config.sampleInUse && !welcomeDismissed && mode !== "fatal"
        ? html`<${Welcome}
            title=${config.title}
            configPath=${config.configPath}
            onDismiss=${() => {
              store.set(WELCOME_KEY, "1");
              setWelcomeDismissed(true);
            }}
          />`
        : null}
      ${mode === "fatal" ? html`<${FatalError} error=${config.error} configPath=${config.configPath} />` : null}
      ${mode === "empty" ? html`<${Empty} configPath=${config.configPath} />` : null}
      ${mode === "dashboard"
        ? config.groups.map(
            (g) => html`<${Group}
              key=${g.id}
              group=${g}
              config=${config}
              snap=${ps.snap}
              ctx=${ctx}
              isCollapsed=${isCollapsed}
              onToggle=${onToggle}
              downIds=${downIds}
              upIds=${upIds}
            />`,
          )
        : null}
      ${showFooterToggle && !problemsOpen
        ? html`<p class="footer">
            <button type="button" class="text-btn" aria-controls="hl-problems" aria-expanded="false"
              onClick=${() => setProblemsOpen(true)}>Show all problems (${problems.length})</button>
          </p>`
        : null}
    </main>
    ${toast
      ? html`<${Toast}
          text=${toast.text}
          action=${toast.showProblems
            ? {
                label: "Show",
                onClick: () => {
                  setProblemsOpen(true);
                  setToast(null);
                },
              }
            : null}
          onClose=${() => setToast(null)}
        />`
      : null}
  </div>`;
}

const root = document.getElementById("app");
if (root) {
  root.textContent = "";
  render(html`<${App} />`, root);
}
