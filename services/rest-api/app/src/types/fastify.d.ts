/**
 * @module @kb-labs/rest-api-app/types/fastify
 * Fastify type extensions
 */

import type { FastifyBaseLogger } from 'fastify/types/logger';
import type { FastifySchema } from 'fastify/types/schema';
import type { FastifyTypeProvider, FastifyTypeProviderDefault } from 'fastify/types/type-provider';
import type { ContextConfigDefault, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerBase, RawServerDefault } from 'fastify/types/utils';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import type { ReadinessState } from '../routes/readiness';
import '@fastify/type-provider-typebox';
// @fastify/swagger augments FastifySchema with `tags`/`hide`/etc. Previously
// pulled in transitively via fastify-type-provider-zod@6's peer dependency
// on @fastify/swagger; 4.0.2 (pinned for Zod v3 compat, see #270) has no
// such peer, so the augmentation needs an explicit side-effect import here.
import '@fastify/swagger';
import type { EventHub } from '../events/hub';
import type { IContextLogger } from '@kb-labs/core-platform';

declare module 'fastify/types/instance' {
  interface FastifyInstance<
    RawServer extends RawServerBase = RawServerDefault,
    RawRequest extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
    RawReply extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
    Logger extends FastifyBaseLogger = FastifyBaseLogger,
    TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
    SchemaCompiler extends FastifySchema = FastifySchema,
    ContextConfig = ContextConfigDefault
  > {
    registry?: IEntityRegistry;
    kbReadiness?: ReadinessState;
    kbStartupGuard?: {
      inFlight: number;
    };
    kbEventHub?: EventHub;
  }
}

declare module 'fastify' {
  interface FastifyContextConfig {
    ux?: 'raw';
    uxFixture?: { validResult: 'error-envelope' };
  }

  interface FastifyInstance {
    registry?: IEntityRegistry;
    kbReadiness?: ReadinessState;
    kbStartupGuard?: {
      inFlight: number;
    };
    kbEventHub?: EventHub;
    listening?: boolean;
  }
}

declare module 'fastify/types/request' {
  interface FastifyRequest {
    mockMode?: boolean;
    kbStartupGuardActive?: boolean;
    kbStartupGuardTimer?: NodeJS.Timeout;
    kbMetricsStart?: number;
    kbHeaderState?: {
      vary: Set<string>;
      sensitive: Set<string>;
      rateLimitKeys: Record<string, string>;
      sanitized: Record<string, string>;
    };
    kbLogger?: IContextLogger;
    kbPluginId?: string;
    tenantId?: string;
  }
}

declare module 'fastify' {
  interface FastifyReply {
    errorCode?: string;
  }
  interface FastifyRequest {
    tenantId?: string;
  }
}
