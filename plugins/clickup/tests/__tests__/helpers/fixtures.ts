import type {
  ClickUpTask,
  ClickUpComment,
  ClickUpCommentCreateResult,
  ClickUpFolder,
  ClickUpList,
  ClickUpSpace,
  ClickUpSpaceDetail,
  ClickUpStatus,
  ClickUpMember,
  ClickUpWorkspace,
} from '@kb-labs/clickup/contracts';

const mockStatus: ClickUpStatus = {
  id: '1',
  status: 'open',
  color: '#000000',
  type: 'open',
  orderindex: 0,
};

const mockMember: ClickUpMember = {
  id: 1,
  username: 'test-user',
  email: 'test@test.com',
  profilePicture: null,
};

export const mockTask: ClickUpTask = {
  id: 'task-001',
  name: 'Test Task',
  description: 'Test description',
  status: mockStatus,
  priority: null,
  assignees: [mockMember],
  creator: mockMember,
  list: { id: 'list-1', name: 'My List' },
  folder: { id: 'folder-1', name: 'My Folder' },
  space: { id: 'space-1' },
  url: 'https://app.clickup.com/t/task-001',
  due_date: null,
  date_created: '1700000000000',
  date_updated: '1700000000000',
  tags: [],
};

export const mockComment: ClickUpComment = {
  id: 'comment-1',
  comment: [{ text: 'Hello' }],
  comment_text: 'Hello',
  user: mockMember,
  date: '1700000000000',
  resolved: false,
};

// ClickUp's POST /task/{id}/comment endpoint returns a sparser shape than
// GET /task/{id}/comment — no `user`/`comment_text`/`resolved` fields.
export const mockCommentCreateResult: ClickUpCommentCreateResult = {
  id: 'comment-1',
  hist_id: 'hist-1',
  date: '1700000000000',
};

const mockListStatus: ClickUpStatus = {
  id: '2',
  status: 'in progress',
  color: '#0000ff',
  type: 'custom',
  orderindex: 1,
};

export const mockList: ClickUpList = {
  id: 'list-1',
  name: 'My List',
  orderindex: 0,
  status: mockListStatus,
  taskCount: 5,
};

export const mockFolder: ClickUpFolder = {
  id: 'folder-1',
  name: 'My Folder',
  orderindex: 0,
  lists: [mockList],
};

const mockSpaceBase: ClickUpSpace = {
  id: 'space-1',
  name: 'My Space',
  folders: [mockFolder],
  lists: [],
};

export const mockSpaceDetail: ClickUpSpaceDetail = {
  ...mockSpaceBase,
  private: false,
  statuses: [mockStatus],
  features: {},
};

export const mockWorkspace: ClickUpWorkspace = {
  id: 'ws-1',
  name: 'My Workspace',
  spaces: [mockSpaceBase],
};

export const mockStatuses: ClickUpStatus[] = [
  mockStatus,
  { id: '2', status: 'in progress', color: '#0000ff', type: 'custom', orderindex: 1 },
  { id: '3', status: 'done', color: '#00ff00', type: 'done', orderindex: 2 },
];
