import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('native agent QA dogfood workflow example', () => {
  // case: S-326.2
  it('forwards an optional QA package scope to the QA command', async () => {
    const workflowPath = new URL('../../../examples/native-agent-qa-dogfood.yml', import.meta.url);
    const workflow = parse(await readFile(workflowPath, 'utf8')) as {
      inputs?: Record<string, { type?: string; required?: boolean }>;
      jobs?: Record<string, { steps?: Array<{ id?: string; with?: Record<string, string> }> }>;
    };
    const qaStep = workflow.jobs?.dogfood?.steps?.find(({ id }) => id === 'qa');

    expect(workflow.inputs?.qa_packages).toMatchObject({ type: 'string', required: false });
    expect(qaStep?.with?.packages).toBe('${{ inputs.qa_packages }}');
  });
});
