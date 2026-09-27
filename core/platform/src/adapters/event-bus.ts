/**
 * @module @kb-labs/core-platform/adapters/event-bus
 * Event bus abstraction for pub/sub messaging.
 */

/**
 * Event handler function type.
 */
export type EventHandler<T> = (event: T) => Promise<void>;

/**
 * Unsubscribe function returned by subscribe.
 */
export type Unsubscribe = (() => void) & { ready?: Promise<void> };

/**
 * Event bus adapter interface.
 * Implementations: MemoryEventBus (noop), can be extended with Redis/Kafka
 */
export interface IEventBus {
  /**
   * Publish an event to a topic.
   * @param topic - Event topic (e.g., 'workflow.completed')
   * @param event - Event payload
   */
  publish<T>(topic: string, event: T): Promise<void>;

  /**
   * Subscribe to events on a topic.
   * @param topic - Event topic (supports wildcards: 'workflow.*')
   * @param handler - Event handler function
   * @returns Unsubscribe function
   */
  subscribe<T>(topic: string, handler: EventHandler<T>): Unsubscribe;
}
