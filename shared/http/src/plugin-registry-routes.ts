import { createReadStream, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  ManifestV3,
  RegistrySnapshot,
  StudioPluginEntryV2,
  StudioRegistryV2,
} from '@kb-labs/plugin-contracts';

export interface PluginRegistryManifestEntry {
  pluginId: string;
  manifest: ManifestV3;
  pluginRoot: string;
  source: RegistrySnapshot['manifests'][number]['source'];
  discoveredAt: string;
  buildTimestamp?: string;
  validation: { valid: boolean; errors: string[] };
}

export interface PluginRegistryResponse {
  manifests: PluginRegistryManifestEntry[];
  apiBasePath: string;
  diagnostics: {
    total: number;
    items: Array<{
      severity: string;
      code: string;
      reasonCode: string;
      message: string;
      pluginId?: string;
      filePath?: string;
      remediation?: string;
      ts: string;
    }>;
  };
}

export interface PluginRegistryRoutesOptions {
  /** Resolves the catalog snapshot on every request so refreshed discovery is visible. */
  getSnapshot: () => RegistrySnapshot | Promise<RegistrySnapshot>;
  /** API prefix owned by this service, e.g. `/api/v1`. */
  apiBasePath: string;
  /** Public URL prefix used by Studio widgets. Defaults to `/plugins`. */
  widgetsBasePath?: string;
  /** Register raw README and changelog routes for each discovered plugin. Defaults to true. */
  includePluginDocs?: boolean;
  /** Wrap JSON success responses, for example with the host `{ok,data}` envelope. */
  sendSuccess?: (reply: FastifyReply, value: unknown) => unknown;
  /** Map internal failures to the owning service's public error contract. */
  sendFailure?: (reply: FastifyReply, error: unknown) => unknown;
  /** Preserve the owning catalog's manifest validation report. */
  validateManifest?: (manifest: ManifestV3) => { valid: boolean; errors: string[] };
}

function routePath(basePath: string, suffix: string): string {
  return `${basePath.replace(/\/$/, '')}/${suffix.replace(/^\//, '')}`;
}

function diagnosticReasonCode(code: string): string {
  switch (code) {
    case 'MANIFEST_NOT_FOUND': return 'manifest_missing';
    case 'MANIFEST_VALIDATION_ERROR':
    case 'MANIFEST_PARSE_ERROR': return 'manifest_invalid';
    case 'MANIFEST_LOAD_TIMEOUT': return 'manifest_load_timeout';
    case 'INTEGRITY_MISMATCH': return 'integrity_mismatch';
    default: return 'plugin_discovery_failed';
  }
}

function remoteEntryVersion(widgetBundleDir: string): string {
  try {
    return String(Math.floor(statSync(join(widgetBundleDir, 'remoteEntry.js')).mtimeMs));
  } catch {
    return '0';
  }
}

export function manifestToStudioRegistryEntry(
  manifest: ManifestV3,
  pluginRoot: string,
  widgetsBasePath = '/plugins',
): StudioPluginEntryV2 | null {
  const studio = manifest.studio;
  if (!studio || studio.version !== 2) return null;

  const widgetBundleDir = join(pluginRoot, 'dist', 'widgets');
  return {
    pluginId: manifest.id,
    ...(manifest.display?.name ? { displayName: manifest.display.name } : {}),
    pluginVersion: manifest.version,
    remoteName: studio.remoteName,
    remoteEntryUrl: `${widgetsBasePath.replace(/\/$/, '')}/${manifest.id}/widgets/remoteEntry.js?v=${remoteEntryVersion(widgetBundleDir)}`,
    pages: studio.pages ?? [],
    menus: studio.menus ?? [],
  };
}

export function buildStudioRegistry(
  snapshot: RegistrySnapshot,
  widgetsBasePath = '/plugins',
): StudioRegistryV2 {
  return {
    schema: 'kb.studio/2',
    schemaVersion: 2,
    generatedAt: snapshot.generatedAt,
    plugins: snapshot.manifests.flatMap(({ manifest, pluginRoot }) => {
      const entry = manifestToStudioRegistryEntry(manifest, pluginRoot, widgetsBasePath);
      return entry ? [entry] : [];
    }),
  };
}

export async function buildPluginRegistryResponse(
  snapshot: RegistrySnapshot,
  apiBasePath: string,
  validateManifest: PluginRegistryRoutesOptions['validateManifest'] = () => ({ valid: true, errors: [] }),
): Promise<PluginRegistryResponse> {
  const manifests = await Promise.all(snapshot.manifests.map(async (entry) => {
    let buildTimestamp: string | undefined;
    try {
      buildTimestamp = (await stat(join(entry.pluginRoot, 'dist'))).mtime.toISOString();
    } catch {
      // A source-only plugin can still appear in the catalog.
    }
    return {
      pluginId: entry.pluginId,
      manifest: entry.manifest,
      pluginRoot: entry.pluginRoot,
      source: entry.source,
      discoveredAt: snapshot.generatedAt,
      ...(buildTimestamp ? { buildTimestamp } : {}),
      validation: validateManifest(entry.manifest),
    };
  }));

  return {
    manifests,
    apiBasePath,
    diagnostics: {
      total: snapshot.diagnostics?.length ?? 0,
      items: (snapshot.diagnostics ?? []).map((diagnostic) => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        reasonCode: diagnosticReasonCode(diagnostic.code),
        message: diagnostic.message,
        ...(diagnostic.context?.pluginId ? { pluginId: diagnostic.context.pluginId } : {}),
        ...(diagnostic.context?.filePath ? { filePath: diagnostic.context.filePath } : {}),
        ...(diagnostic.remediation ? { remediation: diagnostic.remediation } : {}),
        ts: new Date(diagnostic.ts).toISOString(),
      })),
    },
  };
}

const MIME: Record<string, string> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
};

export async function registerPluginRegistryRoutes(
  server: FastifyInstance,
  options: PluginRegistryRoutesOptions,
): Promise<void> {
  const widgetsBasePath = options.widgetsBasePath ?? '/plugins';
  const sendSuccess = options.sendSuccess ?? ((_reply, value) => value);
  const sendFailure = options.sendFailure ?? ((reply, error) => reply.code(500).send({
    error: 'Failed to load plugin registry',
    message: error instanceof Error ? error.message : String(error),
  }));

  server.get(routePath(options.apiBasePath, 'plugins/registry'), async (_request, reply) => {
    try {
      const snapshot = await options.getSnapshot();
      const registry = await buildPluginRegistryResponse(snapshot, options.apiBasePath, options.validateManifest);
      return sendSuccess(reply, registry);
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  server.get(routePath(options.apiBasePath, 'studio/registry'), async (_request, reply) => {
    try {
      return sendSuccess(reply, buildStudioRegistry(await options.getSnapshot(), widgetsBasePath));
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  for (const name of options.includePluginDocs === false ? [] : ['readme', 'changelog'] as const) {
    server.get<{ Params: { scope: string; name: string } }>(
      routePath(options.apiBasePath, `plugins/@:scope/:name/${name}`),
      { config: { ux: 'raw' }, schema: { hide: true } },
      async (request, reply) => {
        const pluginId = `@${request.params.scope}/${request.params.name}`;
        const entry = (await options.getSnapshot()).manifests.find((item) => item.pluginId === pluginId);
        if (!entry) return reply.code(404).send({ error: `Plugin not found: ${pluginId}` });
        const filePath = join(entry.pluginRoot, name === 'readme' ? 'README.md' : 'CHANGELOG.md');
        try {
          const content = await readFile(filePath, 'utf8');
          return reply.type('text/plain; charset=utf-8').send(content);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return reply.code(404).send({ error: `${name === 'readme' ? 'README.md' : 'CHANGELOG.md'} not found` });
          }
          return sendFailure(reply, error);
        }
      },
    );
  }

  server.get<{ Params: { scope: string; name: string; '*': string } }>(
    `${widgetsBasePath.replace(/\/$/, '')}/@:scope/:name/widgets/*`,
    { config: { ux: 'raw' }, schema: { hide: true } },
    async (request, reply) => {
      const filePath = request.params['*'];
      if (!filePath) return reply.code(400).send({ error: 'Invalid path' });
      const pluginId = `@${request.params.scope}/${request.params.name}`;
      const entry = (await options.getSnapshot()).manifests.find((item) =>
        item.pluginId === pluginId && item.manifest.studio?.version === 2,
      );
      if (!entry) return reply.code(404).send({ error: `No widget bundle for ${pluginId}` });

      const bundleRoot = resolve(entry.pluginRoot, 'dist', 'widgets');
      const target = resolve(bundleRoot, filePath);
      const relativePath = relative(bundleRoot, target);
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        return reply.code(400).send({ error: 'Invalid path' });
      }
      try {
        const fileStat = await stat(target);
        if (!fileStat.isFile()) return reply.code(404).send({ error: 'Widget file not found' });
        const isEntry = filePath === 'remoteEntry.js';
        return reply
          .type(MIME[extname(target)] ?? 'application/octet-stream')
          .header('Content-Length', fileStat.size)
          .header('Cache-Control', isEntry
            ? 'public, max-age=10, must-revalidate'
            : process.env.NODE_ENV === 'production'
              ? 'public, max-age=31536000, immutable'
              : 'no-cache')
          .send(createReadStream(target));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.code(404).send({ error: `Widget file not found: ${pluginId}/widgets/${filePath}` });
        }
        return sendFailure(reply, error);
      }
    },
  );
}
