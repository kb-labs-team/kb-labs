import { withUxErrorResponses } from './route-schema.js';
/**
 * @module @kb-labs/rest-api-app/routes/analytics
 * Analytics endpoints for querying events, stats, and monitoring
 */

import type { FastifyInstance } from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import { createErrorEnvelope, getCatalogEntry } from '@kb-labs/core-platform';
import { normalizeBasePath, resolvePaths } from './path-helpers';
import { platform } from '@kb-labs/core-runtime';
import { restDomainOperationMetrics } from '../middleware/metrics.js';
import type {
  EventsQuery,
  EventsResponse,
  EventsStats,
  BufferStatus,
  DlqStatus,
} from '@kb-labs/core-platform/adapters';

const analyticsQuerySchema = {
  type: 'object', properties: {
    type: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    source: { type: 'string' }, actor: { type: 'string' },
    from: { type: 'string' }, to: { type: 'string' },
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' }, offset: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
  }, additionalProperties: false,
} as const;
const analyticsDailyQuerySchema = {
  type: 'object', properties: {
    from: { type: 'string' }, to: { type: 'string' },
    groupBy: { enum: ['hour', 'day', 'week', 'month'] }, breakdownBy: { type: 'string', minLength: 1 },
    metrics: { type: 'string', minLength: 1 }, models: { type: 'string', minLength: 1 },
  }, additionalProperties: false,
} as const;
const eventItemSchema = { type: 'object', properties: {
  id: { type: 'string' }, schema: { const: 'kb.v1' }, type: { type: 'string' }, ts: { type: 'string', format: 'date-time' }, ingestTs: { type: 'string', format: 'date-time' },
  source: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' } }, required: ['product', 'version'], additionalProperties: false },
  runId: { type: 'string' }, actor: { type: 'object', properties: { type: { enum: ['user', 'agent', 'ci'] }, id: { type: 'string' }, name: { type: 'string' } }, required: ['type'], additionalProperties: false },
  ctx: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } },
  payload: {}, hashMeta: { type: 'object', properties: { algo: { const: 'hmac-sha256' }, saltId: { type: 'string' } }, required: ['algo', 'saltId'], additionalProperties: false },
}, required: ['id', 'schema', 'type', 'ts', 'ingestTs', 'source', 'runId'], additionalProperties: false } as const;
const uxSuccess = (data: object) => ({ type: 'object', properties: { ok: { const: true }, data }, required: ['ok', 'data'], additionalProperties: false });

/**
 * Register analytics routes
 *
 * These are system-level analytics endpoints that expose events and statistics
 * from the platform's analytics adapter.
 *
 * Returns 501 Not Implemented if analytics adapter doesn't support read methods.
 */
export async function registerAnalyticsRoutes(
  fastify: FastifyInstance,
  config: RestApiConfig
): Promise<void> {
  const basePath = normalizeBasePath(config.basePath);

  // GET /api/v1/analytics/events
  // Query analytics events with optional filters
  const eventsPaths = resolvePaths(basePath, '/analytics/events');
  for (const path of eventsPaths) {
    fastify.get<{
      Querystring: {
        type?: string | string[];
        source?: string;
        actor?: string;
        from?: string;
        to?: string;
        limit?: string;
        offset?: string;
      };
    }>(path, { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { querystring: analyticsQuerySchema, response: withUxErrorResponses({ 200: uxSuccess({ type: 'object', properties: { events: { type: 'array', items: eventItemSchema }, total: { type: 'integer' }, hasMore: { type: 'boolean' } }, required: ['events', 'total', 'hasMore'], additionalProperties: false }) }) } }, async (request, reply) => {
      try {
        const analytics = platform.analytics;

        // Check if analytics adapter supports read methods
        const getEvents = analytics.getEvents;
        if (!getEvents) {
          fastify.log.debug('Analytics adapter does not implement getEvents()');
          return reply.code(501).send({
            ok: false,
            error: {
              code: 'ANALYTICS_NOT_IMPLEMENTED',
              message: 'Analytics adapter does not support reading events',
            },
          });
        }

        // Build query from request params
        const query: EventsQuery = {};

        if (request.query.type !== undefined) {
          query.type = request.query.type;
        }
        if (request.query.source) {
          query.source = request.query.source;
        }
        if (request.query.actor) {
          query.actor = request.query.actor;
        }
        if (request.query.from) {
          query.from = request.query.from;
        }
        if (request.query.to) {
          query.to = request.query.to;
        }
        if (request.query.limit) {
          query.limit = Number.parseInt(request.query.limit, 10);
        }
        if (request.query.offset) {
          query.offset = Number.parseInt(request.query.offset, 10);
        }

        fastify.log.debug({ query }, 'Fetching analytics events');

        const response: EventsResponse = await restDomainOperationMetrics.observeOperation(
          'analytics.events.query',
          () => getEvents.call(analytics, query),
        );

        fastify.log.debug(
          {
            total: response.total,
            count: response.events.length,
            hasMore: response.hasMore,
          },
          'Analytics events fetched successfully'
        );

        return {
          ok: true,
          data: response,
          meta: {
            source: 'analytics-adapter',
          },
        };
      } catch (error) {
        platform.logger.error('Failed to fetch analytics events', error instanceof Error ? error : new Error(String(error)));

        return reply.code(500).send({
          ok: false,
          error: {
            code: 'ANALYTICS_ERROR',
            message: error instanceof Error ? error.message : 'Failed to fetch analytics events',
          },
        });
      }
    });
  }

  // GET /api/v1/analytics/stats
  // Get aggregated statistics
  const statsPaths = resolvePaths(basePath, '/analytics/stats');
  for (const path of statsPaths) {
    fastify.get(path, { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { querystring: { type: 'object', additionalProperties: false }, response: withUxErrorResponses({ 200: uxSuccess({ type: 'object', properties: { totalEvents: { type: 'integer' }, byType: { type: 'object', additionalProperties: { type: 'integer' } }, bySource: { type: 'object', additionalProperties: { type: 'integer' } }, byActor: { type: 'object', additionalProperties: { type: 'integer' } }, timeRange: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false }, persistence: { oneOf: [{ type: 'object', properties: { kind: { const: 'durable' } }, required: ['kind'], additionalProperties: false }, { type: 'object', properties: { kind: { const: 'ephemeral' }, notice: { type: 'object', properties: { message: { type: 'string' }, hint: { type: 'string' } }, required: ['message', 'hint'], additionalProperties: false } }, required: ['kind', 'notice'], additionalProperties: false }] } }, required: ['totalEvents', 'byType', 'bySource', 'byActor', 'timeRange', 'persistence'], additionalProperties: false }) }) } }, async (_request, reply) => {
      try {
        const analytics = platform.analytics;

        const getStats = analytics.getStats;
        if (!getStats) {
          fastify.log.debug('Analytics adapter does not implement getStats()');
          const errorCode = 'KB_ANALYTICS_STATS_UNSUPPORTED';
          const error = createErrorEnvelope(errorCode);
          reply.statusCode = getCatalogEntry(errorCode).httpStatus;
          return reply.send({ ok: false, error });
        }

        fastify.log.debug('Fetching analytics stats');

        // Cache stats for 60 seconds to avoid reprocessing 50k+ events on every request
        const cacheKey = 'analytics:stats';
        let stats = await platform.cache.get<EventsStats>(cacheKey);

        if (!stats) {
          fastify.log.debug('Cache miss, fetching stats from adapter');
          stats = await restDomainOperationMetrics.observeOperation('analytics.stats.get', () => getStats.call(analytics));
          await platform.cache.set(cacheKey, stats, 60 * 1000); // 60 second TTL
        } else {
          fastify.log.debug('Cache hit, returning cached stats');
        }

        fastify.log.debug(
          {
            totalEvents: stats.totalEvents,
            timeRange: stats.timeRange,
          },
          'Analytics stats fetched successfully'
        );

        return {
          ok: true,
          data: stats,
          meta: {
            source: 'analytics-adapter',
          },
        };
      } catch (error) {
        platform.logger.error('Failed to fetch analytics stats', error instanceof Error ? error : new Error(String(error)));

        return reply.code(500).send({
          ok: false,
          error: {
            code: 'ANALYTICS_ERROR',
            message: error instanceof Error ? error.message : 'Failed to fetch analytics stats',
          },
        });
      }
    });
  }

  // GET /api/v1/analytics/buffer/status
  // Get WAL buffer status (if applicable)
  const bufferPaths = resolvePaths(basePath, '/analytics/buffer/status');
  for (const path of bufferPaths) {
    fastify.get(path, { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { querystring: { type: 'object', additionalProperties: false }, response: withUxErrorResponses({ 200: uxSuccess({ type: 'object', properties: { segments: { type: 'integer' }, totalSizeBytes: { type: 'integer' }, oldestEventTs: { type: ['string', 'null'] }, newestEventTs: { type: ['string', 'null'] } }, required: ['segments', 'totalSizeBytes', 'oldestEventTs', 'newestEventTs'], additionalProperties: false }) }) } }, async (_request, reply) => {
      try {
        const analytics = platform.analytics;

        const getBufferStatus = analytics.getBufferStatus;
        if (!getBufferStatus) {
          fastify.log.debug('Analytics adapter does not implement getBufferStatus()');
          return reply.code(501).send({
            ok: false,
            error: {
              code: 'ANALYTICS_NOT_IMPLEMENTED',
              message: 'Analytics adapter does not support buffer status',
            },
          });
        }

        fastify.log.debug('Fetching analytics buffer status');

        const status: BufferStatus | null = await restDomainOperationMetrics.observeOperation(
          'analytics.buffer.status',
          () => getBufferStatus.call(analytics),
        );

        if (status === null) {
          fastify.log.debug('Buffer status not applicable for current analytics backend');
          return reply.code(501).send({
            ok: false,
            error: {
              code: 'BUFFER_NOT_APPLICABLE',
              message: 'Buffer status not applicable for current analytics backend',
            },
          });
        }

        fastify.log.debug(
          {
            segments: status.segments,
            totalSizeBytes: status.totalSizeBytes,
          },
          'Analytics buffer status fetched successfully'
        );

        return {
          ok: true,
          data: status,
          meta: {
            source: 'analytics-adapter',
          },
        };
      } catch (error) {
        platform.logger.error('Failed to fetch analytics buffer status', error instanceof Error ? error : new Error(String(error)));

        return reply.code(500).send({
          ok: false,
          error: {
            code: 'ANALYTICS_ERROR',
            message:
              error instanceof Error
                ? error.message
                : 'Failed to fetch analytics buffer status',
          },
        });
      }
    });
  }

  // GET /api/v1/analytics/dlq/status
  // Get Dead-Letter Queue status (if applicable)
  const dlqPaths = resolvePaths(basePath, '/analytics/dlq/status');
  for (const path of dlqPaths) {
    fastify.get(path, { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { querystring: { type: 'object', additionalProperties: false }, response: withUxErrorResponses({ 200: uxSuccess({ type: 'object', properties: { failedEvents: { type: 'integer' }, oldestFailureTs: { type: ['string', 'null'] } }, required: ['failedEvents', 'oldestFailureTs'], additionalProperties: false }) }) } }, async (_request, reply) => {
      try {
        const analytics = platform.analytics;

        const getDlqStatus = analytics.getDlqStatus;
        if (!getDlqStatus) {
          fastify.log.debug('Analytics adapter does not implement getDlqStatus()');
          return reply.code(501).send({
            ok: false,
            error: {
              code: 'ANALYTICS_NOT_IMPLEMENTED',
              message: 'Analytics adapter does not support DLQ status',
            },
          });
        }

        fastify.log.debug('Fetching analytics DLQ status');

        const status: DlqStatus | null = await restDomainOperationMetrics.observeOperation(
          'analytics.dlq.status',
          () => getDlqStatus.call(analytics),
        );

        if (status === null) {
          fastify.log.debug('DLQ status not applicable for current analytics backend');
          return reply.code(501).send({
            ok: false,
            error: {
              code: 'DLQ_NOT_APPLICABLE',
              message: 'DLQ status not applicable for current analytics backend',
            },
          });
        }

        fastify.log.debug(
          {
            failedEvents: status.failedEvents,
            oldestFailureTs: status.oldestFailureTs,
          },
          'Analytics DLQ status fetched successfully'
        );

        return {
          ok: true,
          data: status,
          meta: {
            source: 'analytics-adapter',
          },
        };
      } catch (error) {
        platform.logger.error('Failed to fetch analytics DLQ status', error instanceof Error ? error : new Error(String(error)));

        return reply.code(500).send({
          ok: false,
          error: {
            code: 'ANALYTICS_ERROR',
            message:
              error instanceof Error ? error.message : 'Failed to fetch analytics DLQ status',
          },
        });
      }
    });
  }

  fastify.log.info('Analytics routes registered');
}
