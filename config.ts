/**
 * pi-strata — optional configuration.
 *
 * Settings live in pi's settings.json files under the `piStrata` key:
 *   global:  ~/.pi/agent/settings.json
 *   project: <project>/.pi/settings.json  (fields override global per-field)
 *
 * Priority (per field): environment (PI_STRATA_*) > config > default.
 * Invalid values at any level are ignored (fall through to the next level).
 *
 * Example (.pi/settings.json):
 *   {
 *     "piStrata": {
 *       "keepWipTokens": 8000,
 *       "wipThresholdPct": 25,
 *       "autoContinue": false
 *     }
 *   }
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Raw config shape (all fields optional). Values are decoded/validated
 * inside readPiStrataConfig, so a decoded config only ever holds valid
 * values (invalid fields are omitted).
 */
export interface StrataConfig {
  /** Tokens to keep on top of the WIP report. Positive number. */
  keepWipTokens?: number;
  /** Remaining-context percentage that arms WIP compaction. 1..100. */
  wipThresholdPct?: number;
  /** Auto-continue the next plan step after step compaction. */
  autoContinue?: boolean;
}

export interface StrataSettings {
  keepWipTokens: number;
  wipThresholdPct: number;
  autoContinue: boolean;
}

export const STRATA_DEFAULTS: StrataSettings = {
  keepWipTokens: 10_000,
  wipThresholdPct: 20,
  autoContinue: true,
};

const ENV = {
  keepWipTokens: "PI_STRATA_KEEP_WIP_TOKENS",
  wipThresholdPct: "PI_STRATA_WIP_THRESHOLD",
  autoContinue: "PI_STRATA_AUTO_CONTINUE",
} as const;

type JsonScalar = number | string | boolean | null;

/** Non-empty env value (undefined when unset or blank). */
function envValue(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v;
}

/** Positive finite number; optionally capped at `max`. Undefined otherwise. */
function asPositiveNumber(
  v: number | string | undefined,
  max?: number,
): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (max !== undefined && n > max) return undefined;
  return n;
}

/**
 * Read the `piStrata` key from global then project settings.json
 * (project fields win) and decode it: invalid field values are dropped,
 * so the result contains only valid values.
 */
export function readPiStrataConfig(
  cwd: string,
  globalSettingsPath?: string,
): StrataConfig {
  const files = [
    globalSettingsPath ?? join(getAgentDir(), "settings.json"),
    join(cwd, CONFIG_DIR_NAME, "settings.json"),
  ];
  const merged: StrataConfig = {};
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue; // no settings file at this location
    }
    const section = (raw as { piStrata?: unknown } | null)?.piStrata;
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      continue;
    }
    const s = section as Record<string, JsonScalar>;
    const keepWipTokens = asPositiveNumber(s.keepWipTokens as number | string);
    if (keepWipTokens !== undefined) merged.keepWipTokens = keepWipTokens;
    const wipThresholdPct = asPositiveNumber(
      s.wipThresholdPct as number | string,
      100,
    );
    if (wipThresholdPct !== undefined) merged.wipThresholdPct = wipThresholdPct;
    if (typeof s.autoContinue === "boolean") {
      merged.autoContinue = s.autoContinue;
    }
  }
  return merged;
}

/** Resolve the effective autoContinue: env > config > default. */
function resolveAutoContinue(cfgAuto: boolean | undefined): boolean {
  const envAuto = envValue(ENV.autoContinue);
  if (envAuto !== undefined) return envAuto !== "0"; // legacy: only "0" disables
  if (cfgAuto !== undefined) return cfgAuto;
  return STRATA_DEFAULTS.autoContinue;
}

/**
 * Resolve effective settings with priority: env > config > default.
 */
export function resolveStrataSettings(
  cwd: string,
  globalSettingsPath?: string,
): StrataSettings {
  const cfg = readPiStrataConfig(cwd, globalSettingsPath);

  const envTokens = envValue(ENV.keepWipTokens);
  const keepWipTokens =
    (envTokens === undefined ? undefined : asPositiveNumber(envTokens)) ??
    cfg.keepWipTokens ??
    STRATA_DEFAULTS.keepWipTokens;

  const envThreshold = envValue(ENV.wipThresholdPct);
  const wipThresholdPct =
    (envThreshold === undefined
      ? undefined
      : asPositiveNumber(envThreshold, 100)) ??
    cfg.wipThresholdPct ??
    STRATA_DEFAULTS.wipThresholdPct;

  return {
    keepWipTokens,
    wipThresholdPct,
    autoContinue: resolveAutoContinue(cfg.autoContinue),
  };
}
