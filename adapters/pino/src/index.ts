/**
 * @module @kb-labs/adapters-pino
 * Pino adapter implementing ILogger interface.
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@kb-labs/adapters-pino';
 *
 * const logger = createAdapter({
 *   level: 'info',
 *   pretty: true,
 * });
 *
 * logger.info('Server started', { port: 3000 });
 * logger.error('Failed to connect', new Error('Connection timeout'));
 *
 * const childLogger = logger.child({ service: 'api' });
 * childLogger.debug('Request received');
 * ```
 */

import pino, { type Logger as PinoLoggerInstance } from "pino";
import type { ILogger, ILogBuffer, LogRecord } from "@kb-labs/sdk/adapters";
import { generateLogId } from "@kb-labs/sdk/adapters";
import { LogRingBuffer } from "./log-ring-buffer";
import { BoundedFileSink } from "./bounded-file-sink";

export { BoundedFileSink, LOG_FILE_BUDGET } from "./bounded-file-sink";

// Re-export manifest
export { manifest } from "./manifest.js";

/**
 * Configuration for log streaming/buffering
 */
export interface StreamingConfig {
  /** Enable log buffering for streaming (default: false) */
  enabled: boolean;
  /** Maximum buffer size (number of log records, default: 1000) */
  bufferSize?: number;
  /** Maximum age of logs in buffer (milliseconds, default: 3600000 = 1 hour) */
  bufferMaxAge?: number;
}

/**
 * Configuration for Pino logger adapter.
 */
export interface PinoLoggerConfig {
  /** Log level (default: 'info') */
  level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  /** Enable pretty printing for development (default: false) */
  pretty?: boolean;
  /** Streaming configuration (optional) */
  streaming?: StreamingConfig;
  /** Additional pino options */
  options?: pino.LoggerOptions;
}

/**
 * Pino implementation of ILogger interface.
 */
export class PinoLoggerAdapter implements ILogger {
  private pino: PinoLoggerInstance;
  private logBuffer?: LogRingBuffer;
  private logCallbacks = new Set<(record: LogRecord) => void | Promise<void>>();
  private pendingDeliveries = new Set<Promise<void>>();
  private bindings: Record<string, unknown> = {};

  constructor(config: PinoLoggerConfig = {}) {
    // Resolve log level with priority: ENV var > config.level > 'info'
    // This allows overriding via KB_LOG_LEVEL or LOG_LEVEL environment variables
    const resolvedLevel =
      (process.env.KB_LOG_LEVEL as PinoLoggerConfig["level"]) ??
      (process.env.LOG_LEVEL as PinoLoggerConfig["level"]) ??
      (process.env.KB_DEBUG === "true" ? "debug" : undefined) ??
      config.level ??
      "info";

    // Initialize log buffer if streaming is enabled
    if (config.streaming?.enabled) {
      this.logBuffer = new LogRingBuffer(
        config.streaming.bufferSize ?? 1000,
        config.streaming.bufferMaxAge ?? 3600000,
      );
    }

    // The launcher (or kb-dev) names the process log file; the adapter alone
    // bounds and rotates it. The file holds structured JSON, so it replaces
    // the pretty transport.
    const logFile = process.env.KB_LOG_FILE;
    const transport =
      config.pretty && !logFile
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
              ignore: "pid,hostname",
            },
          }
        : undefined;

    // Merge options, but transport from config.options takes precedence
    const finalTransport = logFile
      ? undefined
      : (config.options?.transport ?? transport);

    // Always use single pino instance (no multistream). The CLI sets the
    // stream explicitly so diagnostics cannot contaminate command stdout.
    const destination = logFile
      ? new BoundedFileSink({ path: logFile })
      : process.env.KB_LOG_STREAM === "stderr"
        ? process.stderr
        : undefined;
    const pinoOptions = {
      level: resolvedLevel,
      ...config.options,
      transport: finalTransport,
    };
    this.pino = destination
      ? pino(pinoOptions, destination)
      : pino(pinoOptions);
  }

  /**
   * Emit log record to all registered callbacks (extensions).
   * Fire-and-forget - errors in callbacks don't block logging.
   */
  private emitLog(record: LogRecord): void {
    if (this.logCallbacks.size === 0) {
      return;
    }

    for (const callback of this.logCallbacks) {
      try {
        const delivery = Promise.resolve(callback(record)).catch((error: unknown) => {
          // Delivery extensions are optional. A failed durable sink must not
          // take down the service or recurse through this logger.
          process.stderr.write(
            `[kb-logs] log delivery extension failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }).then(() => undefined);
        this.pendingDeliveries.add(delivery);
        void delivery.finally(() => this.pendingDeliveries.delete(delivery));
      } catch (error) {
        console.error("[PinoLogger] Error in onLog callback:", error);
      }
    }
  }

  /**
   * Internal constructor for child loggers.
   */
  private constructor_child(
    pinoInstance: PinoLoggerInstance,
    bindings: Record<string, unknown>,
  ) {
    const instance = Object.create(PinoLoggerAdapter.prototype);
    instance.pino = pinoInstance;
    instance.logCallbacks = this.logCallbacks; // Share callbacks with parent
    instance.pendingDeliveries = this.pendingDeliveries;
    instance.logBuffer = this.logBuffer; // Share buffer with parent
    instance.bindings = bindings;
    return instance;
  }

  private mergeBindings(
    meta?: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!meta) {
      return { ...this.bindings };
    }
    return { ...this.bindings, ...meta };
  }

  private sourceOf(meta: Record<string, unknown>): string {
    const source = meta.source ?? meta.serviceId ?? meta.applicationId;
    return typeof source === "string" && source.length > 0 ? source : "unknown";
  }

  info(message: string, meta?: Record<string, unknown>): void {
    const logId = generateLogId();
    const timestamp = Date.now();
    const mergedMeta = this.mergeBindings(meta);

    this.pino.info(meta ?? {}, message);

    const record: LogRecord = {
      id: logId,
      timestamp,
      level: "info",
      message,
      fields: mergedMeta,
      source: this.sourceOf(mergedMeta),
    };

    this.logBuffer?.append(record);
    this.emitLog(record);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    const logId = generateLogId();
    const timestamp = Date.now();
    const mergedMeta = this.mergeBindings(meta);

    this.pino.warn(meta ?? {}, message);

    const record: LogRecord = {
      id: logId,
      timestamp,
      level: "warn",
      message,
      fields: mergedMeta,
      source: this.sourceOf(mergedMeta),
    };

    this.logBuffer?.append(record);
    this.emitLog(record);
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    const logId = generateLogId();
    const timestamp = Date.now();
    const mergedMeta = this.mergeBindings(meta);

    const enrichedMeta = {
      ...mergedMeta,
      ...(error && {
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      }),
    };

    this.pino.error(enrichedMeta, message);

    const record: LogRecord = {
      id: logId,
      timestamp,
      level: "error",
      message,
      fields: enrichedMeta,
      source: this.sourceOf(mergedMeta),
    };

    this.logBuffer?.append(record);
    this.emitLog(record);
  }

  fatal(message: string, error?: Error, meta?: Record<string, unknown>): void {
    const logId = generateLogId();
    const timestamp = Date.now();
    const mergedMeta = this.mergeBindings(meta);

    const enrichedMeta = {
      ...mergedMeta,
      ...(error && {
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      }),
    };

    this.pino.fatal(enrichedMeta, message);

    const record: LogRecord = {
      id: logId,
      timestamp,
      level: "fatal",
      message,
      fields: enrichedMeta,
      source: this.sourceOf(mergedMeta),
    };

    this.logBuffer?.append(record);
    this.emitLog(record);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    const logId = generateLogId();
    const timestamp = Date.now();
    const mergedMeta = this.mergeBindings(meta);

    this.pino.debug(meta ?? {}, message);

    const record: LogRecord = {
      id: logId,
      timestamp,
      level: "debug",
      message,
      fields: mergedMeta,
      source: this.sourceOf(mergedMeta),
    };

    this.logBuffer?.append(record);
    this.emitLog(record);
  }

  trace(message: string, meta?: Record<string, unknown>): void {
    const logId = generateLogId();
    const timestamp = Date.now();
    const mergedMeta = this.mergeBindings(meta);

    this.pino.trace(meta ?? {}, message);

    const record: LogRecord = {
      id: logId,
      timestamp,
      level: "trace",
      message,
      fields: mergedMeta,
      source: this.sourceOf(mergedMeta),
    };

    this.logBuffer?.append(record);
    this.emitLog(record);
  }

  child(bindings: Record<string, unknown>): ILogger {
    const mergedBindings = { ...this.bindings, ...bindings };
    const childPino = this.pino.child(bindings);
    return this.constructor_child(childPino, mergedBindings);
  }

  async flush(): Promise<void> {
    while (this.pendingDeliveries.size > 0) {
      await Promise.all([...this.pendingDeliveries]);
    }
    await new Promise<void>((resolve) => this.pino.flush(() => resolve()));
  }

  /**
   * Get log buffer for streaming/querying (ILogger optional method)
   */
  getLogBuffer(): ILogBuffer | undefined {
    return this.logBuffer;
  }

  /**
   * Register callback for every log event (ILogger optional method).
   * Used by platform to connect logger extensions (ring buffer, persistence).
   *
   * @param callback - Function to call on each log event
   * @returns Unsubscribe function to remove the callback
   */
  onLog(callback: (record: LogRecord) => void | Promise<void>): () => void {
    this.logCallbacks.add(callback);
    return () => this.logCallbacks.delete(callback);
  }
}

/**
 * Create Pino logger adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 */
export function createAdapter(config?: PinoLoggerConfig): PinoLoggerAdapter {
  return new PinoLoggerAdapter(config);
}

// Default export for direct import
export default createAdapter;

// Export buffer class
export { LogRingBuffer } from "./log-ring-buffer";
