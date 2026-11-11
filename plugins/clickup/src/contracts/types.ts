export interface ClickUpStatus {
  id: string;
  status: string;
  color: string;
  type: string;
  orderindex: number;
}

export interface ClickUpMember {
  id: number;
  username: string;
  email: string;
  profilePicture: string | null;
}

export interface ClickUpList {
  id: string;
  name: string;
  orderindex: number;
  status: ClickUpStatus | null;
  taskCount?: number;
  statuses?: ClickUpStatus[];
}

export interface ClickUpFolder {
  id: string;
  name: string;
  orderindex: number;
  lists: ClickUpList[];
}

export interface ClickUpSpace {
  id: string;
  name: string;
  folders: ClickUpFolder[];
  lists: ClickUpList[];  // folderless lists
}

export interface ClickUpWorkspace {
  id: string;
  name: string;
  spaces: ClickUpSpace[];
}

export interface ClickUpTask {
  id: string;
  name: string;
  description?: string;
  status: ClickUpStatus;
  priority: { id: string; priority: string; color: string; orderindex: string } | null;
  assignees: ClickUpMember[];
  creator: ClickUpMember;
  list: { id: string; name: string };
  folder: { id: string; name: string };
  space: { id: string };
  url: string;
  due_date: string | null;
  date_created: string;
  date_updated: string;
  tags: Array<{ name: string; tag_fg: string; tag_bg: string }>;
  subtasks?: ClickUpTask[];
  parent?: string | null;
}

export interface ClickUpComment {
  id: string;
  comment: Array<{ text: string }>;
  comment_text: string;
  user: ClickUpMember;
  date: string;
  resolved: boolean;
}

/**
 * Shape actually returned by ClickUp's `POST /task/{id}/comment` endpoint —
 * sparser than the comment shape returned by `GET /task/{id}/comment` (ClickUpComment).
 */
export interface ClickUpCommentCreateResult {
  id: string;
  hist_id?: string;
  date: string;
  comment_text?: string;
  user?: ClickUpMember;
}

export interface ClickUpSpaceFeatures {
  due_dates?: { enabled: boolean };
  time_tracking?: { enabled: boolean };
  tags?: { enabled: boolean };
  time_estimates?: { enabled: boolean };
  checklists?: { enabled: boolean };
  custom_fields?: { enabled: boolean };
  remap_dependencies?: { enabled: boolean };
  dependency_warning?: { enabled: boolean };
  portfolios?: { enabled: boolean };
}

export interface ClickUpSpaceDetail extends ClickUpSpace {
  color?: string | null;
  private: boolean;
  statuses: ClickUpStatus[];
  features: ClickUpSpaceFeatures;
}
