/**
 * Greeting domain logic
 */

export interface Greeting {
  message: string;
  target: string;
  createdAt: Date;
}

const DEFAULT_TARGET = 'World';

/**
 * Creates a greeting with the given name
 *
 * @example
 * ```typescript
 * const greeting = createGreeting('Dev');
 * // { message: 'Hello, Dev!', target: 'Dev', createdAt: Date }
 *
 * const defaultGreeting = createGreeting();
 * // { message: 'Hello, World!', target: 'World', createdAt: Date }
 * ```
 */
export function createGreeting(name?: string, customMessage?: string): Greeting {
  const target = name?.trim() || DEFAULT_TARGET;
  const message = customMessage ?? `Hello, ${target}!`;

  return {
    message,
    target,
    createdAt: new Date(),
  };
}
