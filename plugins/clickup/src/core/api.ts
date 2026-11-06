import { clickupFetch } from './client.js';
import type {
  ClickUpWorkspace,
  ClickUpSpace,
  ClickUpSpaceDetail,
  ClickUpFolder,
  ClickUpList,
  ClickUpTask,
  ClickUpComment,
  ClickUpCommentCreateResult,
  ClickUpStatus,
  CreateTaskInput,
  UpdateTaskInput,
  CreateSpaceInput,
  UpdateSpaceInput,
  CreateFolderInput,
  UpdateFolderInput,
  CreateListInput,
  UpdateListInput,
} from '../contracts/index.js';

// ── Workspace / Hierarchy ────────────────────────────────────────────────────

async function resolveTeam(
  apiKey: string,
  teamIdHint: string,
): Promise<{ id: string; name: string }> {
  const res = await clickupFetch<{ teams: Array<{ id: string; name: string }> }>('/team', apiKey);
  const team = res.teams.find(t => t.id === teamIdHint) ?? res.teams[0];
  if (!team) { throw new Error(`No ClickUp team found for CLICKUP_TEAM_ID=${teamIdHint}`); }
  return team;
}

export async function getWorkspaceHierarchy(
  apiKey: string,
  teamId: string,
): Promise<ClickUpWorkspace> {
  const team = await resolveTeam(apiKey, teamId);

  const spacesRes = await clickupFetch<{ spaces: ClickUpSpace[] }>(
    `/team/${team.id}/space?archived=false`,
    apiKey,
  );

  const spaces = await Promise.all(
    spacesRes.spaces.map(async space => {
      const [foldersRes, listsRes] = await Promise.all([
        clickupFetch<{ folders: ClickUpFolder[] }>(`/space/${space.id}/folder?archived=false`, apiKey),
        clickupFetch<{ lists: ClickUpList[] }>(`/space/${space.id}/list?archived=false`, apiKey),
      ]);

      const folders = await Promise.all(
        foldersRes.folders.map(async folder => {
          const folderListsRes = await clickupFetch<{ lists: ClickUpList[] }>(
            `/folder/${folder.id}/list?archived=false`,
            apiKey,
          );
          return { ...folder, lists: folderListsRes.lists };
        }),
      );

      return { ...space, folders, lists: listsRes.lists };
    }),
  );

  return { id: team.id, name: team.name, spaces };
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export interface SearchTasksParams {
  query?: string;
  list_ids?: string[];
  statuses?: string[];
  assignees?: string[];
  limit?: number;
  page?: number;
  include_closed?: boolean;
}

export async function searchTasks(
  apiKey: string,
  teamId: string,
  params: SearchTasksParams = {},
): Promise<ClickUpTask[]> {
  const qs = new URLSearchParams();
  if (params.query) { qs.set('query', params.query); }
  if (params.list_ids?.length) { params.list_ids.forEach(id => qs.append('list_ids[]', id)); }
  if (params.statuses?.length) { params.statuses.forEach(s => qs.append('statuses[]', s)); }
  if (params.assignees?.length) { params.assignees.forEach(a => qs.append('assignees[]', a)); }
  qs.set('page', String(params.page ?? 0));
  qs.set('limit', String(Math.min(params.limit ?? 20, 100)));
  if (params.include_closed) { qs.set('include_closed', 'true'); }
  qs.set('subtasks', 'true');

  const team = await resolveTeam(apiKey, teamId);
  const res = await clickupFetch<{ tasks: ClickUpTask[] }>(
    `/team/${team.id}/task?${qs}`,
    apiKey,
  );
  return res.tasks;
}

export async function getTask(apiKey: string, taskId: string): Promise<ClickUpTask> {
  return clickupFetch<ClickUpTask>(
    `/task/${taskId}?include_subtasks=true`,
    apiKey,
  );
}

export async function createTask(
  apiKey: string,
  listId: string,
  body: CreateTaskInput,
): Promise<ClickUpTask> {
  return clickupFetch<ClickUpTask>(`/list/${listId}/task`, apiKey, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateTask(
  apiKey: string,
  taskId: string,
  body: UpdateTaskInput,
): Promise<ClickUpTask> {
  return clickupFetch<ClickUpTask>(`/task/${taskId}`, apiKey, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteTask(apiKey: string, taskId: string): Promise<void> {
  await clickupFetch<void>(`/task/${taskId}`, apiKey, { method: 'DELETE' });
}

// ── List ─────────────────────────────────────────────────────────────────────

export interface ListTasksParams {
  statuses?: string[];
  assignees?: string[];
  limit?: number;
  page?: number;
  include_closed?: boolean;
}

export async function getListTasks(
  apiKey: string,
  listId: string,
  params: ListTasksParams = {},
): Promise<ClickUpTask[]> {
  const qs = new URLSearchParams();
  if (params.statuses?.length) { params.statuses.forEach(s => qs.append('statuses[]', s)); }
  if (params.assignees?.length) { params.assignees.forEach(a => qs.append('assignees[]', a)); }
  qs.set('page', String(params.page ?? 0));
  if (params.include_closed) { qs.set('include_closed', 'true'); }
  qs.set('subtasks', 'true');

  const res = await clickupFetch<{ tasks: ClickUpTask[] }>(
    `/list/${listId}/task?${qs}`,
    apiKey,
  );
  return res.tasks;
}

export async function getListStatuses(
  apiKey: string,
  listId: string,
): Promise<ClickUpStatus[]> {
  const res = await clickupFetch<{ statuses: ClickUpStatus[] }>(
    `/list/${listId}`,
    apiKey,
  );
  return res.statuses ?? [];
}

// ── Comments ─────────────────────────────────────────────────────────────────

export async function getTaskComments(
  apiKey: string,
  taskId: string,
): Promise<ClickUpComment[]> {
  const res = await clickupFetch<{ comments: ClickUpComment[] }>(
    `/task/${taskId}/comment`,
    apiKey,
  );
  return res.comments ?? [];
}

export async function addTaskComment(
  apiKey: string,
  taskId: string,
  commentText: string,
  options: { assignee?: number; notifyAll?: boolean } = {},
): Promise<ClickUpCommentCreateResult> {
  return clickupFetch<ClickUpCommentCreateResult>(`/task/${taskId}/comment`, apiKey, {
    method: 'POST',
    body: JSON.stringify({
      comment_text: commentText,
      assignee: options.assignee,
      notify_all: options.notifyAll ?? false,
    }),
  });
}

// ── Spaces ────────────────────────────────────────────────────────────────────

export async function createSpace(
  apiKey: string,
  teamId: string,
  body: CreateSpaceInput,
): Promise<ClickUpSpaceDetail> {
  const team = await resolveTeam(apiKey, teamId);
  return clickupFetch<ClickUpSpaceDetail>(`/team/${team.id}/space`, apiKey, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateSpace(
  apiKey: string,
  spaceId: string,
  body: UpdateSpaceInput,
): Promise<ClickUpSpaceDetail> {
  return clickupFetch<ClickUpSpaceDetail>(`/space/${spaceId}`, apiKey, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteSpace(apiKey: string, spaceId: string): Promise<void> {
  await clickupFetch<void>(`/space/${spaceId}`, apiKey, { method: 'DELETE' });
}

// ── Folders ───────────────────────────────────────────────────────────────────

export async function createFolder(
  apiKey: string,
  spaceId: string,
  body: CreateFolderInput,
): Promise<ClickUpFolder> {
  return clickupFetch<ClickUpFolder>(`/space/${spaceId}/folder`, apiKey, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateFolder(
  apiKey: string,
  folderId: string,
  body: UpdateFolderInput,
): Promise<ClickUpFolder> {
  return clickupFetch<ClickUpFolder>(`/folder/${folderId}`, apiKey, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteFolder(apiKey: string, folderId: string): Promise<void> {
  await clickupFetch<void>(`/folder/${folderId}`, apiKey, { method: 'DELETE' });
}

// ── Lists (create/update/delete) ──────────────────────────────────────────────

export async function createListInFolder(
  apiKey: string,
  folderId: string,
  body: CreateListInput,
): Promise<ClickUpList> {
  return clickupFetch<ClickUpList>(`/folder/${folderId}/list`, apiKey, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function createListInSpace(
  apiKey: string,
  spaceId: string,
  body: CreateListInput,
): Promise<ClickUpList> {
  return clickupFetch<ClickUpList>(`/space/${spaceId}/list`, apiKey, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateList(
  apiKey: string,
  listId: string,
  body: UpdateListInput,
): Promise<ClickUpList> {
  return clickupFetch<ClickUpList>(`/list/${listId}`, apiKey, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteList(apiKey: string, listId: string): Promise<void> {
  await clickupFetch<void>(`/list/${listId}`, apiKey, { method: 'DELETE' });
}
