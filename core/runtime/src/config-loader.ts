/**
 * @module @kb-labs/core-runtime/config-loader
 *
 * Shared platform config loader used by both the CLI bootstrap
 * (`@kb-labs/cli-bin`) and the canonical platform launcher.
 *
 * Responsibilities:
 *
 *  - Resolve `platformRoot` and `projectRoot` via `@kb-labs/core-workspace`.
 *    These are *two different logical roots* — see `resolveRoots` docs for
 *    the distinction.
 *
 *  - Load the layers of platform configuration (precedence, low to high,
 *    ADR-0047 / ADR-0012: generated < platform user < project user < overlays):
 *      0. Installer-GENERATED config from `<root>/.kb/generated/*.json|jsonc`
 *         (optional — absent until the installer generates config).
 *      1. Platform defaults from `<platformRoot>/.kb/kb.config.json`
 *         (optional — absent in solo dev mode).
 *      2. Project config from `<projectRoot>/.kb/kb.config.json`
 *         (optional — absent when running outside a project).
 *
 *  - Deep-merge the two layers (project overrides platform defaults) using
 *    `mergeDefined` from `@kb-labs/core-config`.
 *
 *  - Optionally load the `.env` file from `projectRoot`.
 *
 * This function deliberately does *not* call `initPlatform` — it only loads
 * and merges configuration. The caller is responsible for initializing the
 * platform with the result:
 *
 * ```ts
 * const { platformConfig, projectRoot } = await loadPlatformConfig({
 *   moduleUrl: import.meta.url,
 *   startDir: process.cwd(),
 * })
 * await initPlatform(platformConfig, projectRoot, uiProvider)
 * ```
 *
 * Keeping load and init separate makes the function trivially testable: we
 * can assert on the merged config without touching the global platform
 * singleton.
 */

import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  readJsonWithDiagnostics,
  mergeWithFieldPolicy,
  mergeDefined,
  loadGeneratedLayer,
  loadOverlays,
  mergeOverlay,
  validateProductConfig,
  type Diagnostic,
  type FieldMergePolicy,
} from "@kb-labs/core-config";
import { resolveRoots, type RootsResolution } from "@kb-labs/core-workspace";

import { CONFIG_FIELD_SCOPE, type PlatformConfig } from "./config.js";
import { interpolateConfig } from "./config-interpolation.js";
import { applyLocalNetworkOffset } from "./config-net-offset.js";
import { PLATFORM_CONFIG_PRODUCT } from "./schema/platform-config-schema.js";

function expandPlatformDir(raw: string, projectRoot: string): string {
  let value = raw.trim();
  if (value.startsWith("~")) {
    value = path.join(os.homedir(), value.slice(1));
  }
  return path.resolve(projectRoot, value);
}

const CONFIG_RELATIVE_PATHS = [
  path.join(".kb", "kb.config.jsonc"),
  path.join(".kb", "kb.config.json"),
  "kb.config.jsonc",
  "kb.config.json",
] as const;

export interface LoadPlatformConfigOptions {
  /**
   * `import.meta.url` of the calling entrypoint (CLI bin or service entry).
   * Used to locate the installed `node_modules/@kb-labs/*` tree reliably in
   * installed mode. Optional — if omitted, falls back to marker walk-up from
   * `startDir`.
   */
  moduleUrl?: string;
  /**
   * Starting directory for project-root discovery. Defaults to
   * `process.cwd()`.
   */
  startDir?: string;
  /**
   * Environment variables map. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * When `true` (default), loads `<projectRoot>/.env` into `process.env`
   * before reading config. Does not override variables already set.
   */
  loadEnvFile?: boolean;
}

export interface LoadPlatformConfigResult {
  /**
   * Effective `platform` configuration: project config deep-merged on top of
   * platform defaults. Always defined — an empty object when neither layer
   * provides anything.
   */
  platformConfig: PlatformConfig;
  /**
   * Raw contents of the *project* config file, if one was found. Used by the
   * CLI to expose the full user-facing config via `useConfig()`.
   */
  rawConfig?: Record<string, unknown>;
  /**
   * Raw contents of the *platform* config file, if one was found and it is a
   * distinct file from the project config (split-root install). In
   * `sameLocation` mode this is the same object as `rawConfig` (one physical
   * file plays both roles). Top-level fields here that aren't part of
   * `PlatformConfig` (e.g. product sections like `services`) have no
   * `CONFIG_FIELD_SCOPE` policy and are never merged into `platformConfig` —
   * this is the only way callers (e.g. `kb config show`) can see
   * platform-owned product config that the project layer doesn't override.
   */
  rawPlatformConfig?: Record<string, unknown>;
  /**
   * Effective full config: `rawConfig` with `.kb/overlays/` applied. This is
   * what product config (`useConfig()` → getConfig) should read so scenario
   * overlays reach plugin config sections, not just the platform slice.
   */
  effectiveConfig?: Record<string, unknown>;
  /** Resolved platform root (where `node_modules/@kb-labs/*` lives). */
  platformRoot: string;
  /** Resolved project root (where `.kb/kb.config.json` lives). */
  projectRoot: string;
  /** `true` when both roots resolve to the same directory (dev mode). */
  sameLocation: boolean;
  /** Diagnostics about how each config layer was loaded. */
  sources: {
    /** Absolute path to platform defaults file, if one was loaded. */
    platformDefaults?: string;
    /** Absolute path to project config file, if one was loaded. */
    projectConfig?: string;
    /**
     * Absolute paths of installer-generated config files (`.kb/generated/`)
     * applied as the lowest-precedence layer, in merge order. Omitted when
     * the install has none.
     */
    generated?: string[];
    /** How each root was resolved. */
    roots: RootsResolution["sources"];
    /** Per-top-level-field provenance after policy merge. */
    fields?: Record<string, "platform" | "project" | "both">;
    /** Top-level fields where the project layer was rejected as platform-only. */
    ignoredProjectFields?: string[];
    /** Set when project config pointed to a different platformRoot via `platform.dir`. */
    platformDirOverride?: string;
    /**
     * Absolute paths of overlay files applied on top of the merged config, in
     * the order they were merged (lexicographic by file name). Empty/omitted
     * when `.kb/overlays/` is absent.
     */
    overlays?: string[];
    /**
     * Non-fatal diagnostics from the overlay loader: malformed JSONC files,
     * overlays with non-object top-level (`OVERLAY_NOT_OBJECT`), read errors.
     * Each entry corresponds to an overlay file that was found but skipped or
     * partially parsed — present here even though the rest of the load
     * completed. Empty/omitted when the overlay step produced no diagnostics.
     */
    overlayDiagnostics?: Diagnostic[];
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

export function loadEnvFromDirectory(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const envPath = path.join(dir, ".env");
  if (!existsSync(envPath)) {
    return;
  }
  try {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq === -1) {
        continue;
      }
      const key = trimmed.substring(0, eq).trim();
      const val = trimmed
        .substring(eq + 1)
        .trim()
        .replace(/^["'](.*?)["']$/, "$1")
        .replace(/^`(.*?)`$/, "$1");
      if (key && !(key in env)) {
        // process.env remains the process-wide compatibility target. Populate
        // a custom map as well for isolated hosts and tests.
        const effectiveValue = process.env[key] ?? val;
        env[key] = effectiveValue;
        if (!(key in process.env)) {
          process.env[key] = effectiveValue;
        }
      }
    }
  } catch {
    // Silently ignore — not critical for service operation.
  }
}

/**
 * Populate environment values derived by the platform itself.
 *
 * Services, CLI hosts and compatibility launchers must share the same socket
 * namespace derivation.
 */
export function ensurePlatformEnvironment(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.KB_SOCKET_HASH) {
    return;
  }

  const hashRoot = env.KB_PROJECT_ROOT ?? projectRoot;
  env.KB_SOCKET_HASH = createHash("md5")
    .update(path.resolve(hashRoot))
    .digest("hex")
    .slice(0, 8);
}

/**
 * Look for a config file at `<root>/.kb/kb.config.json` or `<root>/kb.config.json`.
 * Returns `undefined` if neither exists.
 */
function findConfigAtRoot(root: string): string | undefined {
  for (const rel of CONFIG_RELATIVE_PATHS) {
    const full = path.join(root, rel);
    if (existsSync(full)) {
      return full;
    }
  }
  return undefined;
}

/**
 * Project a raw config object onto the `PlatformConfig` view: normalise the
 * `platform` string shorthand and fold top-level `adapterOptions` in.
 */
function toPlatformSection(
  data: Record<string, unknown> & {
    platform?: PlatformConfig | string;
    adapterOptions?: Partial<Record<string, unknown>>;
  },
): PlatformConfig | undefined {
  // Normalise the shorthand form produced by `kb-create` (installed mode),
  // where the top-level `platform` is a bare string pointing at the platform
  // directory instead of the structured `{ dir, adapters, ... }` object used
  // by the dev-mode monorepo. Treat the string as `{ dir: "…" }` so the
  // loader can still honour `platform.dir` without mis-parsing the section.
  const rawPlatform = data.platform;
  const normalizedPlatform: PlatformConfig | undefined =
    typeof rawPlatform === "string"
      ? { platform: { dir: rawPlatform } }
      : rawPlatform;

  // Merge top-level adapterOptions into the platform section so initPlatform
  // receives adapter credentials (e.g. llm.kbClientId) alongside adapter bindings.
  const platformSection: PlatformConfig | undefined = normalizedPlatform
    ? {
        ...normalizedPlatform,
        adapterOptions:
          data.adapterOptions ?? normalizedPlatform.adapterOptions,
      }
    : data.adapterOptions
      ? { adapters: {}, adapterOptions: data.adapterOptions }
      : undefined;

  return platformSection;
}

/**
 * Read a KB Labs config file and extract its `platform` section. Returns
 * `{ platformSection, rawConfig }` where either field may be `undefined` if
 * the file is missing, malformed, or has no `platform` section.
 *
 * `adapterOptions` lives at the top level of the config file (not inside
 * `platform`), so we merge it into the returned platformSection so that
 * initPlatform receives credentials and adapter-specific options.
 */
async function readConfigFile(configPath: string): Promise<{
  platformSection?: PlatformConfig;
  rawConfig?: Record<string, unknown>;
}> {
  const result = await readJsonWithDiagnostics<{
    platform?: PlatformConfig;
    adapterOptions?: Partial<Record<string, unknown>>;
    [k: string]: unknown;
  }>(configPath);

  if (!result.ok) {
    return {};
  }

  const data = result.data as Record<string, unknown> & {
    platform?: PlatformConfig | string;
    adapterOptions?: Partial<Record<string, unknown>>;
  };
  const platformSection = toPlatformSection(data);

  return {
    platformSection,
    rawConfig: data,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

/**
 * Load and merge platform configuration, returning the effective config plus
 * diagnostics about how it was resolved.
 *
 * Resolution flow:
 *   1. Resolve `platformRoot` and `projectRoot` via
 *      `@kb-labs/core-workspace/resolveRoots`.
 *   2. If `loadEnvFile !== false`, load `<projectRoot>/.env`.
 *   3. Read `<platformRoot>/.kb/kb.config.json` → `platformDefaults` (if any).
 *   4. Read `<projectRoot>/.kb/kb.config.json` → `projectConfig` (if any).
 *      When both roots resolve to the same directory (dev mode), the same
 *      file is used for both layers and is read only once.
 *   5. `effective = mergeDefined(platformDefaults ?? {}, projectConfig ?? {})`.
 *
 * The function never throws on missing files or malformed JSON — it silently
 * degrades to an empty config so that callers can continue with NoOp
 * adapters. Callers that need strict validation should inspect `sources`.
 */
export async function loadPlatformConfig(
  options: LoadPlatformConfigOptions = {},
): Promise<LoadPlatformConfigResult> {
  const {
    moduleUrl,
    startDir = process.cwd(),
    env = process.env,
    loadEnvFile: shouldLoadEnv = true,
  } = options;

  let roots = await resolveRoots({
    moduleUrl,
    startDir,
    env,
  });

  if (shouldLoadEnv) {
    // Precedence is process env > project .env > platform .env. The loader
    // never overwrites existing keys, so the higher-priority project layer
    // must be loaded first.
    loadEnvFromDirectory(roots.projectRoot, env);
    if (path.resolve(roots.platformRoot) !== path.resolve(roots.projectRoot)) {
      loadEnvFromDirectory(roots.platformRoot, env);
    }
  }

  // Derived platform environment belongs to the shared config/bootstrap path,
  // not individual service launchers. It must exist before interpolation.
  ensurePlatformEnvironment(roots.projectRoot, env);

  // Read project config first so we can honor `platform.dir` before picking
  // the platform-config file.
  const projectConfigPath = findConfigAtRoot(roots.projectRoot);
  let projectPlatformConfig: PlatformConfig | undefined;
  let rawProjectConfig: Record<string, unknown> | undefined;
  let projectConfigSource: string | undefined;
  let projectConfigData: Awaited<ReturnType<typeof readConfigFile>> | undefined;

  if (projectConfigPath) {
    projectConfigData = await readConfigFile(projectConfigPath);
    projectPlatformConfig = projectConfigData.platformSection;
    rawProjectConfig = projectConfigData.rawConfig;
    projectConfigSource = projectConfigPath;
  }

  // Honor `platform.dir` from the project config, if set. This lets a project
  // declare its own platform workspace instead of using the bootstrap-resolved
  // one. Guard against self-reference: if the override resolves to the same
  // path as the project root, we keep the original resolution.
  let platformDirOverride: string | undefined;
  // platform.dir may be at projectPlatformConfig.platform.dir (string-shorthand case, where
  // readConfigFile wraps it as { platform: { dir } }), OR at the top level as
  // projectPlatformConfig.dir (structured-object case, where the whole data.platform section
  // is spread into platformSection, leaving dir at the root).
  const declaredPlatformDir =
    projectPlatformConfig?.platform?.dir ??
    ((projectPlatformConfig as Record<string, unknown> | undefined)?.["dir"] as
      | string
      | undefined);
  if (declaredPlatformDir) {
    const resolved = expandPlatformDir(declaredPlatformDir, roots.projectRoot);
    if (path.resolve(resolved) !== path.resolve(roots.projectRoot)) {
      platformDirOverride = resolved;
      roots = {
        ...roots,
        platformRoot: resolved,
        sameLocation:
          path.resolve(resolved) === path.resolve(roots.projectRoot),
      };
    }
  }

  // Locate the platform config file AFTER honoring platform.dir.
  const platformConfigPath = findConfigAtRoot(roots.platformRoot);
  let platformDefaults: PlatformConfig | undefined;
  let platformDefaultsSource: string | undefined;
  let rawPlatformConfig: Record<string, unknown> | undefined;

  const samePath =
    !!platformConfigPath &&
    !!projectConfigPath &&
    path.resolve(platformConfigPath) === path.resolve(projectConfigPath);

  if (samePath && projectConfigData) {
    // Single file plays both roles (dev mode). Treat its contents as
    // platform defaults so policy-merge doesn't strip platform-only fields
    // like `adapters`. Project layer is left undefined — the merge is a
    // no-op and `sources.projectConfig` is the only reported source.
    platformDefaults = projectConfigData.platformSection;
    rawPlatformConfig = projectConfigData.rawConfig;
    projectPlatformConfig = undefined;
  } else if (platformConfigPath) {
    const { platformSection, rawConfig } =
      await readConfigFile(platformConfigPath);
    platformDefaults = platformSection;
    rawPlatformConfig = rawConfig;
    platformDefaultsSource = platformConfigPath;
  }

  // Generated layer (ADR-0047): installer-written `.kb/generated/*.json|jsonc`
  // is the lowest-precedence baseline, under BOTH user layers. It is folded
  // into the platform defaults so every user value (platform or project) wins
  // over it, and it is absent (no-op) for installs that do not generate config.
  const generatedLayer = await loadGeneratedLayer([
    roots.platformRoot,
    roots.projectRoot,
  ]);
  if (generatedLayer.files.length > 0) {
    const generatedSection = toPlatformSection(generatedLayer.data);
    if (generatedSection) {
      platformDefaults = mergeDefined(generatedSection, platformDefaults ?? {});
    }
  }

  // Policy-aware merge: platform-only fields reject project overrides;
  // mergeable fields deep-merge with project winning.
  const mergeResult = mergeWithFieldPolicy<PlatformConfig>(
    platformDefaults,
    projectPlatformConfig,
    CONFIG_FIELD_SCOPE as Partial<
      Record<keyof PlatformConfig, FieldMergePolicy>
    >,
  );

  // Ensure `adapters` is always defined so callers can destructure safely.
  let merged: PlatformConfig = {
    adapters: {},
    ...mergeResult.value,
  };

  // Apply overlay layer (`.kb/overlays/*.jsonc`) — the final, highest-priority
  // layer. Used by e2e scenarios and ad-hoc tweaks; absent in normal projects.
  // Overlay semantics differ from the platform↔project merge: arrays replace
  // by default, with opt-in append via the `kb:merge` directive.
  const overlayResult = await loadOverlays(roots.projectRoot);
  const appliedOverlays: string[] = [];
  for (const overlay of overlayResult.overlays) {
    merged = mergeOverlay(merged, overlay.data);
    appliedOverlays.push(overlay.path);
  }

  // Effective FULL config = the raw project config with the same overlays
  // applied. `merged`/`platformConfig` above is the platform slice; product
  // sections (e.g. `mind`) are read via getConfig() from this full config, so
  // overlays must reach it too — otherwise scenario overlays only affect
  // platform fields and plugin config silently ignores them.
  let effectiveConfig = rawProjectConfig;
  if (generatedLayer.files.length > 0) {
    // Generated product sections sit under the user's project config.
    effectiveConfig = mergeDefined(
      generatedLayer.data,
      rawProjectConfig ?? {},
    );
  }
  if (effectiveConfig && overlayResult.overlays.length > 0) {
    let acc = effectiveConfig;
    for (const overlay of overlayResult.overlays) {
      acc = mergeOverlay(acc as never, overlay.data as never) as Record<
        string,
        unknown
      >;
    }
    effectiveConfig = acc;
  }

  // Validate the post-overlay structure. Catches gross breakage (overlay sets
  // `adapters: "string"`) early, before the platform tries to use the config.
  // The schema is intentionally permissive on sub-properties — it only guards
  // the top-level shape.
  const validation = validateProductConfig(PLATFORM_CONFIG_PRODUCT, merged);
  if (!validation.ok) {
    const detail =
      validation.errors
        ?.map((e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`)
        .join("; ") ?? "unknown validation error";
    throw new Error(
      `Platform config is invalid after applying overlays (${appliedOverlays.length} overlay(s)): ${detail}`,
    );
  }

  // Resolve ${ENV_VAR} placeholders in string values (e.g. baseURL, urls, secrets
  // that live in env vars rather than config files). Non-strict outside
  // production so a missing var leaves the placeholder intact and fails
  // lazily at use-site rather than blocking bootstrap for unrelated adapters.
  // Strict in production: a cloud deployment with a missing secret must crash
  // at boot, not serve traffic with an unresolved `${VAR}` baked into config
  // (see docs/adr/0037-containers-are-canonical-cloud-delivery.md).
  const strictInterpolation = env.NODE_ENV === "production";
  const effective = applyLocalNetworkOffset(
    interpolateConfig(merged, strictInterpolation, env),
    env,
  );

  return {
    platformConfig: effective,
    rawConfig: rawProjectConfig,
    rawPlatformConfig,
    effectiveConfig,
    platformRoot: roots.platformRoot,
    projectRoot: roots.projectRoot,
    sameLocation: roots.sameLocation,
    sources: {
      platformDefaults: platformDefaultsSource,
      projectConfig: projectConfigSource,
      generated:
        generatedLayer.files.length > 0
          ? generatedLayer.files.map((file) => file.path)
          : undefined,
      roots: roots.sources,
      fields: mergeResult.sources,
      ignoredProjectFields:
        mergeResult.ignoredProjectFields.length > 0
          ? mergeResult.ignoredProjectFields
          : undefined,
      platformDirOverride,
      overlays: appliedOverlays.length > 0 ? appliedOverlays : undefined,
      overlayDiagnostics:
        overlayResult.diagnostics.length > 0
          ? overlayResult.diagnostics
          : undefined,
    },
  };
}
