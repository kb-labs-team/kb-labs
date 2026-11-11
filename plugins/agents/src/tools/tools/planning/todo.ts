/**
 * TODO tools for task planning and progress tracking
 */

import type { Tool, ToolContext } from '../../types.js';
import type { TodoList, TodoItem } from '../../../contracts/index.js';
import { toolError } from '../shared/tool-error.js';
import { TODO_CONFIG } from '../../config.js';

// In-memory TODO storage (session-scoped)
const todoLists = new Map<string, TodoList>();
const TODO_CACHE_PREFIX = TODO_CONFIG.cachePrefix;
const TODO_CACHE_TTL_MS = TODO_CONFIG.cacheTtlMs;

/**
 * Get a summary of the todo list for a session.
 * Used by Status Block (FactSheetMiddleware) to display todo progress.
 */
export function getTodoSummary(sessionId: string): { completed: number; total: number; inProgress: number; pending: number; blocked: number } | null {
  const list = todoLists.get(sessionId);
  if (!list || list.items.length === 0) {return null;}
  return {
    completed: list.items.filter(i => i.status === 'completed').length,
    inProgress: list.items.filter(i => i.status === 'in-progress').length,
    pending: list.items.filter(i => i.status === 'pending').length,
    blocked: list.items.filter(i => i.status === 'blocked').length,
    total: list.items.length,
  };
}

function getTodoCacheKey(sessionId: string): string {
  return `${TODO_CACHE_PREFIX}${sessionId}`;
}

async function loadTodoList(context: ToolContext, sessionId: string): Promise<TodoList | null> {
  if (context.cache) {
    const cached = await context.cache.get<TodoList>(getTodoCacheKey(sessionId));
    if (cached) {
      todoLists.set(sessionId, cached);
      return cached;
    }
  }
  return todoLists.get(sessionId) ?? null;
}

async function persistTodoList(context: ToolContext, todoList: TodoList): Promise<void> {
  todoLists.set(todoList.sessionId, todoList);
  if (context.cache) {
    await context.cache.set(getTodoCacheKey(todoList.sessionId), todoList, TODO_CACHE_TTL_MS);
  }
}

function resolveTodoItem(todoList: TodoList, sessionId: string, itemId: string): TodoItem | null {
  const direct = todoList.items.find((i) => i.id === itemId);
  if (direct) {
    return direct;
  }

  const asIndex = Number(itemId);
  if (Number.isFinite(asIndex) && asIndex >= 1) {
    const indexed = todoList.items.find((i) => i.id === `${sessionId}-${Math.floor(asIndex)}`);
    if (indexed) {
      return indexed;
    }
  }

  const normalized = itemId.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const descriptionMatches = todoList.items.filter(
    (i) => i.description.toLowerCase().includes(normalized)
  );
  if (descriptionMatches.length === 1) {
    return descriptionMatches[0]!;
  }

  return null;
}

/**
 * Create TODO list with tasks
 */
export function createTodoCreateTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'todo_create',
        description: 'Create a TODO list to track task progress. Optional - use if helpful for planning complex tasks.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session identifier to associate TODO list',
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: {
                    type: 'string',
                    description: 'Task description',
                  },
                  priority: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                    description: 'Task priority',
                  },
                },
                required: ['description'],
              },
              description: 'List of tasks',
            },
          },
          required: ['sessionId', 'items'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const sessionId = input.sessionId as string;
      const items = input.items as Array<{
        description: string;
        priority?: 'low' | 'medium' | 'high';
      }>;

      const todoItems: TodoItem[] = items.map((item, index) => ({
        id: `${sessionId}-${index + 1}`,
        description: item.description,
        status: 'pending',
        priority: item.priority || 'medium',
        createdAt: new Date().toISOString(),
      }));

      const todoList: TodoList = {
        sessionId,
        items: todoItems,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await persistTodoList(context, todoList);

      const output = [
        `TODO list created for session: ${sessionId}`,
        '',
        ...todoItems.map(
          (item, i) => `${i + 1}. [ ] ${item.description} (${item.priority})`
        ),
      ].join('\n');

      return {
        success: true,
        output,
        metadata: {
          uiHint: 'todo',
          structured: { todoList },
        },
      };
    },
  };
}

/**
 * Update TODO item status
 */
export function createTodoUpdateTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'todo_update',
        description: 'Update status of a TODO item. Use to mark tasks as in-progress or completed.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session identifier',
            },
            itemId: {
              type: 'string',
              description: 'TODO item ID to update',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in-progress', 'completed', 'blocked'],
              description: 'New status',
            },
            notes: {
              type: 'string',
              description: 'Optional notes about the update',
            },
          },
          required: ['sessionId', 'itemId', 'status'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const sessionId = input.sessionId as string;
      const itemId = input.itemId as string;
      const status = input.status as TodoItem['status'];
      const notes = input.notes as string | undefined;

      const todoList = await loadTodoList(context, sessionId);

      if (!todoList) {
        return toolError({
          code: 'TODO_LIST_NOT_FOUND',
          message: `No TODO list found for session: ${sessionId}`,
          retryable: true,
          hint: 'Call todo_create first, then todo_update.',
          details: { sessionId },
        });
      }

      const item = resolveTodoItem(todoList, sessionId, itemId);

      if (!item) {
        return toolError({
          code: 'TODO_ITEM_NOT_FOUND',
          message: `TODO item not found: ${itemId}`,
          retryable: true,
          hint: 'Use todo_get to list valid item IDs, then retry with exact itemId.',
          details: {
            sessionId,
            itemId,
            knownIds: todoList.items.map((i) => i.id),
          },
        });
      }

      item.status = status;
      item.updatedAt = new Date().toISOString();

      if (notes) {
        item.notes = notes;
      }

      todoList.updatedAt = new Date().toISOString();
      await persistTodoList(context, todoList);

      const statusIcon =
        status === 'completed'
          ? '✓'
          : status === 'in-progress'
            ? '⏳'
            : status === 'blocked'
              ? '🚫'
              : ' ';

      const updatedList = await loadTodoList(context, sessionId);
      return {
        success: true,
        output: `[${statusIcon}] ${item.description} → ${status}${notes ? `\n  Note: ${notes}` : ''}`,
        metadata: {
          uiHint: 'todo',
          structured: { todoList: updatedList },
        },
      };
    },
  };
}

/**
 * Get TODO list status
 */
export function createTodoGetTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'todo_get',
        description: 'Get current TODO list with task statuses. Use to check progress.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session identifier',
            },
          },
          required: ['sessionId'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const sessionId = input.sessionId as string;

      const todoList = await loadTodoList(context, sessionId);

      if (!todoList) {
        return toolError({
          code: 'TODO_LIST_NOT_FOUND',
          message: `No TODO list found for session: ${sessionId}`,
          retryable: true,
          hint: 'Create a TODO list with todo_create before calling todo_get.',
          details: { sessionId },
        });
      }

      const completed = todoList.items.filter(i => i.status === 'completed')
        .length;
      const total = todoList.items.length;

      const output = [
        `TODO List for ${sessionId} (${completed}/${total} completed)`,
        '',
        ...todoList.items.map(item => {
          const icon =
            item.status === 'completed'
              ? '✓'
              : item.status === 'in-progress'
                ? '⏳'
                : item.status === 'blocked'
                  ? '🚫'
                  : ' ';
          return `[${icon}] ${item.description} (${item.priority})${item.notes ? `\n    ${item.notes}` : ''}`;
        }),
      ].join('\n');

      return {
        success: true,
        output,
        metadata: {
          uiHint: 'todo',
          structured: { todoList },
        },
      };
    },
  };
}
