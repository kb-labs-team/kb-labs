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
 *  - Load platform-owned config layers (precedence, low to high): plugin
 *    manifest defaults < generated platform config < platform user config <
 *    project store < project store overlays.
 *
 *  - Never consult the consumer repository for KB configuration files.
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
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  readJsonWithDiagnostics,
  mergeWithFieldPolicy,
  mergeDefined,
  loadGeneratedLayer,
  loadOverlays,
  mergeOverlay,
  readProjectSettings,
  projectOverlaysPath,
  projectSettingsPath,
  PluginSettingsSchemaLoadError,
  JsoncSyntaxError,
  resolvePluginSettingsValidator,
  validateProductConfig,
  type Diagnostic,
  type FieldMergePolicy,
  interpolateConfig,
} from "@kb-labs/core-config";
import { createHealthContributor, openCatalog } from '@kb-labs/core-registry';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import { findRegisteredProjectRoot, resolveRoots, type RootsResolution } from "@kb-labs/core-workspace";
import { canonicalizeProjectPath, createProjectRegistry, ProjectRegistryError } from "@kb-labs/core-project-registry";
import { AdapterProjectScopeError, PlatformConfigError, registerProcessSensitiveValues } from "@kb-labs/core-platform";

import { CONFIG_FIELD_SCOPE, type PlatformConfig } from "./config.js";
import { requireProjectContext } from "./project-context.js";
import { applyLocalNetworkOffset } from "./config-net-offset.js";
import { isWorkspaceDevelopmentMode } from "./platform-mode.js";
import { resolvePlatformVersion } from './platform-version.js';
import { PLATFORM_CONFIG_PRODUCT } from "./schema/platform-config-schema.js";
import type { PlatformContainer } from './container.js';

function collectDeclaredSecretValues(
  value: unknown,
  secretFields: ReadonlySet<string>,
  parentField?: string,
  output: string[] = [],
): string[] {
  if (typeof value === 'string') {
    if (parentField && secretFields.has(parentField)) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectDeclaredSecretValues(entry, secretFields, parentField, output);
    return output;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      collectDeclaredSecretValues(nested, secretFields, key, output);
    }
  }
  return output;
}

const CONFIG_RELATIVE_PATHS = [
  path.join(".kb", "kb.config.jsonc"),
  path.join(".kb", "kb.config.json"),
  "kb.config.jsonc",
  "kb.config.json",
] as const;

export interface LoadPlatformConfigOptions {
  /** Load platform configuration without resolving a current project. */
  projectScope?: 'required' | 'platform';
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
  /** Registry-selected project identity, supplied by the platform launcher. */
  projectId?: string;
  /**
   * When `true` (default), loads `<projectRoot>/.env` into `process.env`
   * before reading config. Does not override variables already set.
   */
  loadEnvFile?: boolean;
  /** Execution health is provided by a host after its runtime has initialized. */
  executionHealth?: () => Promise<Awaited<ReturnType<PlatformContainer['executionBackend']['health']>>>;
  catalog?: IEntityRegistry;
  persistCatalogSnapshot?: boolean;
}

interface LoadPlatformConfigResultBase {
  /** Resolved catalog opened for this process scope and reused by initialization. */
  catalog: IEntityRegistry;
  /**
   * Effective `platform` configuration: project config deep-merged on top of
   * platform defaults. Always defined — an empty object when neither layer
   * provides anything.
   */
  platformConfig: PlatformConfig;
  /**
   * Raw contents of the platform config file, if one was found.
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
   * Effective full config with project settings and platform-owned overlays.
   * This is
   * what product config (`useConfig()` → getConfig) should read so scenario
   * overlays reach plugin config sections, not just the platform slice.
   */
  effectiveConfig?: Record<string, unknown>;
  /** Manifest settings defaults in plugin config namespace. */
  pluginSettingsDefaults?: Array<{
    pluginId: string;
    configSection: string;
    manifestPath: string;
    data: Record<string, unknown>;
  }>;
  /** Resolved platform root (where `node_modules/@kb-labs/*` lives). */
  platformRoot: string;
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
    /**
     * Absolute paths of overlay files applied on top of the merged config, in
     * the order they were merged (lexicographic by file name). Empty/omitted
     * when the platform-owned project overlay directory is absent.
     */
    overlays?: string[];
    /** Non-error diagnostics from overlay loading. Error diagnostics reject the load. */
    overlayDiagnostics?: Diagnostic[];
  };
}

export type LoadPlatformConfigResult = LoadPlatformConfigResultBase & (
  | { projectScope: 'required'; projectRoot: string }
  | { projectScope: 'platform'; projectRoot?: string }
);

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
  // loader can parse the platform section consistently.
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

function throwConfigDiagnostic(
  diagnostic: { code: string; message: string; detail?: unknown; path?: string },
  fallbackPath: string,
): never {
  const reason = diagnostic.code.includes('PARSE')
    ? 'parse'
    : diagnostic.code.includes('READ')
      ? 'read'
      : 'invalid';
  const detail = typeof diagnostic.detail === 'string' ? diagnostic.detail : diagnostic.message;
  throw new PlatformConfigError(diagnostic.path ?? fallbackPath, reason, detail);
}

function throwFirstConfigError(
  diagnostics: readonly { level?: string; code: string; message: string; detail?: unknown; path?: string }[],
  fallbackPath: string,
): void {
  const diagnostic = diagnostics.find((entry) => entry.level === 'error');
  if (diagnostic) {
    throwConfigDiagnostic(diagnostic, fallbackPath);
  }
}

/**
 * Read a KB Labs config file and extract its `platform` section. Returns
 * `{ platformSection, rawConfig }` where the config section may be `undefined`
 * when a present valid file has no `platform` section. Missing files are
 * handled by the caller; unreadable, malformed, and invalid files are errors.
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
    throwFirstConfigError(result.diagnostics, configPath);
    throw new PlatformConfigError(configPath, 'invalid', 'Config reader returned no data or diagnostic.');
  }

  if (typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) {
    throw new PlatformConfigError(configPath, 'invalid', 'Top-level configuration value must be an object.');
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

async function loadPluginSettingsDefaults(
  catalog: IEntityRegistry,
): Promise<NonNullable<LoadPlatformConfigResult['pluginSettingsDefaults']>> {
  const discovery = catalog.discovery();
  const packages = new Map(discovery.plugins.map((plugin) => [plugin.id, plugin]));
  const defaults: NonNullable<LoadPlatformConfigResult['pluginSettingsDefaults']> = [];

  for (const [pluginId, manifest] of discovery.manifests) {
    if (!manifest.configSection || !manifest.settings) continue;
    const plugin = packages.get(pluginId);
    if (!plugin) {
      throw new PluginSettingsSchemaLoadError(
        `Plugin "${pluginId}" settings schema has no discovered package location.`,
        undefined,
        pluginId,
      );
    }
    const validator = await resolvePluginSettingsValidator(manifest.settings.schema, plugin.packageRoot, pluginId);
    const data = manifest.settings.defaults ?? {};
    const validation = validator.validate(data);
    if (!validation.valid) {
      throw new PluginSettingsSchemaLoadError(
        `Plugin "${pluginId}" declares invalid settings defaults: ${validation.cause}`,
        validation.cause,
        pluginId,
      );
    }
    defaults.push({
      pluginId,
      configSection: manifest.configSection,
      manifestPath: plugin.manifestPath,
      data,
    });
  }
  return defaults;
}

/**
 * Load and merge platform configuration, returning the effective config plus
 * diagnostics about how it was resolved.
 *
 * Resolution flow:
 *   1. Resolve `platformRoot` and `projectRoot` via
 *      `@kb-labs/core-workspace/resolveRoots`.
 *   2. If `loadEnvFile !== false`, load `<projectRoot>/.env`.
 *   3. Read the platform config from `<platformRoot>`.
 *   4. Read project settings and overlays from `$KB_HOME/state/<projectId>`.
 *      The consumer repository is not a configuration source.
 *   5. `effective = mergeDefined(platformDefaults ?? {}, projectConfig ?? {})`.
 *
 * Missing config layers are valid and contribute no overrides. A present but
 * unreadable, malformed, or invalid file throws `PlatformConfigError`; callers
 * must render that failure instead of starting with a different config.
 */
export function loadPlatformConfig(
  options: LoadPlatformConfigOptions & { projectScope: 'platform' },
): Promise<LoadPlatformConfigResultBase & { projectScope: 'platform'; projectRoot?: string }>;
export function loadPlatformConfig(
  options?: LoadPlatformConfigOptions & { projectScope?: 'required' },
): Promise<LoadPlatformConfigResultBase & { projectScope: 'required'; projectRoot: string }>;
export function loadPlatformConfig(
  options: LoadPlatformConfigOptions,
): Promise<LoadPlatformConfigResult>;
export async function loadPlatformConfig(
  options: LoadPlatformConfigOptions = {},
): Promise<LoadPlatformConfigResult> {
  const {
    moduleUrl,
    startDir = process.cwd(),
    env = process.env,
    loadEnvFile: shouldLoadEnv = true,
    projectScope = 'required',
  } = options;

  if (projectScope === 'required' && options.projectId) {
    const registry = createProjectRegistry({ env });
    const registered = await registry.get(options.projectId);
    const requestedPath = await canonicalizeProjectPath(startDir);
    const resolvedProjectRoot = await findRegisteredProjectRoot(startDir, env);
    if (registered.project.path !== resolvedProjectRoot) {
      throw new ProjectRegistryError(
        { code: 'KB_PROJECT_RUNTIME_IDENTITY_MISMATCH', details: { projectId: options.projectId } },
        `Runtime project ${options.projectId} was started for "${requestedPath}" but the registry maps it to "${registered.project.path}".`,
      );
    }
  }

  const roots = await resolveRoots({
    moduleUrl,
    startDir,
    env,
    projectScope,
  });
  const configRoot = projectScope === 'platform'
    ? roots.platformRoot
    : requireProjectContext(roots.projectRoot, startDir);
  const projectId = options.projectScope === 'platform' ? undefined : options.projectId ?? env.KB_PROJECT_ID;

  if (shouldLoadEnv) {
    if (projectScope === 'required') {
      // Precedence is process env > project .env > platform .env. The loader
      // never overwrites existing keys, so the higher-priority project layer
      // must be loaded first.
      loadEnvFromDirectory(configRoot, env);
    }
    if (projectScope === 'platform' || path.resolve(roots.platformRoot) !== path.resolve(configRoot)) {
      loadEnvFromDirectory(roots.platformRoot, env);
    }
  }

  // Derived platform environment belongs to the shared config/bootstrap path,
  // not individual service launchers. It must exist before interpolation.
  ensurePlatformEnvironment(configRoot, env);

  // Project settings are platform-owned. Only platform-root config files are
  // read here; repository `.kb/kb.config.*` files are intentionally ignored.
  const projectConfigPath = findConfigAtRoot(roots.platformRoot);
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

  // The launcher owns the platform root; config cannot replace it.
  const platformConfigPath = findConfigAtRoot(roots.platformRoot);
  let platformDefaults: PlatformConfig | undefined;
  let platformDefaultsSource: string | undefined;
  let rawPlatformConfig: Record<string, unknown> | undefined;
  let containerConfigOverlay: Record<string, unknown> = {};

  const samePath =
    !!platformConfigPath &&
    !!projectConfigPath &&
    path.resolve(platformConfigPath) === path.resolve(projectConfigPath);

  if (!samePath && (
      projectConfigData?.rawConfig?.adapters !== undefined ||
      projectConfigData?.rawConfig?.adapterOptions !== undefined ||
      projectPlatformConfig?.adapters !== undefined ||
      projectPlatformConfig?.adapterOptions !== undefined
  )) {
    throw new AdapterProjectScopeError();
  }

  if (samePath && projectConfigData) {
    // A development workspace's single config file is platform-owned.
    platformDefaults = projectConfigData.platformSection;
    rawPlatformConfig = projectConfigData.rawConfig;
    platformDefaultsSource = projectConfigPath;
    projectConfigSource = undefined;
    projectPlatformConfig = undefined;
  } else if (platformConfigPath) {
    const { platformSection, rawConfig } =
      await readConfigFile(platformConfigPath);
    platformDefaults = platformSection;
    rawPlatformConfig = rawConfig;
    platformDefaultsSource = platformConfigPath;
  }

  // Container delivery can mount a topology-owned overlay without replacing
  // the release image's baked composition. The standard config remains the
  // base; this file is an explicit higher-precedence layer owned by the
  // container composition producer (currently Helm).
  const containerConfigOverlayPath = path.join(roots.platformRoot, '.kb', 'kb.config.override.json');
  if (existsSync(containerConfigOverlayPath)) {
    const { platformSection, rawConfig } = await readConfigFile(containerConfigOverlayPath);
    platformDefaults = mergeDefined(platformDefaults ?? {}, platformSection ?? {});
    containerConfigOverlay = rawConfig ?? {};
  }

  // Generated layer (ADR-0047): installer-written `.kb/generated/*.json|jsonc`
  // is the lowest-precedence baseline, under BOTH user layers. It is folded
  // into the platform defaults so every user value (platform or project) wins
  // over it, and it is absent (no-op) for installs that do not generate config.
  const generatedLayer = await loadGeneratedLayer([roots.platformRoot]);
  throwFirstConfigError(generatedLayer.diagnostics, roots.platformRoot);
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

  // Apply project store overlays as the final, highest-priority layer.
  // Overlay semantics differ from the platform↔project merge: arrays replace
  // by default, with opt-in append via the `kb:merge` directive.
  const overlaysPath = projectId ? projectOverlaysPath({ projectId, env }) : undefined;
  const overlayResult = overlaysPath
    ? await loadOverlays(overlaysPath)
    : { overlays: [], diagnostics: [] };
  if (overlaysPath) {
    throwFirstConfigError(overlayResult.diagnostics, overlaysPath);
  }
  let projectSettings: Record<string, unknown> = {};
  if (projectId) {
    const settingsPath = projectSettingsPath({ projectId, env });
    try {
      projectSettings = await readProjectSettings({ projectId, env });
    } catch (error) {
      if (error instanceof PlatformConfigError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      const reason = error instanceof JsoncSyntaxError
        ? 'parse'
        : error !== null && typeof error === 'object' && 'code' in error
          ? 'read'
          : 'invalid';
      throw new PlatformConfigError(settingsPath, reason, detail);
    }
  }
  const projectPlatformSettings = projectSettings.platform;
  if (projectSettings.adapters !== undefined || projectSettings.adapterOptions !== undefined ||
      (projectPlatformSettings !== null && typeof projectPlatformSettings === 'object' && !Array.isArray(projectPlatformSettings) &&
        ((projectPlatformSettings as Record<string, unknown>).adapters !== undefined ||
          (projectPlatformSettings as Record<string, unknown>).adapterOptions !== undefined))) {
    throw new AdapterProjectScopeError();
  }
  if (overlayResult.overlays.some(overlay =>
    overlay.data.adapters !== undefined || overlay.data.adapterOptions !== undefined)) {
    throw new AdapterProjectScopeError();
  }
  const appliedOverlays: string[] = [];
  for (const overlay of overlayResult.overlays) {
    merged = mergeOverlay(merged, overlay.data);
    appliedOverlays.push(overlay.path);
  }

  const workspaceDevelopment = isWorkspaceDevelopmentMode({
    sameLocation: roots.sameLocation,
    rawConfig: rawProjectConfig,
    rawPlatformConfig,
  });
  const catalog = options.catalog ?? await openCatalog({
    platformRoot: roots.platformRoot,
    projectRoot: projectScope === 'platform' ? roots.platformRoot : configRoot,
  }, {
    resolvePlatformVersion: () => resolvePlatformVersion(roots.platformRoot, {
      sameLocation: roots.sameLocation,
      rawConfig: rawProjectConfig,
      rawPlatformConfig,
    }),
    ...(options.persistCatalogSnapshot !== undefined ? { persistSnapshot: options.persistCatalogSnapshot } : {}),
    ...(options.executionHealth ? {
      healthContributors: [createHealthContributor('execution', options.executionHealth)],
    } : {}),
    ...(workspaceDevelopment ? { workspaceAdapters: {
      development: true,
      workspaceRoot: roots.platformRoot,
      configuredPackages: [],
      discoverAll: true,
    } } : {}),
  });
  const pluginSettingsDefaults = await loadPluginSettingsDefaults(catalog);
  const defaultsData: Record<string, unknown> = {
    plugins: Object.fromEntries(pluginSettingsDefaults.map(({ configSection, data }) => [configSection, data])),
  };
  // Effective full config applies defaults, generated config, the selected
  // base config, then the delivery overlay, project settings, and scenario
  // overlays. Keep the delivery layer independent of root layout.
  let effectiveConfig: Record<string, unknown> = mergeOverlay(
    defaultsData,
    mergeOverlay(
      generatedLayer.data,
      rawProjectConfig ?? rawPlatformConfig ?? {},
    ),
  );
  effectiveConfig = mergeOverlay(effectiveConfig, containerConfigOverlay);
  if (projectId) {
    effectiveConfig = mergeOverlay(effectiveConfig, projectSettings);
  }
  for (const overlay of overlayResult.overlays) {
    effectiveConfig = mergeOverlay(effectiveConfig, overlay.data);
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
    const invalidPath = appliedOverlays.at(-1) ?? projectConfigSource ?? platformDefaultsSource ?? roots.platformRoot;
    throw new PlatformConfigError(
      invalidPath,
      'invalid',
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
  const adapterManifests = catalog.adapters();
  const secretValues: string[] = [];
  for (const [slot, binding] of Object.entries(effective.adapters ?? {})) {
    const packageNames = Array.isArray(binding) ? binding : typeof binding === 'string' ? [binding] : [];
    for (const packageName of packageNames) {
      const adapter = [...adapterManifests.values()].find((entry) =>
        entry.id === packageName || (entry.manifest.kind === 'adapter' && entry.manifest.manifest.id === packageName),
      );
      if (!adapter || adapter.manifest.kind !== 'adapter') continue;
      const secretFields = new Set(
        Object.entries(adapter.manifest.manifest.configSchema ?? {})
          .filter(([, schema]) => schema.secret === true)
          .map(([field]) => field),
      );
      if (secretFields.size > 0) {
        const options = effective.adapterOptions?.[slot as keyof NonNullable<PlatformConfig['adapterOptions']>];
        secretValues.push(...collectDeclaredSecretValues(options, secretFields));
      }
    }
  }
  registerProcessSensitiveValues(secretValues);

  const workspaceRootIsConfigRoot = samePath && isWorkspaceDevelopmentMode({
    sameLocation: roots.sameLocation,
    rawConfig: rawProjectConfig,
    rawPlatformConfig,
  });
  const resolvedProjectRoot = roots.projectRoot ?? (workspaceRootIsConfigRoot ? roots.platformRoot : undefined);
  const sameLocation = roots.sameLocation || (workspaceRootIsConfigRoot && resolvedProjectRoot === roots.platformRoot);
  const result: LoadPlatformConfigResultBase = {
    catalog,
    platformConfig: effective,
    rawConfig: rawProjectConfig,
    rawPlatformConfig,
    effectiveConfig,
    pluginSettingsDefaults,
    platformRoot: roots.platformRoot,
    sameLocation,
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
      overlays: appliedOverlays.length > 0 ? appliedOverlays : undefined,
      overlayDiagnostics:
        overlayResult.diagnostics.length > 0
          ? overlayResult.diagnostics
          : undefined,
    },
  };
  if (projectScope === 'platform') {
    return { ...result, projectScope, projectRoot: resolvedProjectRoot };
  }
  return { ...result, projectScope, projectRoot: configRoot };
}
