// Fixture-backed stand-ins for the real services. server.ts wires these in
// until WS1 (config), WS2 (state) and WS6 (icons) replace them.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BootContext,
  ConfigService,
  IconRef,
  IconResponse,
  IconService,
  NormalisedConfig,
  PublicConfig,
  RefreshResult,
  StateService,
} from "../types.ts";
import { fixtureConfig, fixtureState, STUB_SCENARIOS } from "./stub-fixtures.ts";
import type { StubScenario } from "./stub-fixtures.ts";

export function parseScenario(value: string | undefined): StubScenario {
  return STUB_SCENARIOS.includes(value as StubScenario) ? (value as StubScenario) : "ok";
}

export function createStubConfigService(ctx: BootContext, scenario: StubScenario): ConfigService {
  const loadedAt = new Date().toISOString();
  const cfg: PublicConfig = fixtureConfig(scenario, 1, ctx.configPathDisplay, ctx.options.theme, loadedAt);
  return {
    async start() {
      ctx.log.warn(`Serving stub fixture data (scenario "${scenario}"); the config engine is not wired in yet`);
    },
    async stop() {},
    getPublic: () => cfg,
    getNormalised: (): NormalisedConfig | null => null,
    onChange: () => () => {},
  };
}

export function createStubStateService(_ctx: BootContext, now: () => Date = () => new Date()): StateService {
  const REFRESH_LIMIT_MS = 10_000;
  const REFRESH_DURATION_MS = 2_000;
  let lastRefresh = 0;
  return {
    async start() {},
    async stop() {},
    snapshot() {
      const t = now();
      return fixtureState(t, t.getTime() - lastRefresh < REFRESH_DURATION_MS);
    },
    noteViewer() {},
    requestRefresh(): RefreshResult {
      const t = now().getTime();
      const wait = lastRefresh + REFRESH_LIMIT_MS - t;
      if (wait > 0) return { accepted: false, retryAfterS: Math.ceil(wait / 1000) };
      lastRefresh = t;
      return { accepted: true };
    },
  };
}

/** Serves bundled mdi/si SVGs only; everything else is a 404 (UI shows the letter fallback). */
export function createStubIconService(nodeModulesDir: string): IconService {
  const NAME = /^[a-z0-9][a-z0-9-]{0,100}\.svg$/;
  const dirs: Partial<Record<string, string>> = {
    mdi: join(nodeModulesDir, "@mdi/svg/svg"),
    si: join(nodeModulesDir, "simple-icons/icons"),
  };
  return {
    async get(set, name): Promise<IconResponse | null> {
      const dir = dirs[set];
      if (!dir || !NAME.test(name)) return null;
      try {
        return { body: await readFile(join(dir, name)), contentType: "image/svg+xml" };
      } catch {
        return null;
      }
    },
    resolve(icon, serviceName): IconRef | undefined {
      const m = icon ? /^(mdi|si)-([a-z0-9-]+)$/.exec(icon) : null;
      if (m) return { kind: "proxied", src: `icons/${m[1]}/${m[2]}.svg` };
      const letter = serviceName.trim().charAt(0).toUpperCase();
      return letter ? { kind: "letter", letter } : undefined;
    },
  };
}
