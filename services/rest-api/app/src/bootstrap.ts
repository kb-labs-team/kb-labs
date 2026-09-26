/**
 * @module @kb-labs/rest-api-app/bootstrap
 * Server bootstrap and startup
 */

import { loadRestApiConfig } from "@kb-labs/rest-api-core";
import { createServer } from "./server";
import { createRegistry, type IEntityRegistry } from "@kb-labs/core-registry";
import type { IServiceTransport } from "@kb-labs/core-platform";
import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import { runService, type ServiceContext } from "@kb-labs/shared-daemon";
import { getListenOptions } from "@kb-labs/shared-http";
import { SystemMetricsCollector } from "./daemon/metrics";
import {
  metricsCollector as requestMetricsCollector,
  restDomainOperationMetrics,
} from "./middleware/metrics.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

// Singleton CLI API instance for cleanup
let registryInstance: IEntityRegistry | null = null;

// System metrics collector instance for cleanup
let metricsCollector: SystemMetricsCollector | null = null;

/**
 * Bootstrap REST API server
 */
export async function bootstrap(cwd: string = process.cwd()): Promise<void> {
  await runService({
    appId: "rest-api",
    serviceId: "rest",
    startDir: cwd,
    defaultPort: 5050,
    portEnvVar: "REST_API_PORT",
    defaultHost: "0.0.0.0",
    hostEnvVar: "REST_API_HOST",
    platform: {
      assemblyHook: makeAssemblyHook(),
    },
    setup,
  });
}

/**
 * REST API service body. Importable and side-effect-free: it only starts work
 * when called with a resolved {@link ServiceContext} (by `runService` here, or
 * by `runHost` in a project runtime).
 */
export async function setup({
  platform,
  host,
  projectRoot: repoRoot,
  platformRoot,
  logger: serviceLogger,
}: ServiceContext): Promise<() => Promise<void>> {
  // Platform launch has already loaded the layered environment.
  const { config, diagnostics } = await loadRestApiConfig(repoRoot);

  // Now we can use platform.logger (configured from kb.config.json)
  const startupRequestId = `rest-startup-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const startupTraceId = randomUUID();
  const startupSpanId = randomUUID();
  const bootstrapLogger = serviceLogger
    .forComponent("rest-bootstrap")
    .forOperation("rest.bootstrap", {
      requestId: startupRequestId,
      traceId: startupTraceId,
      spanId: startupSpanId,
    })
    .with({ invocationId: startupSpanId, executionId: startupSpanId });

  if (diagnostics.length > 0) {
    bootstrapLogger.warn("Configuration diagnostics", {
      diagnosticsCount: diagnostics.length,
    });
    for (const diagnostic of diagnostics) {
      bootstrapLogger.warn("Configuration diagnostic", {
        level: diagnostic.level,
        message: diagnostic.message,
      });
    }
  }

  bootstrapLogger.info("Resolved service roots", {
    projectRoot: repoRoot,
    platformRoot,
  });
  bootstrapLogger.info("Platform adapters initialized");

  // Initialize entity registry
  bootstrapLogger.info("Initializing entity registry");

  const isDevelopment = process.env.NODE_ENV !== "production";
  const snapshotTTL = isDevelopment
    ? 10 * 60 * 1000 // 10 minutes for development
    : 60 * 60 * 1000; // 1 hour for production

  // Project root is always the primary source for plugin discovery.
  // In installed mode (platform.dir set), the platform lock fills gaps —
  // but project marketplace.lock wins on conflict (project overrides platform).
  const registryInitStart = performance.now();
  const registry = await createRegistry({
    root: repoRoot,
    platformRoot: platformRoot !== repoRoot ? platformRoot : undefined,
    cache: {
      ttlMs: snapshotTTL,
      adapter: platform.cache,
    },
  });
  restDomainOperationMetrics.recordOperation(
    "registry.init",
    performance.now() - registryInitStart,
    "ok",
  );

  const plugins = registry.listPlugins();
  bootstrapLogger.info("Entity registry initialized", {
    pluginsFound: plugins.length,
    pluginIds: plugins.map((p) => `${p.id}@${p.version}`),
  });

  registryInstance = registry;

  registry.onChange((diff) => {
    restDomainOperationMetrics.recordOperation("registry.refresh", 0, "ok");
    bootstrapLogger.info("Registry changed", {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
    });
  });

  const server = await createServer(config, repoRoot, registry);

  // Start system metrics collector
  bootstrapLogger.info("Starting system metrics collector");
  metricsCollector = new SystemMetricsCollector("rest", () =>
    requestMetricsCollector.getActiveRequests(),
  );
  await metricsCollector.start(10000, 60000); // Collect every 10s, TTL 60s

  // Bind port from the transport (single declarative network source): rest is a
  // TCP service in the serviceTransport map, so it listens on exactly the port
  // the transport publishes for 'rest' — keeping bind and route consistent
  // (incl. any KB_NET_OFFSET shift). Falls back to config.port when no transport.
  const restTransport =
    platform.getAdapter<IServiceTransport>("serviceTransport");
  const restAddr = restTransport?.listenAddress?.("rest");
  const netOffset = Number(process.env.KB_NET_OFFSET) || 0;
  const listenPort =
    restAddr && "port" in restAddr ? restAddr.port : config.port + netOffset;
  // Bind host: the launcher already resolved it with the precedence
  // REST_API_HOST env > transport's advisory host > 0.0.0.0 (0.0.0.0 keeps
  // Docker port-forwarding working; set REST_API_HOST=127.0.0.1 to restrict to
  // loopback when all traffic is routed through the gateway). An embedding
  // process (project runtime) can pass its own loopback default.
  const restHost = host;
  const address = await server.listen(getListenOptions(listenPort, restHost));

  bootstrapLogger.info("REST API server listening", { address });

  // Setup graceful shutdown
  const shutdown = async (signal: string) => {
    bootstrapLogger.warn("Received shutdown signal", { signal });

    // Stop metrics collector
    if (metricsCollector) {
      metricsCollector.stop();
      metricsCollector = null;
    }

    // Dispose CLI API
    if (registryInstance) {
      await registryInstance.dispose();
      registryInstance = null;
    }

    // Close server
    await server.close();
    bootstrapLogger.info("Server closed");
  };

  return () => shutdown("service-runner");
}
