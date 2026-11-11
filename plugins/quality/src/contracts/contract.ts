import type { PluginContracts } from './types';
import { contractsSchemaId, contractsVersion } from './version';

// Level 2: Contracts типизация с as const для извлечения типов
export const pluginContractsManifest = {
  schema: contractsSchemaId,
  pluginId: '@kb-labs/plugin-template',
  contractsVersion,
  artifacts: {
    'template.hello.greeting': {
      id: 'template.hello.greeting',
      kind: 'json',
      description: 'Machine-readable greeting payload returned by the hello surfaces.',
      pathPattern: 'artifacts/template/hello/greeting.json',
      mediaType: 'application/json',
      schemaRef: '@kb-labs/plugin-template-contracts/schema#HelloGreeting',
      example: {
        summary: 'Greeting payload for anonymous user',
        payload: {
          message: 'Hello, World!',
          target: 'World'
        }
      }
    },
    'template.hello.log': {
      id: 'template.hello.log',
      kind: 'log',
      description: 'Execution log for hello command/workflow.',
      pathPattern: 'logs/template/hello/run.log',
      mediaType: 'text/plain'
    }
  },
  commands: {
    'plugin-template:hello': {
      id: 'plugin-template:hello',
      description: 'Produce a greeting message optionally targeting a provided name.',
      input: {
        ref: '@kb-labs/plugin-template-contracts/schema#HelloCommandInput',
        format: 'zod'
      },
      output: {
        ref: '@kb-labs/plugin-template-contracts/schema#HelloCommandOutput',
        format: 'zod'
      },
      produces: ['template.hello.greeting', 'template.hello.log'],
      examples: ['kb plugin-template hello', 'kb plugin-template hello --name Dev', 'kb plugin-template hello --json']
    },
    'plugin-template:test-loader': {
      id: 'plugin-template:test-loader',
      description: 'Test UI loader/spinner functionality with various scenarios.',
      input: {
        ref: '@kb-labs/plugin-template-contracts/schema#TestLoaderCommandInput',
        format: 'zod'
      },
      output: {
        ref: '@kb-labs/plugin-template-contracts/schema#TestLoaderCommandOutput',
        format: 'zod'
      },
      produces: [],
      examples: ['kb plugin-template test-loader', 'kb plugin-template test-loader --duration 1000', 'kb plugin-template test-loader --fail']
    }
  },
  workflows: {
    'template.workflow.hello': {
      id: 'template.workflow.hello',
      description: 'Single-step workflow executing the hello command and emitting greeting artifacts.',
      produces: ['template.hello.greeting', 'template.hello.log'],
      steps: [
        {
          id: 'template.workflow.hello.step.run-command',
          commandId: 'plugin-template:hello',
          produces: ['template.hello.greeting', 'template.hello.log']
        }
      ]
    }
  },
  api: {
    rest: {
      basePath: '/v1/plugins/template',
      routes: {
        'template.rest.hello': {
          id: 'template.rest.hello',
          method: 'GET',
          path: '/hello',
          description: 'Return a greeting payload from the REST surface.',
          response: {
            ref: '@kb-labs/plugin-template-contracts/schema#HelloCommandOutput',
            format: 'zod'
          },
          produces: ['template.hello.greeting']
        }
      }
    }
  }
} as const satisfies PluginContracts;

// Извлекаем типы для использования в других местах
export type PluginArtifactIds = keyof typeof pluginContractsManifest.artifacts;
export type PluginCommandIds = keyof typeof pluginContractsManifest.commands;
export type PluginWorkflowIds = keyof typeof pluginContractsManifest.workflows;
export type PluginRouteIds = typeof pluginContractsManifest.api extends { rest: { routes: infer R } }
  ? R extends Record<string, any>
    ? keyof R
    : never
  : never;

