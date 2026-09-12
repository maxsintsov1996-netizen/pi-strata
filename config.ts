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
 * NOTE: the extension on/off mode is NOT a setting — it is per-session
 * state: off by default, enabled for the session with /strata-on (see
 * index.ts). A legacy `piStrata.enabled` field or PI_STRATA_ENABLED in a
 * settings file is ignored.
 *
 * Example (.pi/settings.json):
 *   {
 *     "piStrata": {
 *       "autoContinue": false,
 *       "hideAnchors": true
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
 /** Auto-continue the next plan step after step compaction. */
 autoContinue?: boolean;
 /** Hide STRATA marker anchors in the TUI transcript (display only). */
 hideAnchors?: boolean;
}

export interface StrataSettings {
 autoContinue: boolean;
 hideAnchors: boolean;
}

export const STRATA_DEFAULTS: StrataSettings = {
 autoContinue: true,
 hideAnchors: true,
};

const ENV = {
 autoContinue: "PI_STRATA_AUTO_CONTINUE",
 hideAnchors: "PI_STRATA_HIDE_ANCHORS",
} as const;

type JsonScalar = number | string | boolean | null;

/** Non-empty env value (undefined when unset or blank). */
function envValue(name: string): string | undefined {
 const v = process.env[name];
 return v === undefined || v.trim() === "" ? undefined : v;
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
  if (typeof s.autoContinue === "boolean") {
   merged.autoContinue = s.autoContinue;
  }
  if (typeof s.hideAnchors === "boolean") {
   merged.hideAnchors = s.hideAnchors;
  }
 }
 return merged;
}

/** Resolve the effective autoContinue: env > config > default. */
function resolveAutoContinue(cfgAuto: boolean | undefined): boolean {
 const envAuto = envValue(ENV.autoContinue);
 if (envAuto !== undefined) {
  return envAuto !== "0"; // legacy: only "0" disables
 }
 if (cfgAuto !== undefined) {
  return cfgAuto;
 }
 return STRATA_DEFAULTS.autoContinue;
}

/** Resolve the effective hideAnchors: env > config > default. */
function resolveHideAnchors(cfgHide: boolean | undefined): boolean {
 const envHide = envValue(ENV.hideAnchors);
 if (envHide !== undefined) {
  return envHide !== "0"; // only "0" disables
 }
 if (cfgHide !== undefined) {
  return cfgHide;
 }
 return STRATA_DEFAULTS.hideAnchors;
}

/**
 * Resolve effective settings with priority: env > config > default.
 */
export function resolveStrataSettings(
 cwd: string,
 globalSettingsPath?: string,
): StrataSettings {
 const cfg = readPiStrataConfig(cwd, globalSettingsPath);
 return {
  autoContinue: resolveAutoContinue(cfg.autoContinue),
  hideAnchors: resolveHideAnchors(cfg.hideAnchors),
 };
}
