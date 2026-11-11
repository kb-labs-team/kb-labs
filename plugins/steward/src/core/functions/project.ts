import {
  COLLECTIONS,
  type Project,
  type Resource,
  type ProjectMember,
  type AddProjectInput,
  type UpdateProjectInput,
  type ListProjectsInput,
  type AddResourceInput,
} from '../../contracts/index.js';
import { getDb } from '../db.js';
import { appendEvent } from './event.js';

export async function addProject(input: AddProjectInput): Promise<Project> {
  const docs = await getDb();
  const project = await docs.insertOne<Project>(COLLECTIONS.projects, {
    name: input.name,
    status: input.status,
    description: input.description,
  });
  await appendEvent({
    subjectType: 'project',
    subjectId: project.id,
    kind: 'project.created',
    text: project.name,
  });
  return project;
}

export async function updateProject(input: UpdateProjectInput): Promise<Project | null> {
  const docs = await getDb();
  const before = await docs.findById<Project>(COLLECTIONS.projects, input.id);
  if (!before) {return null;}

  const updated = await docs.updateById<Project>(COLLECTIONS.projects, input.id, {
    $set: {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
  });

  if (updated && input.status && input.status !== before.status) {
    await appendEvent({
      subjectType: 'project',
      subjectId: input.id,
      kind: 'project.status_changed',
      meta: { from: before.status, to: input.status },
    });
  }
  return updated;
}

export async function listProjects(input: ListProjectsInput): Promise<Project[]> {
  const docs = await getDb();
  return docs.find<Project>(
    COLLECTIONS.projects,
    input.status ? { status: input.status } : {},
    { sort: { name: 1 } },
  );
}

export interface ProjectCard {
  project: Project;
  resources: Resource[];
  members: ProjectMember[];
}

/** Resolves by id first, falling back to an exact name match. */
export async function getProject(idOrName: string): Promise<ProjectCard | null> {
  const docs = await getDb();
  let project = await docs.findById<Project>(COLLECTIONS.projects, idOrName);
  if (!project) {
    const [byName] = await docs.find<Project>(COLLECTIONS.projects, { name: { $eq: idOrName } });
    project = byName ?? null;
  }
  if (!project) {return null;}

  const [resources, members] = await Promise.all([
    docs.find<Resource>(COLLECTIONS.resources, { projectId: { $eq: project.id } }),
    docs.find<ProjectMember>(COLLECTIONS.projectMembers, { projectId: { $eq: project.id } }, {
      sort: { priority: 1 },
    }),
  ]);

  return { project, resources, members };
}

// ── Resources ────────────────────────────────────────────────────────────

export async function addResource(input: AddResourceInput): Promise<Resource> {
  const docs = await getDb();
  return docs.insertOne<Resource>(COLLECTIONS.resources, {
    projectId: input.projectId,
    type: input.type,
    label: input.label,
    url: input.url,
    content: input.content,
  });
}

export async function listResources(projectId: string): Promise<Resource[]> {
  const docs = await getDb();
  return docs.find<Resource>(COLLECTIONS.resources, { projectId: { $eq: projectId } });
}
