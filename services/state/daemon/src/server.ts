import Fastify, { type FastifyInstance } from "fastify";
import {
  InMemoryStateBroker,
  type StateBroker,
} from "@kb-labs/core-state-broker";
import { AppendOnlyJournalStateBroker } from "./backends/append-only-journal.js";
import {
  createErrorEnvelope,
  createContextLogger,
  type IContextLogger,
  type ILogger,
} from "@kb-labs/core-platform";
import { ConsoleLogger } from "@kb-labs/core-platform/inmemory";
import {
  createHttpLogger,
  HttpObservabilityCollector,
  createServiceReadyResponse,
  getListenOptions,
  metricLine,
  registerOpenAPI,
} from "@kb-labs/shared-http";
import type {
  ObservabilityCheck,
  ServiceHealthStatus,
} from "@kb-labs/core-contracts";
import { randomUUID } from "node:crypto";

export interface StateDaemonConfig {
  port?: number;
  host?: string;
  logger?: ILogger;
}

function createFallbackLogger(): IContextLogger {
  return createContextLogger(new ConsoleLogger(), {
    applicationId: "kb-labs",
    serviceId: "state-daemon",
    instanceId: `local:${process.pid}`,
    layer: "service",
  });
}

class StateDaemonRuntime {
  private broker: StateBroker = new InMemoryStateBroker();
  private readonly observability = new HttpObservabilityCollector({
    serviceId: "state-daemon",
    serviceType: "state-daemon",
    version: "1.2.0",
    logsSource: "state-daemon",
  });
  private readonly logger: IContextLogger;
  private server: FastifyInstance | null = null;
  private acceptingRequests = true;

  constructor(
    private readonly config: StateDaemonConfig = {},
    private readonly platformDataRoot?: string,
  ) {
    this.logger = createContextLogger(config.logger ?? createFallbackLogger(), {
      applicationId: "kb-labs",
      serviceId: "state-daemon",
      instanceId: `local:${process.pid}`,
      layer: "service",
    });
  }

  async start(): Promise<void> {
    const port = this.config.port;
    if (port === undefined) {
      throw new Error(
        "State Daemon has no assigned port. Start it through the host or set KB_STATE_DAEMON_PORT before starting the standalone daemon.",
      );
    }
    const host = this.config.host ?? "localhost";

    let server: FastifyInstance | null = null;
    this.acceptingRequests = true;
    try {
      if (this.platformDataRoot) {
        await this.broker.stop();
        const broker = await AppendOnlyJournalStateBroker.open(
          this.platformDataRoot,
        );
        this.broker = broker;
        if (broker.journalWasCorrupt) {
          const diagnostic = createErrorEnvelope(
            "KB_STATE_BROKER_PERSISTENCE_CORRUPT",
          );
          this.logger.warn(diagnostic.message, {
            code: diagnostic.code,
            hint: diagnostic.hint,
          });
        }
      }

      const instance = Fastify({
        logger: false,
        bodyLimit: 1048576,
      });
      server = instance;
      this.server = instance;

      instance.addHook("onRequest", async (request, reply) => {
        if (!this.acceptingRequests) {
          reply.code(503).send();
          return;
        }
        const requestId =
          (request.headers["x-request-id"] as string | undefined) ||
          randomUUID();
        const traceId =
          (request.headers["x-trace-id"] as string | undefined) || randomUUID();

        request.id = requestId;
        reply.header("X-Request-Id", requestId);
        reply.header("X-Trace-Id", traceId);

        request.kbLogger = createHttpLogger(this.logger, {
          serviceId: "state-daemon",
          layer: "service",
          component: "http-request",
          requestId,
          traceId,
          method: request.method,
          url: request.url,
          operation: "http.request",
        });
        request.kbLogger.debug("HTTP request started");

        if (request.method === "OPTIONS") {
          reply.code(204).send();
        }
      });
      instance.addHook("onResponse", async (request, reply) => {
        const logger = request.kbLogger;
        if (!logger) {
          return;
        }

        logger.info("HTTP request completed", {
          "http.status_code": reply.statusCode,
        });
      });
      instance.addHook("onSend", async (_request, reply, payload) => {
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header(
          "Access-Control-Allow-Methods",
          "GET, PUT, DELETE, POST, OPTIONS",
        );
        reply.header("Access-Control-Allow-Headers", "Content-Type");
        return payload;
      });

      await registerOpenAPI(instance, {
        title: "KB Labs State Daemon",
        description:
          "State broker service for persistent cross-invocation state",
        version: "1.2.0",
        servers: [{ url: `http://${host}:${port}`, description: "Local dev" }],
        ui: false,
      });

      this.observability.register(instance);
      this.registerRoutes(instance);
      this.observability.recordOperation("state.bootstrap", 0, "ok");
      await instance.listen(getListenOptions(port, host));
    } catch (startupError) {
      this.acceptingRequests = false;
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => server?.close()),
        Promise.resolve().then(() => this.broker.stop()),
      ]);
      this.server = null;
      this.broker = new InMemoryStateBroker();
      const cleanupErrors = cleanup
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [startupError, ...cleanupErrors],
          "State Daemon startup and cleanup failed.",
        );
      }
      throw startupError;
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.acceptingRequests = false;
      await this.server.close();
      this.server = null;
    }
    await this.broker.stop();
  }

  private getBrokerHealth() {
    return this.observability.observeOperation("state.health", () =>
      this.broker.getHealth(),
    );
  }

  private getBrokerStats() {
    return this.observability.observeOperation("state.stats", () =>
      this.broker.getStats(),
    );
  }

  private registerRoutes(server: FastifyInstance): void {
    server.get("/health", async () => this.getBrokerHealth());

    server.get("/ready", async () => {
      const health = await this.getBrokerHealth();
      const degraded = health.status !== "ok";
      return createServiceReadyResponse({
        ready: health.status === "ok",
        status: degraded ? "degraded" : "ready",
        reason: degraded ? `state_broker_${health.status}` : "ready",
        components: {
          stateBroker: {
            ready: health.status === "ok",
            status: health.status,
          },
        },
      });
    });

    server.get("/stats", async () => this.getBrokerStats());

    server.get("/metrics", async (_request, reply) => {
      const health = await this.getBrokerHealth();
      const stats = await this.getBrokerStats();
      reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return this.observability.renderPrometheusMetrics(
        mapBrokerHealthStatus(health.status),
        buildBrokerMetricLines(stats),
      );
    });

    server.get("/observability/describe", async () =>
      this.observability.buildDescribe(),
    );

    server.get("/observability/health", async () => {
      const health = await this.getBrokerHealth();
      const stats = await this.getBrokerStats();

      return this.observability.buildHealth({
        status: mapBrokerHealthStatus(health.status),
        checks: buildBrokerChecks(health),
        meta: {
          serviceHealthEndpoint: "/health",
          statsEndpoint: "/stats",
          totalEntries: stats.totalEntries,
          totalSize: stats.totalSize,
          hitRate: stats.hitRate,
          missRate: stats.missRate,
          evictions: stats.evictions,
        },
      });
    });

    server.get("/state/:key", async (request, reply) => {
      const { key } = request.params as { key: string };
      const value = await this.observability.observeOperation("state.get", () =>
        this.broker.get(key),
      );

      if (value === null) {
        reply.code(404);
        return null;
      }

      reply.type("application/json");
      return JSON.stringify(value);
    });

    server.put("/state/:key", async (request, reply) => {
      const { key } = request.params as { key: string };
      const { value, ttl } = request.body as { value: unknown; ttl?: number };
      await this.observability.observeOperation("state.set", () =>
        this.broker.set(key, value, ttl),
      );
      reply.code(204);
      return null;
    });

    server.put("/state/:key/if-absent", async (request, reply) => {
      const { key } = request.params as { key: string };
      const { value, ttl } = request.body as { value: unknown; ttl?: number };
      const inserted = await this.observability.observeOperation(
        "state.setIfNotExists",
        () => this.broker.setIfNotExists(key, value, ttl),
      );
      reply.code(inserted ? 204 : 409);
      return null;
    });

    server.put("/state/:key/zset", async (request, reply) => {
      const { key } = request.params as { key: string };
      const { score, member } = request.body as {
        score: number;
        member: string;
      };
      await this.observability.observeOperation("state.zadd", () =>
        this.broker.zadd(key, score, member),
      );
      reply.code(204);
      return null;
    });

    server.delete("/state/:key/zset", async (request, reply) => {
      const { key } = request.params as { key: string };
      const { member } = request.body as { member: string };
      await this.observability.observeOperation("state.zrem", () =>
        this.broker.zrem(key, member),
      );
      reply.code(204);
      return null;
    });

    server.get("/state/:key/range", async (request, reply) => {
      const { key } = request.params as { key: string };
      const query = request.query as { min?: string; max?: string };
      const members = await this.observability.observeOperation(
        "state.zrangebyscore",
        () =>
          this.broker.zrangebyscore(key, Number(query.min), Number(query.max)),
      );
      reply.type("application/json");
      return members;
    });

    server.delete("/state/:key", async (request, reply) => {
      const { key } = request.params as { key: string };
      await this.observability.observeOperation("state.delete", () =>
        this.broker.delete(key),
      );
      reply.code(204);
      return null;
    });

    server.post("/state/clear", async (request, reply) => {
      const pattern = (request.query as { pattern?: string }).pattern;
      await this.observability.observeOperation("state.clear", () =>
        this.broker.clear(pattern),
      );
      reply.code(204);
      return null;
    });
  }
}

export class StateDaemonServer {
  private readonly runtime: StateDaemonRuntime;

  constructor(config: StateDaemonConfig = {}) {
    this.runtime = new StateDaemonRuntime(config);
  }

  async start(): Promise<void> {
    await this.runtime.start();
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
  }
}

/** Internal host composition entry point; omitted from the package root. */
export function createDurableStateDaemon(
  config: StateDaemonConfig,
  platformDataRoot: string,
): Pick<StateDaemonServer, "start" | "stop"> {
  const runtime = new StateDaemonRuntime(config, platformDataRoot);
  return {
    start: () => runtime.start(),
    stop: () => runtime.stop(),
  };
}

function mapBrokerHealthStatus(
  status: "ok" | "degraded" | "shutting_down",
): ServiceHealthStatus {
  if (status === "ok") {
    return "healthy";
  }
  if (status === "degraded") {
    return "degraded";
  }
  return "unhealthy";
}

function buildBrokerChecks(
  health: Awaited<ReturnType<StateBroker["getHealth"]>>,
): ObservabilityCheck[] {
  return [
    {
      id: "state-broker",
      status:
        health.status === "ok"
          ? "ok"
          : health.status === "degraded"
            ? "warn"
            : "error",
      message: `Broker status is ${health.status}`,
    },
  ];
}

function buildBrokerMetricLines(
  stats: Awaited<ReturnType<StateBroker["getStats"]>>,
): string[] {
  return [
    "# HELP state_broker_entries_total Total entries stored by the state broker",
    "# TYPE state_broker_entries_total gauge",
    metricLine("state_broker_entries_total", stats.totalEntries),
    "# HELP state_broker_size_bytes Estimated total size of state broker entries",
    "# TYPE state_broker_size_bytes gauge",
    metricLine("state_broker_size_bytes", stats.totalSize),
    "# HELP state_broker_evictions_total Number of evicted state broker entries",
    "# TYPE state_broker_evictions_total gauge",
    metricLine("state_broker_evictions_total", stats.evictions),
  ];
}
