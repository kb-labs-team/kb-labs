/**
 * Mock implementation of PluginsDataSource for testing
 */

import type { PluginsDataSource, PluginsRegistryResponse } from '../sources/plugins-source';
import type { ManifestV3 } from '@kb-labs/plugin-contracts';

const mockManifests: PluginsRegistryResponse = {
  manifests: [
    {
      pluginId: '@kb-labs/mind-plugin',
      source: {
        kind: 'workspace',
        path: '/workspace/kb-labs-mind/packages/mind-plugin',
      },
      pluginRoot: '/workspace/kb-labs-mind/packages/mind-plugin',
      discoveredAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      buildTimestamp: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
      manifest: {
        schema: 'kb.plugin/3',
        id: '@kb-labs/mind-plugin',
        version: '0.1.0',
        display: {
          name: 'Mind RAG Plugin',
          description: 'Semantic code search and RAG system',
          author: 'KB Labs',
          icon: '🧠',
          tags: ['search', 'ai', 'rag'],
        },
        permissions: {
          fs: { mode: 'read', allow: ['.kb/**', 'src/**'] },
          net: { allowHosts: ['api.openai.com'] },
        },
        platform: {
          requires: ['vectorStore', 'embeddings', 'cache'],
        },
        cli: {
          commands: [
            {
              path: 'mind search',
              describe: 'Query the RAG index',
              handler: './dist/commands/rag-query.js',
              flags: [
                { name: 'text', type: 'string', required: true, description: 'Query text' },
                { name: 'agent', type: 'boolean', description: 'Use agent mode' },
              ],
            },
            {
              path: 'mind index update',
              describe: 'Build RAG index',
              handler: './dist/commands/rag-index.js',
              flags: [
                { name: 'scope', type: 'string', default: 'default', description: 'Index scope' },
              ],
            },
          ],
        },
        rest: {
          basePath: '/v1/plugins/mind',
          routes: [
            {
              method: 'POST',
              path: '/search',
              description: 'Semantic code search',
              handler: './dist/rest/search.js',
              timeoutMs: 30000,
              input: { zod: './schemas/search-input.ts#SearchInputSchema' },
              output: { zod: './schemas/search-output.ts#SearchOutputSchema' },
            },
          ],
        },
      } as ManifestV3,
    },
  ],
};

export class MockPluginsSource implements PluginsDataSource {
  async getPlugins(): Promise<PluginsRegistryResponse> {
    // Simulate network delay
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 300);
    });
    return {
      ...mockManifests,
      apiBasePath: '/api/v1',
    };
  }

  async askAboutPlugin(pluginId: string, request: { question: string }) {
    // Simulate network delay
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 1000);
    });

    // Mock AI responses based on question keywords
    const question = request.question.toLowerCase();
    let answer = '';

    if (question.includes('permission') || question.includes('access')) {
      answer = `This plugin requires the following permissions:\n\n` +
        `- File System: Read-only access to .kb/** and src/** directories\n` +
        `- Network: Access to api.openai.com for AI operations\n\n` +
        `These permissions are necessary for RAG indexing and semantic search functionality.`;
    } else if (question.includes('command') || question.includes('cli')) {
      answer = `The plugin provides 2 CLI commands:\n\n` +
        `1. **mind search** - Query the RAG index\n` +
        `   - Required: --text (query text)\n` +
        `   - Optional: --agent (use agent mode)\n\n` +
        `2. **mind index update** - Build RAG index\n` +
        `   - Optional: --scope (default: 'default')\n\n` +
        `Use these commands to perform semantic code search across your codebase.`;
    } else if (question.includes('rest') || question.includes('api') || question.includes('endpoint')) {
      answer = `The plugin exposes 1 REST API endpoint:\n\n` +
        `**POST /v1/plugins/mind/search** - Semantic code search\n` +
        `- Timeout: 30 seconds\n` +
        `- Input: SearchInputSchema (query text and options)\n` +
        `- Output: SearchOutputSchema (search results with relevance scores)\n\n` +
        `This endpoint allows integration with external tools and web interfaces.`;
    } else {
      answer = `This is the Mind RAG Plugin (v0.1.0) - a semantic code search and RAG system.\n\n` +
        `Key features:\n` +
        `- 2 CLI commands (mind search, mind index update)\n` +
        `- 1 REST API endpoint (/search)\n` +
        `- AI-powered semantic search\n` +
        `- Read-only file system access\n` +
        `- OpenAI API integration\n\n` +
        `The plugin helps developers find relevant code using natural language queries.`;
    }

    return {
      answer,
      usage: {
        promptTokens: 150,
        completionTokens: 100,
      },
    };
  }

  async getPluginReadme(_pluginId: string): Promise<string | null> {
    await new Promise<void>((resolve) => { setTimeout(() => resolve(), 200); });
    return '# Plugin README\n\nThis is a mock README for development purposes.';
  }

  async getPluginChangelog(_pluginId: string): Promise<string | null> {
    await new Promise<void>((resolve) => { setTimeout(() => resolve(), 200); });
    return null;
  }
}
