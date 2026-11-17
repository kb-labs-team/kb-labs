import { describe, expect, it } from 'vitest';
import { createErrorEnvelope, createContextLogger, serializeError, type IContextLogger } from '@kb-labs/core-platform';
import { normalizePluginHandlerFailure } from '../plugin-handler-failure.js';

const logContext = {
  applicationId: 'cli',
  serviceId: 'plugin-execution',
  instanceId: 'test-instance',
  layer: 'runtime' as const,
};

function loggerFor(): IContextLogger {
  return createContextLogger({
    trace: () => {}, debug: () => {}, info: () => {}, warn: () => {},
    error: () => {}, fatal: () => {}, flush: async () => {},
    child: () => loggerFor(),
  }, logContext);
}

describe('plugin module resolution failure transport', () => {
  it('keeps Node missing-package identity through serialization and plugin normalization', () => {
    const sourceError = Object.assign(
      new Error("Cannot find package '@kb-labs/sdk' imported from /workspace/plugins/release/dist/cli.js"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    const serializedError = serializeError(sourceError);
    const executionEnvelope = createErrorEnvelope('KB_PLUGIN_COMMAND_FAILED', {
      correlationId: 'missing-sdk-correlation',
      details: {
        plugin: '@kb-labs/release',
        command: 'release artifact publish',
        failureReason: 'failed unexpectedly',
      },
    });

    const envelope = normalizePluginHandlerFailure(executionEnvelope, {
      pluginId: '@kb-labs/release',
      command: 'release artifact publish',
      correlationId: 'missing-sdk-correlation',
      pluginVersion: '1.0.0',
      serializedError,
      executionEnvelope,
      logger: loggerFor(),
      logContext,
    });

    expect(envelope).toMatchObject({
      code: 'KB_PLUGIN_LOAD_FAILED',
      correlationId: 'missing-sdk-correlation',
      hint: expect.any(String),
      details: {
        plugin: '@kb-labs/release',
        command: 'release artifact publish',
        specifier: '@kb-labs/sdk',
      },
    });
  });
});
