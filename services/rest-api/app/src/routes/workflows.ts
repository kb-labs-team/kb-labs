/**
 * @module @kb-labs/rest-api-app/routes/workflows
 * Workflow SSE streaming endpoint.
 *
 * All CRUD operations (list runs, get run, cancel, run workflow) are handled
 * by the project-scoped workflow service route (/api/v1/projects/:projectId/workflow/...).
 * This file only provides the SSE event stream which requires a long-lived
 * connection that cannot go through the plugin execution backend.
 */

import type { FastifyInstance } from 'fastify'
import type { RestApiConfig } from '@kb-labs/rest-api-core'
import { WORKFLOW_REDIS_CHANNEL } from '@kb-labs/workflow-constants'
import { platform } from '@kb-labs/core-runtime'
import { normalizeBasePath } from './path-helpers'
import { createSseStream } from '@kb-labs/shared-http'

interface HttpError extends Error {
  statusCode: number;
  code: string;
}

const TERMINAL_EVENT_TYPES = ['run.finished', 'run.failed', 'run.cancelled']
const KEEP_ALIVE_MS = 30_000
const IDLE_TIMEOUT_MS = 60_000
const EVENT_BUS_KEY = `eventbus:${WORKFLOW_REDIS_CHANNEL}`

/**
 * Replay past events for a runId from the Redis sorted set.
 * Returns true if a terminal event was found (run already finished).
 */
async function replayHistory(
  runId: string,
  sendEvent: (type: string, payload: unknown, timestamp?: string) => void,
): Promise<boolean> {
  let hasTerminal = false
  try {
    const cache = platform.cache
    if (!cache?.zrangebyscore) {return false}

    const stored = await cache.zrangebyscore(EVENT_BUS_KEY, 0, Date.now())
    for (const raw of stored) {
      try {
        const wrapper = JSON.parse(raw) as { data: { type: string; runId: string; payload?: unknown; timestamp?: string } }
        const event = wrapper.data
        if (event.runId !== runId) {continue}
        sendEvent(event.type, event.payload, event.timestamp)
        if (TERMINAL_EVENT_TYPES.includes(event.type)) {
          hasTerminal = true
        }
      } catch { /* skip malformed entries */ }
    }
  } catch { /* cache unavailable — skip replay */ }
  return hasTerminal
}

export async function registerWorkflowRoutes(
  server: FastifyInstance,
  config: RestApiConfig,
): Promise<void> {
  const basePath = normalizeBasePath(config.basePath)

  // SSE stream of workflow run events via shared IEventBus.
  // No local engine needed — events arrive through the distributed event bus
  // (state broker / Redis / Kafka). The daemon publishes, we subscribe.
  server.route({
    method: 'GET',
    url: `${basePath}/workflows/runs/:runId/events`,
    config: { ux: 'raw' },
    schema: {
      params: { type: 'object', properties: { runId: { type: 'string', minLength: 1 } }, required: ['runId'], additionalProperties: false },
      querystring: { type: 'object', additionalProperties: false },
    },
    handler: async (request, reply) => {
      const runId = getRunId(request.params)

      const origin = request.headers.origin
      const stream = createSseStream(request, reply, {
        logger: request.kbLogger ?? platform.logger,
        serviceId: 'rest',
        route: `${basePath}/workflows/runs/:runId/events`,
        keepAliveMs: KEEP_ALIVE_MS,
        headers: typeof origin === 'string' && (origin === 'http://localhost:3000' || origin === 'http://localhost:5173')
          ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }
          : undefined,
      })

      const sentIds = new Set<string>()

      const sendEvent = (type: string, payload: unknown, timestamp?: string) => {
        const data = { type, runId, payload, timestamp: timestamp ?? new Date().toISOString() }
        // Dedup by type+timestamp to avoid replaying events that also arrive live
        const dedup = `${type}:${data.timestamp}`
        if (sentIds.has(dedup)) {return}
        sentIds.add(dedup)
        stream.send('workflow.event', data)
      }

      // Replay history — send past events for this run
      const alreadyFinished = await replayHistory(runId, sendEvent)
      if (alreadyFinished) {
        stream.close('run_already_finished')
        return
      }

      let idleTimer: ReturnType<typeof setTimeout> | null = null

      const resetIdle = () => {
        if (idleTimer) {clearTimeout(idleTimer)}
        idleTimer = setTimeout(() => {
          cleanup()
        }, IDLE_TIMEOUT_MS)
      }

      const unsubscribe = platform.eventBus.subscribe(WORKFLOW_REDIS_CHANNEL, async (rawEvent: unknown) => {
        const event = rawEvent as { type: string; runId: string; payload?: unknown; timestamp?: string }
        if (event.runId !== runId) {return}
        sendEvent(event.type, event.payload, event.timestamp)
        resetIdle()
        if (TERMINAL_EVENT_TYPES.includes(event.type)) {
          cleanup()
        }
      })

      const cleanup = () => {
        unsubscribe()
        if (idleTimer) {clearTimeout(idleTimer)}
        stream.send('workflow.done', {})
        stream.close('workflow_complete')
      }

      resetIdle()
      stream.onCleanup(() => {
        if (idleTimer) {clearTimeout(idleTimer)}
        unsubscribe()
      })
      await stream.closed
    },
  })

  // SSE stream of workflow run logs via shared IEventBus.
  // Sends all events for a run as `workflow.log` entries with jobId/stepId context.
  server.route({
    method: 'GET',
    url: `${basePath}/workflows/runs/:runId/logs`,
    config: { ux: 'raw' },
    schema: {
      params: { type: 'object', properties: { runId: { type: 'string', minLength: 1 } }, required: ['runId'], additionalProperties: false },
      querystring: {
        type: 'object',
        properties: { idleTimeoutMs: { type: 'string', pattern: '^[1-9][0-9]*$' } },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      const runId = getRunId(request.params)
      const query = request.query as { idleTimeoutMs?: string }
      const idleTimeout = query.idleTimeoutMs ? parseInt(query.idleTimeoutMs, 10) : IDLE_TIMEOUT_MS

      const origin = request.headers.origin
      const stream = createSseStream(request, reply, {
        logger: request.kbLogger ?? platform.logger,
        serviceId: 'rest',
        route: `${basePath}/workflows/runs/:runId/logs`,
        keepAliveMs: KEEP_ALIVE_MS,
        headers: typeof origin === 'string' && (origin === 'http://localhost:3000' || origin === 'http://localhost:5173')
          ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }
          : undefined,
      })

      const sentLogIds = new Set<string>()

      const sendLog = (event: { type: string; runId: string; jobId?: string; stepId?: string; payload?: unknown; timestamp?: string }) => {
        const ts = event.timestamp ?? new Date().toISOString()
        const dedup = `${event.type}:${event.jobId ?? ''}:${event.stepId ?? ''}:${ts}`
        if (sentLogIds.has(dedup)) {return}
        sentLogIds.add(dedup)
        stream.send('workflow.log', {
          type: event.type,
          runId: event.runId,
          jobId: event.jobId,
          stepId: event.stepId,
          payload: event.payload,
          timestamp: ts,
        })
      }

      // Replay history for logs
      let logsAlreadyFinished = false
      try {
        const cache = platform.cache
        if (cache?.zrangebyscore) {
          const stored = await cache.zrangebyscore(EVENT_BUS_KEY, 0, Date.now())
          for (const rawStr of stored) {
            try {
              const wrapper = JSON.parse(rawStr) as { data: { type: string; runId: string; jobId?: string; stepId?: string; payload?: unknown; timestamp?: string } }
              const ev = wrapper.data
              if (ev.runId !== runId) {continue}
              sendLog(ev)
              if (TERMINAL_EVENT_TYPES.includes(ev.type)) {logsAlreadyFinished = true}
            } catch { /* skip */ }
          }
        }
      } catch { /* cache unavailable */ }

      if (logsAlreadyFinished) {
        stream.send('workflow.done', {})
        stream.close('run_already_finished')
        return
      }

      let idleTimer: ReturnType<typeof setTimeout> | null = null

      const resetIdle = () => {
        if (idleTimer) {clearTimeout(idleTimer)}
        idleTimer = setTimeout(() => {
          cleanup()
        }, idleTimeout)
      }

      const unsubscribe = platform.eventBus.subscribe(WORKFLOW_REDIS_CHANNEL, async (rawEvent: unknown) => {
        const event = rawEvent as { type: string; runId: string; jobId?: string; stepId?: string; payload?: unknown; timestamp?: string }
        if (event.runId !== runId) {return}
        sendLog(event)
        resetIdle()
        if (TERMINAL_EVENT_TYPES.includes(event.type)) {
          cleanup()
        }
      })

      const cleanup = () => {
        unsubscribe()
        if (idleTimer) {clearTimeout(idleTimer)}
        stream.send('workflow.done', {})
        stream.close('workflow_complete')
      }

      resetIdle()
      stream.onCleanup(() => {
        if (idleTimer) {clearTimeout(idleTimer)}
        unsubscribe()
      })
      await stream.closed
    },
  })
}

function getRunId(params: unknown): string {
  const runId = (params as { runId?: unknown } | undefined)?.runId
  if (!runId || typeof runId !== 'string') {
    const error = new Error('runId must be provided') as HttpError
    error.statusCode = 400
    error.code = 'WF_RUN_ID_REQUIRED'
    throw error
  }
  return runId
}
