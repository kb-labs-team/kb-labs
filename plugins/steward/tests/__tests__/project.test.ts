import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestPlatform } from '@kb-labs/sdk/testing';
import { addProject, updateProject, listProjects, getProject, addResource, listResources } from '../../src/core/functions/project.js';
import { listEvents } from '../../src/core/functions/event.js';
import { addMember } from '../../src/core/functions/person.js';

describe('project functions', () => {
  beforeEach(() => {
    setupTestPlatform();
  });

  afterEach(() => {
    setupTestPlatform();
  });

  describe('addProject', () => {
    it('creates a project with defaults and records a project.created event', async () => {
      const project = await addProject({ name: 'Acme API', status: 'active', description: 'Payments backend' });

      expect(project.id).toBeDefined();
      expect(project.name).toBe('Acme API');
      expect(project.status).toBe('active');
      expect(project.description).toBe('Payments backend');

      const events = await listEvents({ subjectType: 'project', subjectId: project.id });
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('project.created');
      expect(events[0]!.text).toBe('Acme API');
    });
  });

  describe('updateProject', () => {
    it('returns null for an unknown id', async () => {
      const result = await updateProject({ id: 'does-not-exist', status: 'paused' });
      expect(result).toBeNull();
    });

    it('updates status and description without appending an event when status is unchanged', async () => {
      const project = await addProject({ name: 'P1', status: 'active' });
      const updated = await updateProject({ id: project.id, description: 'new desc' });

      expect(updated?.description).toBe('new desc');
      expect(updated?.status).toBe('active');

      const events = await listEvents({ subjectType: 'project', subjectId: project.id, kind: 'project.status_changed' });
      expect(events).toHaveLength(0);
    });

    it('appends a project.status_changed event when status actually changes', async () => {
      const project = await addProject({ name: 'P2', status: 'active' });
      const updated = await updateProject({ id: project.id, status: 'paused' });

      expect(updated?.status).toBe('paused');

      const events = await listEvents({ subjectType: 'project', subjectId: project.id, kind: 'project.status_changed' });
      expect(events).toHaveLength(1);
      expect(events[0]!.meta).toEqual({ from: 'active', to: 'paused' });
    });
  });

  describe('listProjects', () => {
    it('lists all projects sorted by name', async () => {
      await addProject({ name: 'Zeta', status: 'active' });
      await addProject({ name: 'Alpha', status: 'active' });

      const projects = await listProjects({});
      expect(projects.map((p) => p.name)).toEqual(['Alpha', 'Zeta']);
    });

    it('filters by status', async () => {
      await addProject({ name: 'Active One', status: 'active' });
      await addProject({ name: 'Paused One', status: 'paused' });

      const projects = await listProjects({ status: 'paused' });
      expect(projects).toHaveLength(1);
      expect(projects[0]!.name).toBe('Paused One');
    });
  });

  describe('getProject', () => {
    it('returns null when nothing matches', async () => {
      const card = await getProject('nope');
      expect(card).toBeNull();
    });

    it('resolves by id', async () => {
      const project = await addProject({ name: 'Findable', status: 'active' });
      const card = await getProject(project.id);
      expect(card?.project.id).toBe(project.id);
    });

    it('falls back to an exact name match when id lookup misses', async () => {
      const project = await addProject({ name: 'By Name', status: 'active' });
      const card = await getProject('By Name');
      expect(card?.project.id).toBe(project.id);
    });

    it('bundles resources and members, sorted by member priority', async () => {
      const project = await addProject({ name: 'Bundled', status: 'active' });
      await addResource({ projectId: project.id, type: 'repo', label: 'Repo', url: 'https://example.com/repo' });
      await addMember({ personId: 'per_1', projectId: project.id, role: 'lead', priority: 5 });
      await addMember({ personId: 'per_2', projectId: project.id, role: 'backup', priority: 1 });

      const card = await getProject(project.id);
      expect(card?.resources).toHaveLength(1);
      expect(card?.members.map((m) => m.personId)).toEqual(['per_2', 'per_1']);
    });
  });

  describe('addResource / listResources', () => {
    it('attaches a resource to a project and lists it back', async () => {
      const project = await addProject({ name: 'HasResource', status: 'active' });
      const resource = await addResource({
        projectId: project.id,
        type: 'dashboard',
        label: 'Grafana',
        url: 'https://grafana.example.com',
      });

      expect(resource.projectId).toBe(project.id);

      const resources = await listResources(project.id);
      expect(resources).toHaveLength(1);
      expect(resources[0]!.id).toBe(resource.id);
    });

    it('returns an empty list for a project with no resources', async () => {
      const resources = await listResources('unknown-project');
      expect(resources).toEqual([]);
    });
  });
});
