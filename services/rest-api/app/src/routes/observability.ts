import { withUxErrorResponses } from './route-schema.js';
/**
 * @module @kb-labs/rest-api-app/routes/observability
 * Observability endpoints for monitoring system internals
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import { createErrorEnvelope, getHostServiceAddress, HostServiceAddressError } from '@kb-labs/core-platform';
import { normalizeBasePath, resolvePaths } from './path-helpers';
import { hostname } from 'node:os';
import type { HistoricalMetricsCollector } from '../daemon/metrics';
import type { SystemMetrics } from '../daemon/metrics';
import { metricsCollector } from '../middleware/metrics.js';


/**
 * Register observability routes
 *
 * These are system-level observability endpoints that expose internal metrics
 * and health information about platform components (State Broker, DevKit, etc.)
 */
export async function registerObservabilityRoutes(
  fastify: FastifyInstance,
  config: RestApiConfig,
  historicalMetrics?: HistoricalMetricsCollector,
  platform?: PlatformServices
): Promise<void> {
  const basePath = normalizeBasePath(config.basePath);
  const stateBrokerPaths = resolvePaths(basePath, '/observability/state-broker');
  const systemMetricsPaths = resolvePaths(basePath, '/observability/system-metrics');
  const metricsHistoryPaths = resolvePaths(basePath, '/observability/metrics/history');
  const metricsHeatmapPaths = resolvePaths(basePath, '/observability/metrics/heatmap');
  const insightsChatPaths = resolvePaths(basePath, '/observability/insights/chat');

  // GET /api/v1/observability/state-broker
  // Returns statistics from State Broker daemon (cache hits, namespaces, etc.)
  for (const path of stateBrokerPaths) {
    fastify.get(path, { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { tags: ['Observability'], summary: 'State Broker statistics', querystring: { type: 'object', additionalProperties: false }, response: withUxErrorResponses({ 200: { type: 'object', properties: { ok: { const: true }, data: { type: 'object', properties: { uptime: { type: 'number' }, totalEntries: { type: 'integer' }, totalSize: { type: 'integer' }, hitRate: { type: 'number' }, missRate: { type: 'number' }, evictions: { type: 'integer' }, namespaces: { type: 'object', additionalProperties: { type: 'object', properties: { entries: { type: 'integer' }, size: { type: 'integer' }, oldestEntry: { type: 'number' } }, required: ['entries', 'size', 'oldestEntry'], additionalProperties: false } }, byTenant: { type: 'object', additionalProperties: { type: 'object', properties: { entries: { type: 'integer' }, size: { type: 'integer' }, lastAccess: { type: 'number' } }, required: ['entries', 'size', 'lastAccess'], additionalProperties: false } } }, required: ['uptime', 'totalEntries', 'totalSize', 'hitRate', 'missRate', 'evictions', 'namespaces'], additionalProperties: false }, meta: { type: 'object', properties: { source: { const: 'state-broker' }, daemonUrl: { type: 'string', format: 'uri' } }, required: ['source', 'daemonUrl'], additionalProperties: false } }, required: ['ok', 'data', 'meta'], additionalProperties: false } }) } }, async (_request, reply) => {
      try {
        const stateBrokerUrl = getHostServiceAddress('state-broker');

        fastify.log.debug({ url: stateBrokerUrl }, 'Fetching State Broker stats');

        const response = await fetch(`${stateBrokerUrl}/stats`, {
          signal: AbortSignal.timeout(5000), // 5s timeout
        });

        if (!response.ok) {
          fastify.log.warn({
            status: response.status,
            url: stateBrokerUrl,
          }, 'State Broker responded with error');

          return reply.code(503).send({
            ok: false,
            error: createErrorEnvelope('KB_SERVICE_UNAVAILABLE', {
              message: 'State Broker daemon is not available.',
              hint: 'Run `kb-dev status` to inspect the State Broker service, then retry the request.',
              details: { service: 'state-broker', status: String(response.status) },
            }),
          });
        }

        const stats = await response.json() as Record<string, unknown>;

        fastify.log.debug({
          totalEntries: stats.totalEntries,
          hitRate: stats.hitRate,
        }, 'State Broker stats retrieved successfully');

        return {
          ok: true,
          data: stats,
          meta: {
            source: 'state-broker',
            daemonUrl: stateBrokerUrl,
          },
        };
      } catch (error) {
        platform?.logger.error('Failed to fetch State Broker stats', error instanceof Error ? error : new Error(String(error)));

        // Check if it's a timeout error
        const isTimeout = error instanceof Error && error.name === 'AbortError';

        return reply.code(503).send({
          ok: false,
          error: error instanceof HostServiceAddressError
            ? createErrorEnvelope(error.code, {
                message: error.message,
                hint: error.hint,
                details: { service: 'state-broker' },
              })
            : createErrorEnvelope('KB_SERVICE_UNAVAILABLE', {
                message: isTimeout ? 'State Broker daemon did not respond in time.' : 'Failed to reach the State Broker daemon.',
                hint: 'Run `kb-dev status` to inspect the State Broker service, then retry the request.',
                details: { service: 'state-broker', timeout: String(isTimeout) },
              }),
        });
      }
    });
  }


  // GET /api/v1/observability/system-metrics
  // Returns system resource metrics (CPU, memory, uptime, load) from all REST API instances
  for (const path of systemMetricsPaths) {
    fastify.get(path, { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { tags: ['Observability'], summary: 'System resource metrics', querystring: { type: 'object', additionalProperties: false }, response: withUxErrorResponses({ 200: { type: 'object', properties: { ok: { const: true }, data: { type: 'object', properties: { instances: { type: 'array', items: { type: 'object', properties: { instanceId: { type: 'string' }, timestamp: { type: 'number' }, cpuPercent: { type: 'number' }, rssBytes: { type: 'number' }, heapUsedBytes: { type: 'number' }, eventLoopLagMs: { type: 'number' }, activeOperations: { type: 'number' } }, required: ['timestamp'], additionalProperties: false } }, summary: { type: 'object', properties: { totalInstances: { type: 'integer' }, activeInstances: { type: 'integer' }, staleInstances: { type: 'integer' }, deadInstances: { type: 'integer' }, avgCpu: { type: 'number' }, avgMemory: { type: 'number' }, avgHeap: { type: 'number' } }, required: ['totalInstances', 'activeInstances', 'staleInstances', 'deadInstances', 'avgCpu', 'avgMemory', 'avgHeap'], additionalProperties: false } }, required: ['instances', 'summary'], additionalProperties: false }, meta: { type: 'object', properties: { source: { const: 'platform-cache' }, timestamp: { type: 'number' } }, required: ['source', 'timestamp'], additionalProperties: false } }, required: ['ok', 'data', 'meta'], additionalProperties: false } }) } }, async (_request, reply) => {
      try {
        if (!platform?.cache) {
          return reply.code(503).send({
            ok: false,
            error: {
              code: 'PLATFORM_CACHE_UNAVAILABLE',
              message: 'Platform cache is not available',
            },
          });
        }

        fastify.log.debug('Fetching system metrics from all instances');

        // Get all system-metrics:* keys from platform.cache
        const allMetrics: SystemMetrics[] = [];

        // Try to scan for all system-metrics keys
        // Note: platform.cache may not have scan(), so we'll handle both cases
        try {
          // Try to use scan if available (Redis adapter)
          const cacheWithScan = platform.cache as { scan?: (pattern: string) => Promise<string[]> };
          if ('scan' in platform.cache && typeof cacheWithScan.scan === 'function') {
            const keys = await cacheWithScan.scan('system-metrics:*');

            for (const key of keys) {
              const metrics = await platform.cache.get<SystemMetrics>(key);
              if (metrics) {
                allMetrics.push(metrics);
              }
            }
          } else {
            // Fallback: InMemory adapter doesn't have scan, but we can try common instance IDs
            // This is a limitation - we won't see all instances unless we track them separately
            // For now, we'll just try to get the current instance's metrics
            const currentInstanceId = hostname();
            const metrics = await platform.cache.get<SystemMetrics>(`system-metrics:${currentInstanceId}`);

            if (metrics) {
              allMetrics.push(metrics);
            }

            fastify.log.debug('Platform cache does not support scan(), showing current instance only');
          }
        } catch (scanError) {
          fastify.log.warn({ err: scanError }, 'Failed to scan platform.cache for system metrics');

          // Fallback: try current instance
          const currentInstanceId = hostname();
          const metrics = await platform.cache.get<SystemMetrics>(`system-metrics:${currentInstanceId}`);

          if (metrics) {
            allMetrics.push(metrics);
          }
        }

        if (allMetrics.length === 0) {
          return reply.code(404).send({
            ok: false,
            error: {
              code: 'NO_METRICS_FOUND',
              message: 'No system metrics found. Metrics collector may not be running.',
            },
          });
        }

        // Sort by timestamp (newest first)
        allMetrics.sort((a, b) => b.timestamp - a.timestamp);

        // Calculate aggregated metrics
        const now = Date.now();
        const avgCpu = allMetrics.reduce((sum, m) => sum + m.cpu.percentage, 0) / allMetrics.length;
        const avgMemory = allMetrics.reduce((sum, m) => sum + m.memory.rssPercentage, 0) / allMetrics.length;
        const avgHeap = allMetrics.reduce((sum, m) => sum + m.memory.heapPercentage, 0) / allMetrics.length;

        // Categorize instances by health status based on age
        const activeInstances = allMetrics.filter(m => (now - m.timestamp) < 30000); // Active if updated in last 30s
        const staleInstances = allMetrics.filter(m => (now - m.timestamp) >= 30000 && (now - m.timestamp) < 60000); // Stale if 30-60s old
        const deadInstances = allMetrics.filter(m => (now - m.timestamp) >= 60000); // Dead if >60s old

        fastify.log.debug({
          totalInstances: allMetrics.length,
          activeInstances: activeInstances.length,
          staleInstances: staleInstances.length,
          deadInstances: deadInstances.length,
        }, 'System metrics retrieved');

        return {
          ok: true,
          data: {
            instances: allMetrics,
            summary: {
              totalInstances: allMetrics.length,
              activeInstances: activeInstances.length,
              staleInstances: staleInstances.length,
              deadInstances: deadInstances.length,
              avgCpu: parseFloat(avgCpu.toFixed(2)),
              avgMemory: parseFloat(avgMemory.toFixed(2)),
              avgHeap: parseFloat(avgHeap.toFixed(2)),
            },
          },
          meta: {
            source: 'platform-cache',
            timestamp: now,
          },
        };
      } catch (error) {
        platform?.logger.error('Failed to fetch system metrics', error instanceof Error ? error : new Error(String(error)));

        return reply.code(500).send({
          ok: false,
          error: {
            code: 'SYSTEM_METRICS_ERROR',
            message: error instanceof Error ? error.message : 'Failed to fetch system metrics',
          },
        });
      }
    });
  }

  // GET /api/v1/observability/metrics/history
  // Returns historical time-series metrics data
  for (const path of metricsHistoryPaths) {
    fastify.get(path, {
      schema: {
        tags: ['Observability'],
        summary: 'Historical time-series metrics',
        querystring: {
          type: 'object',
          properties: {
            metric: {
              type: 'string',
              enum: ['requests', 'errors', 'latency', 'uptime'],
            },
            range: {
              type: 'string',
              enum: ['1m', '5m', '10m', '30m', '1h'],
            },
            interval: {
              type: 'string',
              enum: ['5s', '1m', '5m'],
            },
          },
          required: ['metric', 'range'],
          additionalProperties: false,
        },
        response: withUxErrorResponses({
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    timestamp: { type: 'number' },
                    value: { type: 'number' },
                  },
                },
              },
              meta: {
                type: 'object',
                properties: {
                  source: { type: 'string' },
                  metric: { type: 'string' },
                  range: { type: 'string' },
                  interval: { type: 'string' },
                  points: { type: 'number' },
                },
              },
            },
          },
        }),
      },
    }, async (request, reply: FastifyReply) => {
      if (!historicalMetrics) {
        return reply.code(503).send({
          ok: false,
          error: {
            code: 'HISTORICAL_METRICS_UNAVAILABLE',
            message: 'Historical metrics collector is not initialized',
          },
        });
      }

      const query = request.query as {
        metric: 'requests' | 'errors' | 'latency' | 'uptime';
        range: '1m' | '5m' | '10m' | '30m' | '1h';
        interval?: '5s' | '1m' | '5m';
      };

      try {
        fastify.log.debug({ query }, 'Querying historical metrics');

        const data = await historicalMetrics.queryHistory({
          metric: query.metric,
          range: query.range,
          interval: query.interval,
        });

        fastify.log.debug({
          metric: query.metric,
          range: query.range,
          points: data.length,
        }, 'Historical metrics retrieved');

        return {
          ok: true,
          data,
          meta: {
            source: 'historical-metrics-collector',
            metric: query.metric,
            range: query.range,
            interval: query.interval ?? '5s',
            points: data.length,
          },
        };
      } catch (error) {
        platform?.logger.error('Failed to query historical metrics', error instanceof Error ? error : new Error(String(error)), { query });

        return reply.code(500).send({
          ok: false,
          error: {
            code: 'HISTORICAL_METRICS_ERROR',
            message: error instanceof Error ? error.message : 'Failed to query historical metrics',
          },
        });
      }
    });
  }

  // GET /api/v1/observability/metrics/heatmap
  // Returns heatmap aggregated data (7 days × 24 hours)
  for (const path of metricsHeatmapPaths) {
    fastify.get(path, {
      schema: {
        tags: ['Observability'],
        summary: 'Metrics heatmap data',
        querystring: {
          type: 'object',
          properties: {
            metric: {
              type: 'string',
              enum: ['latency', 'errors', 'requests'],
            },
            days: {
              type: 'integer',
              enum: [7, 14, 30],
            },
          },
          required: ['metric'],
          additionalProperties: false,
        },
        response: withUxErrorResponses({
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    day: { type: 'string' },
                    hour: { type: 'number' },
                    value: { type: 'number' },
                  },
                },
              },
              meta: {
                type: 'object',
                properties: {
                  source: { type: 'string' },
                  metric: { type: 'string' },
                  days: { type: 'number' },
                  cells: { type: 'number' },
                },
              },
            },
          },
        }),
      },
    }, async (request, reply: FastifyReply) => {
      if (!historicalMetrics) {
        return reply.code(503).send({
          ok: false,
          error: {
            code: 'HISTORICAL_METRICS_UNAVAILABLE',
            message: 'Historical metrics collector is not initialized',
          },
        });
      }

      const query = request.query as {
        metric: 'latency' | 'errors' | 'requests';
        days?: 7 | 14 | 30;
      };

      try {
        fastify.log.debug({ query }, 'Querying heatmap data');

        const data = await historicalMetrics.queryHeatmap({
          metric: query.metric,
          days: query.days ?? 7,
        });

        fastify.log.debug({
          metric: query.metric,
          cells: data.length,
        }, 'Heatmap data retrieved');

        return {
          ok: true,
          data,
          meta: {
            source: 'historical-metrics-collector',
            metric: query.metric,
            days: query.days ?? 7,
            cells: data.length,
          },
        };
      } catch (error) {
        platform?.logger.error('Failed to query heatmap data', error instanceof Error ? error : new Error(String(error)), { query });

        return reply.code(500).send({
          ok: false,
          error: {
            code: 'HEATMAP_ERROR',
            message: error instanceof Error ? error.message : 'Failed to query heatmap data',
          },
        });
      }
    });
  }

  // POST /api/v1/observability/insights/chat
  // AI-powered insights chat using LLM with system metrics as context
  for (const path of insightsChatPaths) {
    fastify.post(path, {
      config: { uxFixture: { validResult: 'error-envelope' } },
      schema: {
        tags: ['Observability'],
        summary: 'AI-powered observability insights chat',
        body: {
          type: 'object',
          properties: {
            question: { type: 'string', minLength: 1 },
            context: {
              type: 'object',
              properties: {
                includeMetrics: { type: 'boolean' },
                includeHistory: { type: 'boolean' },
                timeRange: { type: 'string', enum: ['1h', '6h', '24h', '7d'] },
                plugins: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
          },
          required: ['question'],
          additionalProperties: false,
        },
        querystring: { type: 'object', additionalProperties: false },
        response: withUxErrorResponses({ 200: { type: 'object', properties: { ok: { const: true }, data: { type: 'object', properties: { answer: { type: 'string' }, context: { type: 'array', items: { type: 'string' } }, usage: { type: 'object', properties: { promptTokens: { type: 'integer' }, completionTokens: { type: 'integer' }, totalTokens: { type: 'integer' } }, required: ['promptTokens', 'completionTokens', 'totalTokens'], additionalProperties: false } }, required: ['answer', 'context', 'usage'], additionalProperties: false }, meta: { type: 'object', properties: { source: { const: 'llm-insights' }, model: { type: 'string' } }, required: ['source', 'model'], additionalProperties: false } }, required: ['ok', 'data', 'meta'], additionalProperties: false } }),
      },
    }, async (request, reply) => {
      if (!platform?.llm) {
        return reply.code(503).send({
          ok: false,
          error: {
            code: 'LLM_UNAVAILABLE',
            message: 'LLM adapter is not configured. AI Insights requires an LLM adapter.',
          },
        });
      }

      try {
        const body = request.body as {
          question: string;
          context?: {
            includeMetrics?: boolean;
            includeIncidents?: boolean;
            includeHistory?: boolean;
            timeRange?: '1h' | '6h' | '24h' | '7d';
            plugins?: string[];
          };
        };

        const contextConfig = {
          includeMetrics: body.context?.includeMetrics ?? true,
          includeHistory: body.context?.includeHistory ?? true,
          timeRange: body.context?.timeRange ?? '24h',
          plugins: body.context?.plugins ?? [],
        };

        // Build context from real data
        let contextText = '';

        // Fetch current metrics
        if (contextConfig.includeMetrics) {
          try {
            const metrics = metricsCollector.getMetrics();

            const errorRate = metrics.requests.total
              ? (((metrics.requests.clientErrors ?? 0) + (metrics.requests.serverErrors ?? 0)) / metrics.requests.total * 100)
              : 0;

            contextText += `\n## Current System Metrics\n`;
            contextText += `- Total requests: ${metrics.requests.total}\n`;
            contextText += `- Active requests: ${metrics.requests.active}\n`;
            contextText += `- Error rate: ${errorRate.toFixed(2)}%\n`;
            contextText += `- Average latency: ${metrics.latency.average.toFixed(0)}ms\n`;
            contextText += `- Max latency: ${metrics.latency.max.toFixed(0)}ms\n`;

            if (metrics.perPlugin.length > 0) {
              contextText += `\n### Per-Plugin Metrics\n`;
              const pluginsToShow = contextConfig.plugins.length > 0
                ? metrics.perPlugin.filter(plugin => plugin.pluginId && contextConfig.plugins.includes(plugin.pluginId))
                : metrics.perPlugin.slice(0, 10);

              for (const plugin of pluginsToShow) {
                const totalRequests = plugin.total ?? 0;
                const errorCount = Object.entries(plugin.statuses ?? {})
                  .filter(([statusGroup]) => statusGroup.startsWith('4') || statusGroup.startsWith('5'))
                  .reduce((sum, [, count]) => sum + count, 0);
                const pluginErrorRate = totalRequests > 0
                  ? (errorCount / totalRequests * 100).toFixed(2)
                  : '0.00';
                const avgLatency = totalRequests > 0 ? plugin.totalDuration / totalRequests : 0;
                contextText += `- ${plugin.pluginId ?? 'unknown'}: ${totalRequests} requests, ${pluginErrorRate}% errors, ${avgLatency.toFixed(0)}ms avg latency\n`;
              }
            }
          } catch (metricsError) {
            fastify.log.warn({ err: metricsError }, 'Failed to build metrics context for insights');
          }
        }

        // Build prompt
        const prompt = `You are an AI assistant analyzing a software platform's observability data.

${contextText}

User Question: ${body.question}

Provide a clear, actionable response based on the data above. Include:
1. Direct answer to the question
2. Supporting evidence from the metrics/incidents
3. Recommendations if applicable

Be concise but thorough. Use markdown formatting.`;

        fastify.log.debug({ question: body.question, contextLength: contextText.length }, 'Calling LLM for insights');

        const result = await platform.llm.complete(prompt, {
          systemPrompt: 'You are a DevOps and SRE expert assistant. Analyze system metrics and provide actionable insights. Be concise, technical, and helpful.',
          temperature: 0.7,
          maxTokens: 1000,
        });

        const totalTokens = result.usage.promptTokens + result.usage.completionTokens;

        fastify.log.debug({ tokensUsed: totalTokens }, 'LLM response received for insights');

        // Track analytics
        if (platform.analytics) {
          platform.analytics.track('ai_insights.chat', {
            questionLength: body.question.length,
            contextIncluded: Object.keys(contextConfig).filter(k => (contextConfig as Record<string, unknown>)[k]),
            timeRange: contextConfig.timeRange,
            pluginsFiltered: contextConfig.plugins.length,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens,
            model: result.model,
          }).catch(() => {
            // Silently ignore analytics errors
          });
        }

        return {
          ok: true,
          data: {
            answer: result.content.trim(),
            context: Object.keys(contextConfig).filter(k => (contextConfig as Record<string, unknown>)[k]),
            usage: {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
              totalTokens,
            },
          },
          meta: {
            source: 'llm-insights',
            model: result.model,
          },
        };
      } catch (error) {
        platform?.logger.error('Failed to generate insights', error instanceof Error ? error : new Error(String(error)));

        // Track error analytics
        if (platform?.analytics) {
          platform.analytics.track('ai_insights.error', {
            error: error instanceof Error ? error.message : 'Unknown error',
            questionLength: (request.body as { question?: string })?.question?.length ?? 0,
          }).catch(() => {
            // Silently ignore analytics errors
          });
        }

        return reply.code(500).send({
          ok: false,
          error: {
            code: 'INSIGHTS_ERROR',
            message: error instanceof Error ? error.message : 'Failed to generate insights',
          },
        });
      }
    });
  }

  fastify.log.info('Observability routes registered');
}
