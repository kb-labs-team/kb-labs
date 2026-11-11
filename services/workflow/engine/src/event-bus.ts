import {
  WORKFLOW_REDIS_CHANNEL,
  type WorkflowEventName,
} from '@kb-labs/workflow-constants'
import type { IEventBus } from '@kb-labs/core-platform'
import type { EngineLogger } from './types'

export interface WorkflowEvent<TPayload = Record<string, unknown>> {
  type: WorkflowEventName
  runId: string
  sequence: number
  jobId?: string
  stepId?: string
  payload?: TPayload
  timestamp?: string
}

export class EventBusBridge {
  private readonly events: IEventBus
  private readonly channel = WORKFLOW_REDIS_CHANNEL

  constructor(
    events: IEventBus,
    private readonly logger: EngineLogger,
  ) {
    this.events = events
  }

  async publish<TPayload = Record<string, unknown>>(
    event: WorkflowEvent<TPayload>,
  ): Promise<void> {
    const payload = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    }
    await this.events.publish(this.channel, payload)
    this.logger.debug('Workflow event published', {
      channel: this.channel,
      type: event.type,
      runId: event.runId,
    })
  }
}


