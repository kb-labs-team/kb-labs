import { describe, expect, it } from 'vitest';
import type { PluginContextV3, RestInput } from '@kb-labs/sdk';
import handler from '../../src/rest/handlers/import-handler.js';

const context = {} as unknown as PluginContextV3;

// case: S-205.7
it('rejects an empty import body before creating a managed source', async () => {
  const input = { body: undefined } as RestInput<never, { fileName: string; data: string }>;
  await expect(handler.execute(context, input)).rejects.toMatchObject({ code: 'KB_RUNTIME_INPUT_INVALID' });
});

describe('viewer import validation', () => {
  // case: S-205.7
  it('rejects an unsafe archive name before writing any files', async () => {
    const input = { body: { fileName: '../unsafe.zip', data: 'eA==' } } as RestInput<never, { fileName: string; data: string }>;
    await expect(handler.execute(context, input)).rejects.toMatchObject({ code: 'KB_RUNTIME_INPUT_INVALID' });
  });

  // case: S-205.7
  it('rejects non-base64 archive data before writing any files', async () => {
    const input = { body: { fileName: 'architecture.zip', data: 'not-base64' } } as RestInput<never, { fileName: string; data: string }>;
    await expect(handler.execute(context, input)).rejects.toMatchObject({ code: 'KB_RUNTIME_INPUT_INVALID' });
  });
});
