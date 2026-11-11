import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    kbLogger?: {
      trace(msg: string, meta?: Record<string, unknown>): void;
      debug(msg: string, meta?: Record<string, unknown>): void;
      info(msg: string, meta?: Record<string, unknown>): void;
      warn(msg: string, meta?: Record<string, unknown>): void;
      error(msg: string, error?: Error, meta?: Record<string, unknown>): void;
      fatal(msg: string, error?: Error, meta?: Record<string, unknown>): void;
    };
  }
}
