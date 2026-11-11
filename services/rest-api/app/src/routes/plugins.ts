import { noBodySchema, withUxErrorResponses } from './route-schema.js';
/**
 * @module @kb-labs/rest-api-app/routes/plugins
 * Plugin routes registration
 *
 * Uses @kb-labs/plugin-execution for unified execution layer.
 */

import type { FastifyInstance } from "fastify";
import type { RestApiConfig } from "@kb-labs/rest-api-core";
import type { IEntityRegistry, RegistrySnapshot } from '@kb-labs/plugin-contracts';
import type { ManifestV3 } from "@kb-labs/plugin-contracts";
import { resolvePluginBasePath, validateManifest } from "@kb-labs/plugin-contracts";
import { mountRoutes } from "@kb-labs/plugin-execution/http";
import {
  mountEventStreams,
  mountWebSocketChannels,
} from "@kb-labs/plugin-execution";
import { combineManifestsToRegistry, manifestToRegistryEntry } from "@kb-labs/rest-api-core";
import { platform } from "@kb-labs/core-runtime";
import {
  logDiagnosticEvent,
  type DiagnosticLogLevel,
} from "@kb-labs/core-platform";
import type { DiagnosticReasonCode } from "@kb-labs/core-contracts";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ReadinessState } from "./readiness";
import { resolveWorkspaceRoot } from "@kb-labs/core-workspace";
import {
  metricsCollector,
  restDomainOperationMetrics,
} from "../middleware/metrics.js";
import { performance } from "node:perf_hooks";

interface SnapshotManifestEntry {
  pluginId: string;
  manifest: ManifestV3;
  pluginRoot: string;
  scope: RegistrySnapshot["manifests"][number]["scope"];
}

function extractSnapshotManifests(
  snapshot: RegistrySnapshot,
): SnapshotManifestEntry[] {
  return (snapshot.manifests || []).map((entry) => ({
    pluginId: entry.pluginId,
    manifest: entry.manifest,
    pluginRoot: entry.pluginRoot,
    scope: entry.scope,
  }));
}

/**
 * Register plugin routes
 */
export async function registerPluginRoutes(
  server: FastifyInstance,
  config: RestApiConfig,
  repoRoot: string,
  registry: IEntityRegistry,
  readiness?: ReadinessState,
): Promise<void> {
  const gatewayTimeoutMs = config.timeouts?.requestTimeout ?? 30_000;
  // Stats aggregated from sequential mount results
  const stats = {
    mountedRoutes: 0,
    mountedChannels: 0,
    errors: 0,
  };

  if (readiness) {
    readiness.pluginRoutesMounted = false;
    readiness.pluginMountInProgress = true;
    readiness.pluginRoutesCount = 0;
    readiness.pluginRouteErrors = 0;
    readiness.pluginRouteFailures = [];
    readiness.pluginRoutesLastDurationMs = null;
  }

  metricsCollector.resetPluginRouteBudgets();

  const mountMetrics = metricsCollector.beginPluginMount();
  const mountStart = performance.now();

  try {
    const workspaceResolution = await resolveWorkspaceRoot({
      startDir: repoRoot,
      env: {
        // KB_PROJECT_ROOT is the canonical var injected by kb-dev into service processes.
        // Must be included here: passing a partial env object would silently drop it, causing
        // ctx.cwd to fall back to the platform dir (kb-platform333) instead of the user's
        // project dir when services are started via kb-dev start.
        KB_PROJECT_ROOT: process.env.KB_PROJECT_ROOT,
        KB_HOME: process.env.KB_HOME,
        KB_LABS_WORKSPACE_ROOT: process.env.KB_LABS_WORKSPACE_ROOT,
        KB_LABS_REPO_ROOT: process.env.KB_LABS_REPO_ROOT,
      },
    });
    const workspaceRoot = workspaceResolution.rootDir;
    platform.logger.info("Resolved workspace root", {
      repoRoot,
      workspaceRoot,
      source: workspaceResolution.source,
    });

    const snapshot = registry.snapshot();
    const manifests = extractSnapshotManifests(snapshot);

    // Log discovery summary
    platform.logger.info("Plugin discovery summary", {
      totalManifests: manifests.length,
      rev: snapshot.rev,
      partial: snapshot.partial,
      stale: snapshot.stale,
      plugins: manifests.map((e) => ({
        id: e.manifest.id,
        restRoutes: e.manifest.rest?.routes?.length ?? 0,
        wsChannels: e.manifest.ws?.channels?.length ?? 0,
      })),
    });

    if (snapshot.partial || snapshot.stale) {
      if (snapshot.partial) {
        logDiagnosticEvent(platform.logger, {
          domain: "registry",
          event: "plugin.registry.snapshot",
          level: "warn",
          reasonCode: "snapshot_partial",
          message: "Registry snapshot is partial",
          outcome: "failed",
          serviceId: "rest",
          evidence: {
            rev: snapshot.rev,
            generatedAt: snapshot.generatedAt,
          },
        });
      }

      if (snapshot.stale) {
        logDiagnosticEvent(platform.logger, {
          domain: "registry",
          event: "plugin.registry.snapshot",
          level: "warn",
          reasonCode: "snapshot_stale",
          message: "Registry snapshot is stale",
          outcome: "failed",
          serviceId: "rest",
          evidence: {
            rev: snapshot.rev,
            generatedAt: snapshot.generatedAt,
            expiresAt: snapshot.expiresAt,
          },
        });
      }
    }

    emitRegistrySnapshotDiagnostics(snapshot);

    // Every REST plane uses the single backend initialized by the platform.
    const backend = platform.executionBackend;
    const wsBackend = backend;

    // Filter plugins that have routes, realtime streams or channels to mount
    const mountableManifests = manifests.filter(
      (entry) =>
        ((entry.manifest.rest?.routes &&
          entry.manifest.rest.routes.length > 0) ||
        (entry.manifest.sse?.streams &&
          entry.manifest.sse.streams.length > 0) ||
        (entry.manifest.ws?.channels && entry.manifest.ws.channels.length > 0)),
    );

    platform.logger.info("Plugins selected for route mounting", {
      mountable: mountableManifests.length,
      skipped: manifests.length - mountableManifests.length,
      mountablePlugins: mountableManifests.map((e) => e.manifest.id),
    });

    // ── Phase 1: Batch-validate all handler files in one I/O pass ──
    // Collect all handler file paths across all plugins, then validate in a single Promise.all()
    // This avoids interleaved fs.access() calls that caused race conditions with parallel mounting.
    //
    // Handler paths in manifests are relative to the plugin's dist/ directory, because manifests
    // are loaded from dist/manifest.js. pluginRoot points to the package root, so we resolve
    // handlers relative to pluginRoot/dist/ to match where the compiled files actually live.
    const handlerChecks: Array<{ key: string; filePath: string }> = [];
    for (const entry of mountableManifests) {
      if (entry.manifest.rest?.routes) {
        for (const route of entry.manifest.rest.routes) {
          const handlerFile = route.handler.split("#")[0];
          if (handlerFile) {
            const pluginDistRoot = path.join(entry.pluginRoot, "dist");
            const handlerPath = path.resolve(pluginDistRoot, handlerFile);
            handlerChecks.push({
              key: `${entry.manifest.id}::${route.method} ${route.path}`,
              filePath: handlerPath,
            });
          }
        }
      }
      if (entry.manifest.sse?.streams) {
        for (const stream of entry.manifest.sse.streams) {
          const handlerFile = stream.handler.split("#")[0];
          if (handlerFile) {
            const pluginDistRoot = path.join(entry.pluginRoot, "dist");
            handlerChecks.push({
              key: `${entry.manifest.id}::SSE ${stream.path}`,
              filePath: path.resolve(pluginDistRoot, handlerFile),
            });
          }
        }
      }
    }

    const handlerAccessResults = await Promise.all(
      handlerChecks.map(async (check) => {
        try {
          await fs.access(check.filePath);
          return { key: check.key, filePath: check.filePath, exists: true };
        } catch {
          return { key: check.key, filePath: check.filePath, exists: false };
        }
      }),
    );

    // Build lookup: "pluginId::METHOD /path" → { exists, filePath }
    const handlerExistsMap = new Map<
      string,
      { exists: boolean; filePath: string }
    >();
    for (const result of handlerAccessResults) {
      handlerExistsMap.set(result.key, {
        exists: result.exists,
        filePath: result.filePath,
      });
    }

    platform.logger.debug("Batch handler file validation completed", {
      totalHandlers: handlerChecks.length,
      validHandlers: handlerAccessResults.filter((r) => r.exists).length,
      invalidHandlers: handlerAccessResults.filter((r) => !r.exists).length,
    });

    // ── Phase 2: Sequential plugin mounting ──
    // Routes are registered in-memory on Fastify (~0.1ms per route).
    // Sequential mounting eliminates race conditions with zero performance cost.
    let mountedRoutes = 0;
    let mountedChannels = 0;
    let errors = 0;
    const succeeded: string[] = [];
    const failed: string[] = [];
    const routeFailures: Array<{ id: string; error: string }> = [];

    for (const entry of mountableManifests) {
      const { manifest, pluginRoot } = entry;
      const pluginDistRoot = path.join(pluginRoot, "dist");

      // Validate routes using pre-built handler map (no I/O here)
      const restValidationErrors: string[] = [];
      if (manifest.rest?.routes) {
        for (const route of manifest.rest.routes) {
          const handlerFile = route.handler.split("#")[0];
          if (!handlerFile) {
            restValidationErrors.push(
              `Route ${route.method} ${route.path}: Invalid handler reference "${route.handler}"`,
            );
            continue;
          }
          const lookupKey = `${manifest.id}::${route.method} ${route.path}`;
          const check = handlerExistsMap.get(lookupKey);
          if (check && !check.exists) {
            restValidationErrors.push(
              `Route ${route.method} ${route.path}: Handler file not found: ${check.filePath}`,
            );
          }
        }
      }
      if (manifest.sse?.streams) {
        for (const stream of manifest.sse.streams) {
          const handlerFile = stream.handler.split("#")[0];
          if (!handlerFile) {
            restValidationErrors.push(
              `Event stream ${stream.path}: Invalid handler reference "${stream.handler}"`,
            );
            continue;
          }
          const check = handlerExistsMap.get(
            `${manifest.id}::SSE ${stream.path}`,
          );
          if (check && !check.exists) {
            restValidationErrors.push(
              `Event stream ${stream.path}: Handler file not found: ${check.filePath}`,
            );
          }
        }
      }

      if (restValidationErrors.length > 0) {
        const reasonCode = inferRouteValidationReasonCode(restValidationErrors);
        logDiagnosticEvent(platform.logger, {
          event: "plugin.routes.validation",
          level: resolveRouteValidationLogLevel(
            restValidationErrors,
            manifest.rest?.routes?.length ?? 0,
          ),
          reasonCode,
          message: "Plugin route validation failed",
          outcome: "failed",
          pluginId: manifest.id,
          pluginVersion: manifest.version,
          serviceId: "rest",
          issues: restValidationErrors,
          remediation: "Verify handler file paths, exports, and route schema.",
          evidence: {
            pluginRoot,
            totalRoutes: manifest.rest?.routes?.length ?? 0,
          },
        });

        platform.logger.warn(
          "REST validation errors found, will skip problematic routes but continue mounting others",
          {
            plugin: `${manifest.id}@${manifest.version}`,
            pluginRoot,
            remediation: "Verify REST handler file and export exist",
            errors: restValidationErrors,
          },
        );

        const errorPaths = new Set(
          restValidationErrors
            .map((error) => {
              const match = error.match(/Route\s+(\w+)\s+([^\s:]+)/);
              return match ? `${match[1]} ${match[2]}` : null;
            })
            .filter(Boolean),
        );

        const validRoutes = (manifest.rest?.routes ?? []).filter((route) => {
          const routeKey = `${route.method} ${route.path}`;
          return !errorPaths.has(routeKey);
        });

        const streamErrorPaths = new Set(
          restValidationErrors
            .map((error) => error.match(/Event stream\s+([^\s:]+)/)?.[1])
            .filter((value): value is string => Boolean(value)),
        );
        const validStreams = (manifest.sse?.streams ?? []).filter(
          (stream) => !streamErrorPaths.has(stream.path),
        );

        if (validRoutes.length === 0 && validStreams.length === 0) {
          restDomainOperationMetrics.recordOperation(
            "plugin.routes.mount",
            0,
            "error",
          );
          logDiagnosticEvent(platform.logger, {
            event: "plugin.routes.validation",
            level: "error",
            reasonCode,
            message: "All plugin routes failed validation; skipping plugin",
            outcome: "failed",
            pluginId: manifest.id,
            pluginVersion: manifest.version,
            serviceId: "rest",
            issues: restValidationErrors,
            evidence: {
              pluginRoot,
            },
          });
          errors += 1;
          failed.push(manifest.id);
          routeFailures.push({
            id: manifest.id,
            error: summarizeValidationErrors(restValidationErrors),
          });
          continue;
        }

        if (manifest.rest) {
          manifest.rest.routes = validRoutes;
        }
        if (manifest.sse) {
          manifest.sse.streams = validStreams;
        }
        platform.logger.info("Filtered routes, mounting valid ones", {
          plugin: `${manifest.id}@${manifest.version}`,
          totalRoutes:
            validRoutes.length + restValidationErrors.length,
          validRoutes: validRoutes.length,
          validStreams: validStreams.length,
          skippedRoutes: restValidationErrors.length,
        });
      }

      try {
        const start = performance.now();

        const pluginBasePath = resolvePluginBasePath(manifest, "rest", config.basePath);
        const sseBasePath = resolvePluginBasePath(manifest, "sse", config.basePath);

        platform.logger.info("Mounting plugin routes", {
          plugin: `${manifest.id}@${manifest.version}`,
          configBasePath: config.basePath,
          manifestBasePath: manifest.rest?.basePath,
          pluginBasePath,
          sseBasePath,
          pluginRoot,
          routes: manifest.rest?.routes?.length ?? 0,
          streams: manifest.sse?.streams?.length ?? 0,
        });

        await mountRoutes(server, manifest, {
          backend,
          pluginRoot: pluginDistRoot,
          workspaceRoot,
          basePath: pluginBasePath,
          defaultTimeoutMs: gatewayTimeoutMs,
        });

        let streamsCount = 0;
        if (manifest.sse?.streams && manifest.sse.streams.length > 0) {
          const streamsResult = await mountEventStreams(server, manifest, {
            backend: wsBackend,
            logger: platform.logger,
            serviceId: "rest",
            pluginRoot: pluginDistRoot,
            workspaceRoot,
            basePath: sseBasePath,
            defaultTimeoutMs:
              manifest.sse.defaults?.timeoutMs ?? gatewayTimeoutMs,
            defaultKeepAliveMs: manifest.sse.defaults?.keepAliveMs,
          });
          streamsCount = streamsResult.mounted;
          if (streamsResult.errors.length > 0) {
            platform.logger.warn("SSE stream mounting had errors", {
              plugin: `${manifest.id}@${manifest.version}`,
              errors: streamsResult.errors,
            });
          }
        }

        const duration = performance.now() - start;
        const routesCount = (manifest.rest?.routes?.length ?? 0) + streamsCount;

        for (const route of manifest.rest?.routes ?? []) {
          metricsCollector.registerRouteBudget(
            route.method,
            `${pluginBasePath}${route.path}`,
            route.timeoutMs ?? gatewayTimeoutMs,
            manifest.id,
          );
        }

        mountMetrics.recordSuccess(manifest.id, routesCount, duration);
        restDomainOperationMetrics.recordOperation(
          "plugin.routes.mount",
          duration,
          "ok",
        );

        for (const route of manifest.rest?.routes ?? []) {
          platform.logger.debug("Mounted route", {
            pluginId: manifest.id,
            "http.method": route.method,
            "http.route": `${pluginBasePath}${route.path}`,
            "plugin.handler": route.handler,
          });
        }

        platform.logger.info("Successfully mounted plugin routes", {
          plugin: `${manifest.id}@${manifest.version}`,
          pluginBasePath,
          routesCount,
          streamsCount,
          durationMs: Number(duration.toFixed(2)),
        });

        // Mount WebSocket channels if present
        let channelsCount = 0;
        if (manifest.ws?.channels && manifest.ws.channels.length > 0) {
          try {
            const wsStart = performance.now();
            const wsBasePath = resolvePluginBasePath(manifest, "ws", config.basePath);

            platform.logger.info("Mounting WebSocket channels", {
              plugin: `${manifest.id}@${manifest.version}`,
              wsBasePath,
              channels: manifest.ws.channels.length,
            });

            const wsResult = await mountWebSocketChannels(server, manifest, {
              backend: wsBackend,
              hostPlatform: platform,
              pluginRoot: pluginDistRoot,
              workspaceRoot,
              basePath: wsBasePath,
              defaultTimeoutMs:
                manifest.ws.defaults?.timeoutMs ?? gatewayTimeoutMs,
              defaultMaxMessageSize: manifest.ws.defaults?.maxMessageSize,
            });

            const wsDuration = performance.now() - wsStart;
            channelsCount = wsResult.mounted;

            if (wsResult.mounted > 0) {
              platform.logger.info("Successfully mounted WebSocket channels", {
                plugin: `${manifest.id}@${manifest.version}`,
                channels: wsResult.mounted,
                durationMs: Number(wsDuration.toFixed(2)),
              });
            }

            if (wsResult.errors.length > 0) {
              platform.logger.warn("WebSocket channel mounting had errors", {
                plugin: `${manifest.id}@${manifest.version}`,
                errors: wsResult.errors,
              });
            }
          } catch (wsError) {
            logDiagnosticEvent(platform.logger, {
              event: "plugin.ws.mount",
              level: "error",
              reasonCode: "ws_mount_failed",
              message: "Failed to mount plugin WebSocket channels",
              outcome: "failed",
              error:
                wsError instanceof Error ? wsError : new Error(String(wsError)),
              pluginId: manifest.id,
              pluginVersion: manifest.version,
              serviceId: "rest",
            });
            platform.logger.error(
              "Failed to mount WebSocket channels",
              wsError instanceof Error ? wsError : new Error(String(wsError)),
              { plugin: manifest.id },
            );
          }
        }

        mountedRoutes += routesCount;
        mountedChannels += channelsCount;
        succeeded.push(manifest.id);
      } catch (error) {
        mountMetrics.recordFailure(manifest.id, shortErrorMessage(error));
        restDomainOperationMetrics.recordOperation(
          "plugin.routes.mount",
          0,
          "error",
        );
        logDiagnosticEvent(platform.logger, {
          event: "plugin.routes.mount",
          level: "error",
          reasonCode: "route_mount_failed",
          message: "Failed to mount plugin routes",
          outcome: "failed",
          error: error instanceof Error ? error : new Error(String(error)),
          pluginId: manifest.id,
          pluginVersion: manifest.version,
          serviceId: "rest",
        });
        platform.logger.error(
          "Failed to mount plugin routes",
          error instanceof Error ? error : new Error(String(error)),
          { plugin: manifest.id },
        );
        errors += 1;
        failed.push(manifest.id);
        routeFailures.push({
          id: manifest.id,
          error: `rest_mount_failed ${shortErrorMessage(error)}`,
        });
      }
    }

    // Update stats and readiness
    stats.mountedRoutes = mountedRoutes;
    stats.mountedChannels = mountedChannels;
    stats.errors = errors;
    if (readiness) {
      readiness.pluginRouteFailures = routeFailures;
    }

    // Log summary
    platform.logger.info(
      "Sequential plugin route and WebSocket channel mounting completed",
      {
        total: mountableManifests.length,
        succeeded: succeeded.length,
        failed: failed.length,
        mountedRoutes,
        mountedChannels,
        errors,
      },
    );
  } catch (error) {
    logDiagnosticEvent(platform.logger, {
      domain: "registry",
      event: "plugin.discovery",
      level: "error",
      reasonCode: "plugin_discovery_failed",
      message: "Plugin discovery failed during route registration",
      outcome: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
      serviceId: "rest",
    });
    platform.logger.error(
      "Plugin discovery failed",
      error instanceof Error ? error : new Error(String(error)),
    );
    stats.errors += 1;
    if (readiness) {
      readiness.pluginRoutesCount = stats.mountedRoutes;
      readiness.pluginRouteErrors = stats.errors;
      readiness.pluginRoutesMounted = false;
      readiness.pluginMountInProgress = false;
      readiness.pluginRoutesLastDurationMs = null;
      readiness.pluginRouteFailures.push({
        id: "discovery",
        error: `rest_discovery_failed ${shortErrorMessage(error)}`,
      });
    }
    metricsCollector.completePluginMount(
      platform.logger as unknown as {
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
      },
    );
    return;
  }

  if (readiness) {
    readiness.pluginRoutesCount = stats.mountedRoutes;
    readiness.pluginRouteErrors = stats.errors;
    readiness.pluginRoutesMounted = stats.errors === 0;
    readiness.pluginMountInProgress = false;
    readiness.lastPluginMountTs = new Date().toISOString();
    readiness.pluginRoutesLastDurationMs = Number(
      (performance.now() - mountStart).toFixed(2),
    );
  }

  metricsCollector.completePluginMount(
    platform.logger as unknown as {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
    },
  );
}

/**
 * Register plugin snapshot endpoints for Studio
 */
export async function registerPluginSnapshotRoutes(
  server: FastifyInstance,
  config: RestApiConfig,
  registry: IEntityRegistry,
): Promise<void> {
  const basePath = config.basePath;

  server.post(`${basePath}/plugins/refresh`, { schema: { querystring: { type: 'object', additionalProperties: false }, body: noBodySchema, response: withUxErrorResponses({ 200: { type: 'object', properties: { ok: { const: true }, data: { type: 'object', properties: { rev: { type: 'integer' }, total: { type: 'integer' }, generatedAt: { type: 'string', format: 'date-time' }, partial: { type: 'boolean' }, stale: { type: 'boolean' } }, required: ['rev', 'total', 'generatedAt', 'partial', 'stale'], additionalProperties: false } }, required: ['ok', 'data'], additionalProperties: false } }) } }, async (_request, reply) => {
    try {
      await restDomainOperationMetrics.observeOperation(
        "plugin.registry.refresh",
        async () => {
          await registry.refresh();
        },
      );
      const snapshot = await restDomainOperationMetrics.observeOperation(
        "plugin.registry.snapshot",
        async () => registry.snapshot(),
      );
      emitRegistrySnapshotDiagnostics(snapshot);

      reply.type("application/json");
      return {
        ok: true,
        data: {
          rev: snapshot.rev,
          total: snapshot.plugins.length,
          generatedAt: snapshot.generatedAt,
          partial: snapshot.partial,
          stale: snapshot.stale,
        },
      };
    } catch (error) {
      logDiagnosticEvent(platform.logger, {
        domain: "registry",
        event: "plugin.registry.refresh",
        level: "error",
        reasonCode: "registry_refresh_failed",
        message: "Failed to refresh plugin registry",
        outcome: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
        serviceId: "rest",
      });
      platform.logger.error(
        "Failed to refresh plugin registry",
        error instanceof Error ? error : new Error(String(error)),
      );
      reply.code(500).send({
        ok: false,
        error: "Failed to refresh plugin registry",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Raw manifests endpoint for Studio/debug consumers
  server.get(`${basePath}/plugins/registry`, { schema: { querystring: { type: 'object', additionalProperties: false }, response: withUxErrorResponses({ 200: { type: 'object', properties: { manifests: { type: 'array', items: { type: 'object', properties: { pluginId: { type: 'string' }, manifest: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' } }, additionalProperties: true }, pluginRoot: { type: 'string' }, source: { type: 'object', properties: { kind: { type: 'string' }, packageName: { type: 'string' }, path: { type: 'string' } }, additionalProperties: true }, discoveredAt: { type: 'string', format: 'date-time' }, buildTimestamp: { type: 'string', format: 'date-time' }, validation: { type: 'object', properties: { valid: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } } }, required: ['valid', 'errors'], additionalProperties: true } }, required: ['pluginId', 'manifest', 'pluginRoot', 'source', 'discoveredAt', 'validation'], additionalProperties: true } }, apiBasePath: { type: 'string' }, diagnostics: { type: 'object', properties: { total: { type: 'integer' }, items: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, code: { type: 'string' }, reasonCode: { type: 'string' }, message: { type: 'string' }, pluginId: { type: 'string' }, filePath: { type: 'string' }, remediation: { type: 'string' }, ts: { type: 'string' } }, required: ['severity', 'code', 'reasonCode', 'message', 'ts'], additionalProperties: true } } }, required: ['total', 'items'], additionalProperties: true } }, required: ['manifests', 'apiBasePath', 'diagnostics'], additionalProperties: false } }) } }, async (_request, reply) => {
    try {
      const snapshot = await restDomainOperationMetrics.observeOperation(
        "plugin.registry.snapshot",
        async () => registry.snapshot(),
      );

      // Get build timestamps and validate manifests
      const manifestsWithTimestamps = await Promise.all(
        snapshot.manifests.map(async (entry) => {
          let buildTimestamp: string | undefined;
          try {
            const distPath = path.join(entry.pluginRoot, "dist");
            const stats = await fs.stat(distPath);
            buildTimestamp = stats.mtime.toISOString();
          } catch {
            // dist/ doesn't exist or not accessible, skip
          }

          // Validate manifest structure
          const validation = validateManifest(entry.manifest);

          return {
            pluginId: entry.pluginId,
            manifest: entry.manifest,
            pluginRoot: entry.pluginRoot,
            source: entry.source,
            discoveredAt: snapshot.generatedAt,
            buildTimestamp,
            validation: {
              valid: validation.valid,
              errors: validation.errors,
            },
          };
        }),
      );

      reply.type("application/json");
      return {
        manifests: manifestsWithTimestamps,
        apiBasePath: basePath,
        diagnostics: {
          total: snapshot.diagnostics?.length ?? 0,
          items: (snapshot.diagnostics ?? []).map((diagnostic) => ({
            severity: diagnostic.severity,
            code: diagnostic.code,
            reasonCode: mapRegistryDiagnosticReasonCode(diagnostic.code),
            message: diagnostic.message,
            pluginId: diagnostic.context?.pluginId,
            filePath: diagnostic.context?.filePath,
            remediation: diagnostic.remediation,
            ts: diagnostic.ts,
          })),
        },
      };
    } catch (error) {
      platform.logger.error(
        "Failed to get plugin registry",
        error instanceof Error ? error : new Error(String(error)),
      );
      reply.code(500).send({
        error: "Failed to load plugin registry",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Plugin README — serves README.md from plugin root directory
  server.get<{
    Params: { scope: string; name: string };
  }>(
    `${basePath}/plugins/@:scope/:name/readme`,
    {
      config: { ux: "raw" },
      schema: { hide: true },
    },
    async (request, reply) => {
      const { scope, name } = request.params;

      if (!scope || !name) {
        return reply.code(400).send({ error: "Invalid plugin identifier" });
      }

      const pluginId = `@${scope}/${name}`;
      const snapshot = registry.snapshot();
      const manifests = extractSnapshotManifests(snapshot);
      const entry = manifests.find((e) => e.pluginId === pluginId);

      if (!entry) {
        return reply.code(404).send({ error: `Plugin not found: ${pluginId}` });
      }

      const readmePath = path.join(entry.pluginRoot, "README.md");

      if (!readmePath.startsWith(entry.pluginRoot)) {
        return reply.code(400).send({ error: "Invalid path" });
      }

      try {
        const content = await fs.readFile(readmePath, "utf-8");
        return reply
          .code(200)
          .header("Content-Type", "text/plain; charset=utf-8")
          .send(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reply.code(404).send({ error: "README.md not found" });
        }
        return reply.code(500).send({ error: "Failed to read README.md" });
      }
    },
  );

  // Plugin Changelog — serves CHANGELOG.md from plugin root directory
  server.get<{
    Params: { scope: string; name: string };
  }>(
    `${basePath}/plugins/@:scope/:name/changelog`,
    {
      config: { ux: "raw" },
      schema: { hide: true },
    },
    async (request, reply) => {
      const { scope, name } = request.params;

      if (!scope || !name) {
        return reply.code(400).send({ error: "Invalid plugin identifier" });
      }

      const pluginId = `@${scope}/${name}`;
      const snapshot = registry.snapshot();
      const manifests = extractSnapshotManifests(snapshot);
      const entry = manifests.find((e) => e.pluginId === pluginId);

      if (!entry) {
        return reply.code(404).send({ error: `Plugin not found: ${pluginId}` });
      }

      const changelogPath = path.join(entry.pluginRoot, "CHANGELOG.md");

      if (!changelogPath.startsWith(entry.pluginRoot)) {
        return reply.code(400).send({ error: "Invalid path" });
      }

      try {
        const content = await fs.readFile(changelogPath, "utf-8");
        return reply
          .code(200)
          .header("Content-Type", "text/plain; charset=utf-8")
          .send(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reply.code(404).send({ error: "CHANGELOG.md not found" });
        }
        return reply.code(500).send({ error: "Failed to read CHANGELOG.md" });
      }
    },
  );

  // Studio Registry V2 — returns plugin pages and menus for Module Federation
  server.get(
    `${basePath}/studio/registry`,
    {
      config: { uxFixture: { validResult: 'error-envelope' } },
      schema: {
        tags: ["Studio"],
        summary: "Get Studio Registry V2 (plugin pages for Module Federation)",
        querystring: { type: 'object', additionalProperties: false },
        response: withUxErrorResponses({ 200: { type: 'object', properties: { version: { type: 'string' }, generatedAt: { type: 'string', format: 'date-time' }, plugins: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: true } } }, required: ['version', 'generatedAt', 'plugins'], additionalProperties: false } }),
      },
    },
    async (_request, reply) => {
      try {
        const snapshot = await restDomainOperationMetrics.observeOperation(
          "plugin.studio.registry",
          async () => registry.snapshot(),
        );
        const manifests = extractSnapshotManifests(snapshot);

        // Only plugins with studio V2 config
        const studioManifests = manifests
          .filter((entry) => entry.manifest.studio?.version === 2)
          .map((entry) => ({
            manifest: entry.manifest,
            pluginRoot: entry.pluginRoot,
          }));

        const studioRegistry = combineManifestsToRegistry(studioManifests);

        reply.type("application/json");
        return studioRegistry;
      } catch (error) {
        platform.logger.error(
          "Failed to generate studio registry",
          error instanceof Error ? error : new Error(String(error)),
        );
        reply.code(500).send({
          error: "Failed to generate studio registry",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  // Widget bundle static files — serves dist/widgets/ from plugin packages
  server.get<{
    Params: { scope: string; name: string; "*": string };
  }>(
    "/plugins/@:scope/:name/widgets/*",
    {
      config: { ux: "raw" },
      schema: { hide: true },
    },
    async (request, reply) => {
      const { scope, name } = request.params;
      const filePath = request.params["*"];

      if (!scope || !name || !filePath || filePath.includes("..")) {
        return reply.code(400).send({ error: "Invalid path" });
      }

      const pluginId = `@${scope}/${name}`;

      // Find the plugin's widgetBundleDir from registry
      const snapshot = registry.snapshot();
      const manifests = extractSnapshotManifests(snapshot);
      const entry = manifests.find(
        (e) => e.manifest.id === pluginId && e.manifest.studio?.version === 2,
      );

      if (!entry) {
        return reply
          .code(404)
          .send({ error: `No widget bundle for ${pluginId}` });
      }

      const { join, extname } = await import("node:path");
      const { createReadStream, existsSync, statSync } =
        await import("node:fs");

      const studioEntry = manifestToRegistryEntry(entry.manifest, entry.pluginRoot);
      if (!studioEntry) {
        return reply
          .code(404)
          .send({ error: `No widget bundle for ${pluginId}` });
      }

      const bundleDir = studioEntry.widgetBundleDir;
      const fullPath = join(bundleDir, filePath);

      if (!fullPath.startsWith(bundleDir)) {
        return reply.code(400).send({ error: "Invalid path" });
      }

      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        return reply
          .code(404)
          .send({
            error: `Widget file not found: ${pluginId}/widgets/${filePath}`,
          });
      }

      const MIME: Record<string, string> = {
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".map": "application/json",
      };

      const ext = extname(filePath);
      const isEntry = filePath === "remoteEntry.js";

      return reply
        .code(200)
        .header("Content-Type", MIME[ext] ?? "application/octet-stream")
        .header("Content-Length", statSync(fullPath).size)
        .header(
          "Cache-Control",
          isEntry
            ? "public, max-age=10, must-revalidate"
            : process.env.NODE_ENV === "production"
              ? "public, max-age=31536000, immutable"
              : "no-cache",
        )
        .send(createReadStream(fullPath));
    },
  );

  // Plugin registry health endpoint
  server.get(`${basePath}/plugins/health`, { schema: { querystring: { type: 'object', additionalProperties: false }, response: withUxErrorResponses({ 200: { type: 'object', properties: { healthy: { type: 'boolean' }, snapshot: { type: 'object', properties: { partial: { type: 'boolean' }, stale: { type: 'boolean' }, corrupted: { type: 'boolean' }, rev: { type: 'integer' }, generatedAt: { type: 'string' }, totalManifests: { type: 'integer' }, partialReasons: { type: 'array', items: { type: 'string' } } }, required: ['partial', 'stale', 'rev', 'generatedAt', 'totalManifests', 'partialReasons'], additionalProperties: false }, registryErrors: { type: 'object', properties: { total: { type: 'integer' }, items: { type: 'array', items: { type: 'object', properties: { pluginPath: { type: 'string' }, pluginId: { type: 'string' }, error: { type: 'string' }, code: { type: 'string' } }, additionalProperties: false } } }, required: ['total', 'items'], additionalProperties: false }, diagnostics: { type: 'object', properties: { total: { type: 'integer' }, errors: { type: 'integer' }, warnings: { type: 'integer' }, items: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, code: { type: 'string' }, reasonCode: { type: 'string' }, message: { type: 'string' }, pluginId: { type: 'string' }, filePath: { type: 'string' }, remediation: { type: 'string' }, ts: { type: 'string' } }, required: ['severity', 'code', 'reasonCode', 'message', 'ts'], additionalProperties: false } } }, required: ['total', 'errors', 'warnings', 'items'], additionalProperties: false }, validation: { type: 'object', properties: { totalIssues: { type: 'integer' }, issues: { type: 'array', items: { type: 'object', properties: { pluginId: { type: 'string' }, errors: { type: 'array', items: { type: 'string' } } }, required: ['pluginId', 'errors'], additionalProperties: false } } }, required: ['totalIssues', 'issues'], additionalProperties: false }, message: { type: 'string' } }, required: ['healthy', 'snapshot', 'registryErrors', 'diagnostics', 'validation', 'message'], additionalProperties: false } }) } }, async (_request, reply) => {
    try {
      const snapshot = await restDomainOperationMetrics.observeOperation(
        "plugin.registry.health",
        async () => registry.snapshot(),
      );

      // Collect validation errors from all manifests
      const validationIssues: Array<{ pluginId: string; errors: string[] }> =
        [];
      for (const entry of snapshot.manifests) {
        const validation = validateManifest(entry.manifest);
        if (!validation.valid) {
          validationIssues.push({
            pluginId: entry.pluginId,
            errors: validation.errors,
          });
        }
      }

      // Registry resolution errors (plugins that failed to load)
      const registryErrors = (snapshot as { errors?: unknown[] }).errors ?? [];
      const discoveryDiagnostics = snapshot.diagnostics ?? [];
      const discoveryErrorCount = discoveryDiagnostics.filter(
        (diagnostic) => diagnostic.severity === "error",
      ).length;

      // Determine why registry is partial
      const partialReasons: string[] = [];
      if (snapshot.corrupted) {
        partialReasons.push("snapshot_corrupted");
      }
      if (registryErrors.length > 0) {
        partialReasons.push("registry_errors");
      }
      if (discoveryErrorCount > 0) {
        partialReasons.push("discovery_diagnostics");
      }
      // If partial but no clear reason, it's likely initialization
      if (snapshot.partial && partialReasons.length === 0) {
        partialReasons.push("initialization_incomplete");
      }

      reply.type("application/json");
      return {
        healthy:
          !snapshot.partial &&
          !snapshot.stale &&
          validationIssues.length === 0 &&
          registryErrors.length === 0 &&
          discoveryErrorCount === 0,
        snapshot: {
          partial: snapshot.partial,
          stale: snapshot.stale,
          corrupted: snapshot.corrupted,
          rev: snapshot.rev,
          generatedAt: snapshot.generatedAt,
          totalManifests: snapshot.manifests.length,
          partialReasons,
        },
        registryErrors: {
          total: registryErrors.length,
          items: registryErrors.map((err) => {
            const e = err as {
              pluginPath?: string;
              pluginId?: string;
              error?: string;
              code?: string;
            };
            return {
              pluginPath: e.pluginPath,
              pluginId: e.pluginId,
              error: e.error,
              code: e.code,
            };
          }),
        },
        diagnostics: {
          total: discoveryDiagnostics.length,
          errors: discoveryErrorCount,
          warnings: discoveryDiagnostics.filter(
            (diagnostic) => diagnostic.severity === "warning",
          ).length,
          items: discoveryDiagnostics.map((diagnostic) => ({
            severity: diagnostic.severity,
            code: diagnostic.code,
            reasonCode: mapRegistryDiagnosticReasonCode(diagnostic.code),
            message: diagnostic.message,
            pluginId: diagnostic.context?.pluginId,
            filePath: diagnostic.context?.filePath,
            remediation: diagnostic.remediation,
            ts: diagnostic.ts,
          })),
        },
        validation: {
          totalIssues: validationIssues.length,
          issues: validationIssues,
        },
        message:
          registryErrors.length > 0
            ? `Registry is partial - ${registryErrors.length} plugin(s) failed to load. Check registryErrors.items for details.`
            : discoveryErrorCount > 0
              ? `Registry has discovery diagnostics - ${discoveryErrorCount} blocking issue(s). Check diagnostics.items for details.`
              : snapshot.partial &&
                  partialReasons.includes("initialization_incomplete")
                ? "Registry is partial - initialization incomplete. Try refreshing or wait for the snapshot rebuild to complete."
                : snapshot.partial
                  ? `Registry is partial - reasons: ${partialReasons.join(", ")}`
                  : snapshot.stale
                    ? "Registry is stale - plugin snapshot may be outdated."
                    : validationIssues.length > 0
                      ? `${validationIssues.length} plugin(s) have validation errors.`
                      : "All plugins are healthy.",
      };
    } catch (error) {
      platform.logger.error(
        "Failed to get plugin health",
        error instanceof Error ? error : new Error(String(error)),
      );
      reply.code(500).send({
        error: "Failed to get plugin health",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // AI Assistant endpoint: ask questions about a plugin
  server.post(`${basePath}/plugins/:pluginId/ask`, { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { querystring: { type: 'object', additionalProperties: false }, params: { type: 'object', properties: { pluginId: { type: 'string', minLength: 1 } }, required: ['pluginId'], additionalProperties: false }, body: { type: 'object', properties: { question: { type: 'string', minLength: 1 } }, required: ['question'], additionalProperties: false }, response: withUxErrorResponses({ 200: { type: 'object', properties: { answer: { type: 'string' }, usage: { type: 'object', properties: { promptTokens: { type: 'integer' }, completionTokens: { type: 'integer' }, totalTokens: { type: 'integer' } }, additionalProperties: false } }, required: ['answer'], additionalProperties: false } }) } }, async (request, reply) => {
    try {
      const { pluginId } = request.params as { pluginId: string };
      const { question } = request.body as { question: string };

      if (!question || typeof question !== "string") {
        reply.code(400).send({
          error: "Bad request",
          message: "Question is required and must be a string",
        });
        return;
      }

      // Get plugin manifest
      const snapshot = await restDomainOperationMetrics.observeOperation(
        "plugin.registry.snapshot",
        async () => registry.snapshot(),
      );
      const pluginEntry = snapshot.manifests.find(
        (entry) => entry.pluginId === pluginId,
      );

      if (!pluginEntry) {
        reply.code(404).send({
          error: "Plugin not found",
          message: `Plugin ${pluginId} not found in registry`,
        });
        return;
      }

      // Build prompt for LLM
      const systemPrompt = `You are a helpful assistant that explains KB Labs plugins based on their manifest.
Provide clear, concise answers about the plugin's capabilities, API endpoints, permissions, and usage.
Be specific and reference the actual values from the manifest.`;

      const userPrompt = `Plugin Manifest:
${JSON.stringify(pluginEntry.manifest, null, 2)}

User Question: ${question}

Please answer the question based on the plugin manifest above.`;

      // Call LLM
      const response = await restDomainOperationMetrics.observeOperation(
        "plugin.assistant.ask",
        () =>
          platform.llm.complete(userPrompt, {
            systemPrompt,
            temperature: 0.3,
            maxTokens: 1000,
          }),
      );

      reply.type("application/json");
      return {
        answer: response.content,
        usage: response.usage,
      };
    } catch (error) {
      platform.logger.error(
        "Failed to get AI answer about plugin",
        error instanceof Error ? error : new Error(String(error)),
      );
      reply.code(500).send({
        error: "Failed to get AI answer",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * Shutdown execution backend gracefully.
 * NOTE: ExecutionBackend is now owned by platform, shutdown via platform.shutdown()
 */
export async function shutdownExecutionBackend(): Promise<void> {
  // ExecutionBackend lifecycle is now managed by platform
  // Call platform.shutdown() instead to shutdown all services including executionBackend
  await platform.shutdown();
}

function summarizeValidationErrors(errors: string[]): string {
  if (errors.length === 0) {
    return "rest_validation_failed";
  }
  const first = errors[0] || "rest_validation_failed";
  const prefix = first.split(":")[0]?.trim() ?? "rest_validation_failed";
  return `rest_validation_failed ${prefix}`.trim();
}

function shortErrorMessage(error: unknown): string {
  if (!error) {
    return "unknown_error";
  }
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.trim().split("\n")[0] ?? message.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function mapDiagnosticSeverityToLogLevel(
  severity: "error" | "warning" | "info" | "debug",
): DiagnosticLogLevel {
  switch (severity) {
    case "error":
      return "error";
    case "warning":
      return "warn";
    case "debug":
      return "debug";
    default:
      return "info";
  }
}

function mapRegistryDiagnosticReasonCode(code: string): DiagnosticReasonCode {
  switch (code) {
    case "MANIFEST_NOT_FOUND":
      return "manifest_missing";
    case "MANIFEST_VALIDATION_ERROR":
    case "MANIFEST_PARSE_ERROR":
      return "manifest_invalid";
    case "MANIFEST_LOAD_TIMEOUT":
      return "manifest_load_timeout";
    case "INTEGRITY_MISMATCH":
      return "integrity_mismatch";
    default:
      return "plugin_discovery_failed";
  }
}

function emitRegistrySnapshotDiagnostics(snapshot: RegistrySnapshot): void {
  for (const diagnostic of snapshot.diagnostics ?? []) {
    logDiagnosticEvent(platform.logger, {
      domain: "registry",
      event: "plugin.discovery.diagnostic",
      level: mapDiagnosticSeverityToLogLevel(diagnostic.severity),
      reasonCode: mapRegistryDiagnosticReasonCode(diagnostic.code),
      message: diagnostic.message,
      outcome: diagnostic.severity === "error" ? "failed" : "skipped",
      pluginId: diagnostic.context?.pluginId,
      serviceId: "rest",
      manifestPath: diagnostic.context?.filePath,
      discoveryCode: diagnostic.code,
      remediation: diagnostic.remediation,
      evidence: {
        severity: diagnostic.severity,
        entityKind: diagnostic.context?.entityKind,
        entityId: diagnostic.context?.entityId,
        ts: diagnostic.ts,
      },
    });
  }
}

function inferRouteValidationReasonCode(
  errors: string[],
): DiagnosticReasonCode {
  if (errors.some((error) => error.includes("Handler file not found"))) {
    return "handler_not_found";
  }
  return "route_validation_failed";
}

function resolveRouteValidationLogLevel(
  errors: string[],
  totalRoutes: number,
): DiagnosticLogLevel {
  return errors.length >= totalRoutes ? "error" : "warn";
}
