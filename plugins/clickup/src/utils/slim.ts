import type { ClickUpTask } from '../contracts/index.js';

export function slimTask(task: ClickUpTask) {
  return {
    id:       task.id,
    name:     task.name,
    status:   task.status.status,
    priority: task.priority?.id ? Number(task.priority.id) : null,
    due_date: task.due_date ? Number(task.due_date) : null,
    url:      task.url,
  };
}

export function slimTaskWithDesc(task: ClickUpTask) {
  return { ...slimTask(task), description: task.description ?? '' };
}
