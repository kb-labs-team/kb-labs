import { z } from 'zod';

export const CreateTaskSchema = z.object({
  name: z.string().min(1),
  markdown_content: z.string().optional(),
  status: z.string().optional(),
  priority: z.number().int().min(1).max(4).optional(),  // 1=urgent 2=high 3=normal 4=low
  assignees: z.array(z.number()).optional(),
  due_date: z.number().optional(),  // unix ms
  tags: z.array(z.string()).optional(),
  parent: z.string().optional(),    // subtask parent id
});

export const UpdateTaskSchema = z.object({
  name: z.string().min(1).optional(),
  markdown_content: z.string().optional(),
  status: z.string().optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  assignees: z.object({
    add: z.array(z.number()).optional(),
    rem: z.array(z.number()).optional(),
  }).optional(),
  due_date: z.number().nullable().optional(),
});

export const SearchTasksQuerySchema = z.object({
  query: z.string().optional(),
  list_ids: z.string().optional(),      // comma-separated
  statuses: z.string().optional(),      // comma-separated
  assignees: z.string().optional(),     // comma-separated user ids
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(0).default(0),
  include_closed: z.coerce.boolean().default(false),
});

export const ListTasksQuerySchema = z.object({
  statuses: z.string().optional(),
  assignees: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(0).default(0),
  include_closed: z.coerce.boolean().default(false),
});

export const AddCommentSchema = z.object({
  comment_text: z.string().min(1),
  assignee: z.number().optional(),
  notify_all: z.boolean().default(false),
});

export const CreateSpaceSchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  private: z.boolean().default(false),
});

export const UpdateSpaceSchema = z.object({
  name: z.string().min(1).optional(),
  color: z.string().nullable().optional(),
  private: z.boolean().optional(),
});

export const CreateFolderSchema = z.object({
  name: z.string().min(1),
});

export const UpdateFolderSchema = z.object({
  name: z.string().min(1),
});

export const CreateListSchema = z.object({
  name: z.string().min(1),
  content: z.string().optional(),
  status: z.string().optional(),
  priority: z.number().int().min(1).max(4).optional(),
  due_date: z.number().optional(),
  assignee: z.number().optional(),
});

export const UpdateListSchema = z.object({
  name: z.string().min(1).optional(),
  content: z.string().optional(),
  status: z.string().optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  due_date: z.number().nullable().optional(),
});

export type CreateSpaceInput = z.infer<typeof CreateSpaceSchema>;
export type UpdateSpaceInput = z.infer<typeof UpdateSpaceSchema>;
export type CreateFolderInput = z.infer<typeof CreateFolderSchema>;
export type UpdateFolderInput = z.infer<typeof UpdateFolderSchema>;
export type CreateListInput = z.infer<typeof CreateListSchema>;
export type UpdateListInput = z.infer<typeof UpdateListSchema>;

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type SearchTasksQuery = z.infer<typeof SearchTasksQuerySchema>;
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;
export type AddCommentInput = z.infer<typeof AddCommentSchema>;
