/**
 * Mock implementation of ProjectAdaptersDataSource, for Studio's mock
 * data-source mode.
 */

import { KBError, errorCodes } from '../errors/kb-error';
import type {
  ConfigureAdapterResult,
  ProjectAdapterEntry,
  ProjectAdaptersDataSource,
} from '../sources/project-adapters-source';

export class MockProjectAdaptersSource implements ProjectAdaptersDataSource {
  private readonly byProject = new Map<string, ProjectAdapterEntry[]>();

  private entriesFor(projectId: string): ProjectAdapterEntry[] {
    if (!this.byProject.has(projectId)) {
      this.byProject.set(projectId, [
        {
          name: 'llm',
          spec: '@kb-labs/adapters-openai',
          configSchema: {
            apiKey: { type: 'string' },
            defaultModel: { type: 'string', enum: ['gpt-4o', 'gpt-4o-mini'] },
          },
          options: { defaultModel: 'gpt-4o-mini', apiKey: '***REDACTED***' },
        },
        {
          name: 'cache',
          spec: '@kb-labs/adapters-fs-cache',
          configSchema: { ttlSeconds: { type: 'number' } },
          options: { ttlSeconds: 3600 },
        },
      ]);
    }
    return this.byProject.get(projectId)!;
  }

  async listAdapters(projectId: string): Promise<ProjectAdapterEntry[]> {
    return [...this.entriesFor(projectId)];
  }

  async configureAdapter(
    projectId: string,
    name: string,
    options: Record<string, unknown>,
  ): Promise<ConfigureAdapterResult> {
    const entries = this.entriesFor(projectId);
    const found = entries.find((entry) => entry.name === name);
    if (!found) {
      throw new KBError(errorCodes.NOT_FOUND, `No adapter "${name}" configured for this project.`, 404);
    }
    found.options = { ...found.options, ...options };
    return {
      name,
      file: `/workspace/${projectId}/.kb/kb.config.jsonc`,
      changed: true,
      options: found.options,
    };
  }
}
