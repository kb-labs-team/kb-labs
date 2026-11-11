/**
 * Tool factory for creating agent tools in a consistent way.
 *
 * Generic over TContext so it can be used with any tool context type —
 * the consumer passes their own ToolContext without creating a cross-repo dependency.
 *
 * ---
 *
 * TODO: ToolShape/ToolResult type mismatch — migration to createTool is blocked
 *
 * Problem:
 *   `ToolShape.executor` returns `Promise<unknown>`, but agent-tools' `Tool.executor`
 *   expects `Promise<ToolResult>` (from @kb-labs/agents/contracts). This makes
 *   `registry.register(createSpawnAgentTool(context))` fail to type-check because
 *   `ToolShape` is not assignable to `Tool`.
 *
 * Root cause:
 *   `ToolResult` lives in `@kb-labs/agents/contracts` (agent-specific repo).
 *   `shared-tool-kit` (kb-labs-shared) cannot import from agent-contracts without
 *   creating a cross-repo dependency, which violates layering.
 *
 * Planned fix options (pick one):
 *   A) Add `TResult` type parameter to `ToolShape` and `ToolSpec`:
 *        `ToolShape<TContext, TResult = unknown>`
 *        `ToolSpec<TInput, TContext, TResult = unknown>`
 *      Then agent-tools can call `createTool<Input, Context, ToolResult>(...)` and
 *      get back a properly typed `ToolShape<Context, ToolResult>` that satisfies `Tool`.
 *      No new cross-repo dependency needed — ToolResult stays in agent-contracts.
 *
 *   B) Move `ToolResult` to a platform-level package (e.g. core-platform or a new
 *      shared-contracts package) so shared-tool-kit can import it directly and
 *      `ToolShape.executor` returns `Promise<ToolResult>` out of the box.
 *      More "correct" architecturally but requires more refactoring.
 *
 * Current state:
 *   delegation.ts in agent-tools was reverted to manual factory pattern (not using
 *   createTool) until this is resolved. Migration is planned as a follow-up task.
 */

/**
 * OpenAI Function Calling compatible tool definition.
 * Mirrors the structure expected by LLM APIs.
 */
export interface ToolDefinitionShape {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/**
 * A registered tool: definition for the LLM + executor function.
 */
export interface ToolShape<TContext = unknown> {
  definition: ToolDefinitionShape;
  executor: (input: Record<string, unknown>) => Promise<unknown>;
  /** The context this tool was created with (for inspection/testing) */
  _context?: TContext;
}

/**
 * Specification for creating a tool via createTool().
 */
export interface ToolSpec<TInput extends Record<string, unknown> = Record<string, unknown>, TContext = unknown> {
  /** Tool name (used in LLM function calling) */
  name: string;
  /** Human-readable description shown to the LLM */
  description: string;
  /** JSON Schema for the tool's input parameters */
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Tool implementation — receives typed input and context */
  execute: (input: TInput, context: TContext) => Promise<unknown>;
}

/**
 * Create a tool factory function from a spec.
 *
 * Returns a factory `(context: TContext) => ToolShape` — matching the
 * existing pattern in agent-tools where each `createXxxTool(context)` returns a Tool.
 *
 * @example
 * ```ts
 * const myToolFactory = createTool({
 *   name: 'my_tool',
 *   description: 'Does something useful',
 *   parameters: {
 *     type: 'object',
 *     properties: { value: { type: 'string' } },
 *     required: ['value'],
 *   },
 *   execute: async ({ value }, context) => {
 *     return { success: true, output: `Got: ${value}` };
 *   },
 * });
 *
 * // In tool registry:
 * const tool = myToolFactory(context);
 * registry.register(tool);
 * ```
 */
export function createTool<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
>(spec: ToolSpec<TInput, TContext>): (context: TContext) => ToolShape<TContext> {
  return (context: TContext): ToolShape<TContext> => ({
    definition: {
      type: 'function',
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    },
    executor: (input: Record<string, unknown>) => spec.execute(input as TInput, context),
  });
}
