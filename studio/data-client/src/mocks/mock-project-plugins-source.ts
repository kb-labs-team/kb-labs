/**
 * Mock implementation of ProjectPluginsDataSource, for Studio's mock
 * data-source mode.
 */

import { KBError, errorCodes } from '../errors/kb-error';
import type { ProjectPluginEntry, ProjectPluginsDataSource } from '../sources/project-plugins-source';

export class MockProjectPluginsSource implements ProjectPluginsDataSource {
  private readonly byProject = new Map<string, ProjectPluginEntry[]>();

  private entriesFor(projectId: string): ProjectPluginEntry[] {
    if (!this.byProject.has(projectId)) {
      this.byProject.set(projectId, [
        {
          id: '@kb-labs/commit',
          version: '2.120.1',
          source: 'workspace',
          primaryKind: 'plugin',
          provides: ['plugin'],
          enabled: true,
          scope: 'project',
        },
        {
          id: '@kb-labs/review',
          version: '2.120.1',
          source: 'workspace',
          primaryKind: 'plugin',
          provides: ['plugin'],
          enabled: false,
          scope: 'project',
        },
      ]);
    }
    return this.byProject.get(projectId)!;
  }

  async listPlugins(projectId: string): Promise<ProjectPluginEntry[]> {
    return [...this.entriesFor(projectId)];
  }

  async installPlugin(projectId: string, spec: string): Promise<unknown> {
    const id = spec.split('@').slice(0, spec.startsWith('@') ? 2 : 1).join('@');
    const entries = this.entriesFor(projectId);
    if (entries.some((entry) => entry.id === id)) {return { installed: [{ id }] };}
    entries.push({ id, version: '1.0.0', source: 'marketplace', primaryKind: 'plugin', provides: ['plugin'], enabled: true, scope: 'project' });
    return { installed: [{ id }] };
  }

  async uninstallPlugin(projectId: string, packageId: string): Promise<{ id: string; removed: boolean }> {
    const entries = this.entriesFor(projectId);
    const index = entries.findIndex((entry) => entry.id === packageId);
    if (index < 0) {throw new KBError(errorCodes.NOT_FOUND, `No plugin "${packageId}" in this project.`, 404);}
    entries.splice(index, 1);
    return { id: packageId, removed: true };
  }

  private setEnabled(projectId: string, packageId: string, enabled: boolean): { id: string; enabled: boolean } {
    const entries = this.entriesFor(projectId);
    const found = entries.find((entry) => entry.id === packageId);
    if (!found) {
      throw new KBError(errorCodes.NOT_FOUND, `No plugin "${packageId}" in this project.`, 404);
    }
    found.enabled = enabled;
    return { id: packageId, enabled };
  }

  async enablePlugin(projectId: string, packageId: string): Promise<{ id: string; enabled: boolean }> {
    return this.setEnabled(projectId, packageId, true);
  }

  async disablePlugin(projectId: string, packageId: string): Promise<{ id: string; enabled: boolean }> {
    return this.setEnabled(projectId, packageId, false);
  }
}
