/** Safe loader for declared plugin manifests. */

import { declaredManifestPath, ENTITY_MANIFEST_KINDS, manifestKindFromSchema } from '@kb-labs/core-platform';
import { isManifestV3, type ManifestV3 } from '@kb-labs/plugin-contracts';
import type { DiagnosticCollector } from './diagnostics.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const RECOGNIZED_SCHEMAS = Object.keys(ENTITY_MANIFEST_KINDS).join(', ');

const DEFAULT_IMPORT_TIMEOUT_MS = 5_000;
class ManifestImportTimeoutError extends Error {
  constructor(filePath: string, timeoutMs: number) {
    super(`Import timeout after ${timeoutMs}ms: ${filePath}`);
    this.name = 'ManifestImportTimeoutError';
  }
}

export interface LoadedManifest {
  manifest: ManifestV3;
  manifestPath: string;
  kind: 'static' | 'module';
  packageName?: string;
  inputs: { path: string; digest: string }[];
}

export type ManifestLoadResult =
  | { kind: 'manifest'; loaded: LoadedManifest }
  | { kind: 'not-plugin'; packageName?: string }
  | { kind: 'failed'; cause: string; manifestPath?: string };

export function resolveDeclaredManifestPath(packageRoot: string, manifestField: string): { manifestPath: string; escapesRoot: boolean } {
  const root = path.resolve(packageRoot);
  const manifestPath = path.resolve(root, manifestField);
  const relative = path.relative(root, manifestPath);
  return { manifestPath, escapesRoot: relative.startsWith('..') || path.isAbsolute(relative) };
}

async function safeImport(filePath: string, timeoutMs: number): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      import(pathToFileURL(filePath).href) as Promise<Record<string, unknown>>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ManifestImportTimeoutError(filePath, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(
  diag: DiagnosticCollector,
  pluginId: string,
  filePath: string,
  code: 'MANIFEST_PARSE_ERROR' | 'MANIFEST_VALIDATION_ERROR' | 'MANIFEST_LOAD_TIMEOUT',
  message: string,
  cause?: unknown,
): ManifestLoadResult {
  const timeout = code === 'MANIFEST_LOAD_TIMEOUT';
  diag.error(code, message, {
    pluginId,
    filePath,
    stack: cause instanceof Error ? cause.stack : undefined,
    remediation: timeout
      ? 'Check for circular dependencies or blocking top-level await in the declared manifest module.'
      : 'Repair the declared manifest, then run "kb marketplace plugins doctor --scope <scope>".',
  });
  return { kind: 'failed', cause: message, manifestPath: filePath };
}

async function readManifestJson(
  filePath: string,
  pluginId: string,
  packageName: string | undefined,
  diag: DiagnosticCollector,
  required: boolean,
): Promise<ManifestLoadResult | undefined> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error) {
    if (isMissingFile(error) && !required) return undefined;
    return failed(diag, pluginId, filePath, 'MANIFEST_PARSE_ERROR', `Failed to read manifest ${filePath}: ${errorMessage(error)}`, error);
  }
  const raw = bytes.toString('utf8');
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch (error) {
    return failed(diag, pluginId, filePath, 'MANIFEST_PARSE_ERROR', `Failed to parse manifest ${filePath}: ${errorMessage(error)}`, error);
  }
  const schemaKind = manifestKindFromSchema(candidate !== null && typeof candidate === 'object' && 'schema' in candidate ? candidate.schema : undefined);
  if (schemaKind === 'adapter' || schemaKind === 'service') {
    diag.info('MANIFEST_NOT_PLUGIN', `Manifest ${filePath} declares another KB Labs entity schema — skipping`, {
      pluginId,
      filePath,
    });
    return { kind: 'not-plugin', packageName };
  }
  if (schemaKind !== 'plugin' || !isManifestV3(candidate)) {
    const message = schemaKind === undefined
      ? `Manifest ${filePath} must declare a recognized schema (${RECOGNIZED_SCHEMAS})`
      : `Manifest ${filePath} is not a valid ManifestV3`;
    diag.error('MANIFEST_VALIDATION_ERROR', message, {
      pluginId,
      filePath,
      remediation: 'Ensure the manifest has schema "kb.plugin/3" and the required id and version fields.',
    });
    return { kind: 'failed', cause: message, manifestPath: filePath };
  }
  return { kind: 'manifest', loaded: { manifest: candidate, manifestPath: filePath, kind: 'static', packageName, inputs: [{ path: filePath, digest: createHash('sha256').update(bytes).digest('hex') }] } };
}

async function loadDeclaredModule(
  filePath: string,
  pluginId: string,
  packageName: string | undefined,
  diag: DiagnosticCollector,
  timeoutMs: number,
): Promise<ManifestLoadResult> {
  const staticPath = filePath.replace(/\.[cm]?js$/, '.json');
  if (staticPath !== filePath) {
    const staticResult = await readManifestJson(staticPath, pluginId, packageName, diag, false);
    if (staticResult) return staticResult;
  }
  try {
    const bytes = await fs.readFile(filePath);
    const mod = await safeImport(filePath, timeoutMs);
    const candidate = mod.manifest;
    if (candidate === undefined) {
      const message = `Declared manifest module ${filePath} must export a named "manifest"`;
      return failed(diag, pluginId, filePath, 'MANIFEST_VALIDATION_ERROR', message);
    }
    const kind = manifestKindFromSchema(candidate !== null && typeof candidate === 'object' && 'schema' in candidate ? candidate.schema : undefined);
    if (kind === 'adapter' || kind === 'service') {
      diag.info('MANIFEST_NOT_PLUGIN', `Declared manifest ${filePath} is not a plugin manifest — skipping`, {
        pluginId,
        filePath,
      });
      return { kind: 'not-plugin', packageName };
    }
    if (kind === 'plugin' && isManifestV3(candidate)) {
      return { kind: 'manifest', loaded: { manifest: candidate, manifestPath: filePath, kind: 'module', packageName, inputs: [{ path: filePath, digest: createHash('sha256').update(bytes).digest('hex') }] } };
    }
    const message = kind === undefined
      ? `Declared manifest module ${filePath} must declare a recognized schema (${RECOGNIZED_SCHEMAS})`
      : `Imported module ${filePath} does not export a valid ManifestV3`;
    return failed(diag, pluginId, filePath, 'MANIFEST_VALIDATION_ERROR', message);
  } catch (error) {
    const timeout = error instanceof ManifestImportTimeoutError;
    const code = timeout ? 'MANIFEST_LOAD_TIMEOUT' : 'MANIFEST_PARSE_ERROR';
    return failed(diag, pluginId, filePath, code, `Failed to import declared manifest ${filePath}: ${errorMessage(error)}`, error);
  }
}

/** Load a plugin only from package.json's kb.manifest or root kb.plugin.json. */
export async function loadManifestFile(
  packageRoot: string,
  diag: DiagnosticCollector,
  timeoutMs: number = DEFAULT_IMPORT_TIMEOUT_MS,
): Promise<ManifestLoadResult> {
  const root = path.resolve(packageRoot);
  const pluginId = path.basename(root);
  const pkgJsonPath = path.join(root, 'package.json');
  let packageName: string | undefined;
  let manifestField: string | undefined;
  let packageInput: { path: string; digest: string } | undefined;
  try {
    const packageBytes = await fs.readFile(pkgJsonPath);
    packageInput = { path: pkgJsonPath, digest: createHash('sha256').update(packageBytes).digest('hex') };
    const pkg = JSON.parse(packageBytes.toString('utf8')) as Record<string, unknown>;
    packageName = typeof pkg.name === 'string' ? pkg.name : undefined;
    manifestField = declaredManifestPath(pkg);
  } catch (error) {
    if (!isMissingFile(error)) {
      return failed(diag, pluginId, pkgJsonPath, 'MANIFEST_PARSE_ERROR', `Failed to read or parse package metadata at ${pkgJsonPath}: ${errorMessage(error)}`, error);
    }
  }

  if (manifestField) {
    const resolved = resolveDeclaredManifestPath(root, manifestField);
    if (resolved.escapesRoot) {
      return failed(diag, pluginId, resolved.manifestPath, 'MANIFEST_VALIDATION_ERROR', `Declared manifest path "${manifestField}" escapes package root — possible path traversal`);
    }
    const manifestPath = resolved.manifestPath;
    if (manifestPath.endsWith('.json')) {
      const result = await readManifestJson(manifestPath, pluginId, packageName, diag, true);
      if (result?.kind === 'manifest' && packageInput) result.loaded.inputs.unshift(packageInput);
      return result!;
    }
    const result = await loadDeclaredModule(manifestPath, pluginId, packageName, diag, timeoutMs);
    if (result.kind === 'manifest' && packageInput) result.loaded.inputs.unshift(packageInput);
    return result;
  }

  const kbPluginJsonPath = path.join(root, 'kb.plugin.json');
  const staticResult = await readManifestJson(kbPluginJsonPath, pluginId, packageName, diag, false);
  if (staticResult) {
    if (staticResult.kind === 'manifest' && packageInput) staticResult.loaded.inputs.unshift(packageInput);
    return staticResult;
  }

  diag.info('MANIFEST_NOT_PLUGIN', `Package ${root} does not declare kb.manifest or kb.plugin.json — skipping`, {
    pluginId,
    filePath: root,
  });
  return { kind: 'not-plugin', packageName };
}
