/** Safe loader for declared plugin manifests. */

import { declaredManifestPath, ENTITY_MANIFEST_KINDS, manifestKindFromSchema } from '@kb-labs/core-platform';
import { isManifestV3, type ManifestV3 } from '@kb-labs/plugin-contracts';
import type { DiagnosticCollector } from './diagnostics.js';
import * as path from 'node:path';
import { fs } from './recording-filesystem.js';

const RECOGNIZED_SCHEMAS = Object.keys(ENTITY_MANIFEST_KINDS).join(', ');

export interface LoadedManifest {
  manifest: ManifestV3;
  manifestPath: string;
  kind: 'static';
  packageName?: string;
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
    if (isMissingFile(error) && !required) {return undefined;}
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
  return { kind: 'manifest', loaded: { manifest: candidate, manifestPath: filePath, kind: 'static', packageName } };
}

async function loadDeclaredModuleArtifact(
  filePath: string,
  pluginId: string,
  packageName: string | undefined,
  diag: DiagnosticCollector,
): Promise<ManifestLoadResult> {
  const extension = path.extname(filePath);
  if (!['.js', '.mjs', '.cjs'].includes(extension)) {
    const message = `Declared manifest ${filePath} must point to JSON data or a built .js, .mjs, or .cjs manifest artifact`;
    return failed(diag, pluginId, filePath, 'MANIFEST_VALIDATION_ERROR', message);
  }
  const staticPath = path.join(path.dirname(filePath), 'manifest.json');
  return (await readManifestJson(staticPath, pluginId, packageName, diag, true))!;
}

/** Load a plugin only from package.json's kb.manifest or root kb.plugin.json. */
export async function loadManifestFile(
  packageRoot: string,
  diag: DiagnosticCollector,
): Promise<ManifestLoadResult> {
  const root = path.resolve(packageRoot);
  const pluginId = path.basename(root);
  const pkgJsonPath = path.join(root, 'package.json');
  let packageName: string | undefined;
  let manifestField: string | undefined;
  try {
    const packageBytes = await fs.readFile(pkgJsonPath);
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
      return result!;
    }
    const result = await loadDeclaredModuleArtifact(manifestPath, pluginId, packageName, diag);
    return result;
  }

  const kbPluginJsonPath = path.join(root, 'kb.plugin.json');
  const staticResult = await readManifestJson(kbPluginJsonPath, pluginId, packageName, diag, false);
  if (staticResult) {
    return staticResult;
  }

  diag.info('MANIFEST_NOT_PLUGIN', `Package ${root} does not declare kb.manifest or kb.plugin.json — skipping`, {
    pluginId,
    filePath: root,
  });
  return { kind: 'not-plugin', packageName };
}
