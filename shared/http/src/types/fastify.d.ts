import 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    ux?: 'raw';
  }
}
