import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterUnavailableError } from '@kb-labs/core-platform';
import { createCLIUIFacade } from './ui-facade.js';

describe('CLI UI adapter errors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.KB_OUTPUT_MODE;
  });

  it('renders an unconfigured adapter as one actionable human line', () => {
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resultOutput: unknown[] = [];

    createCLIUIFacade(undefined, (value) => resultOutput.push(value)).error(new AdapterUnavailableError('llm'));

    expect(errorOutput).toHaveBeenCalledOnce();
    expect(errorOutput.mock.calls[0]?.[0]).toBe(
      'Service llm is not configured. Configure it with: kb adapter bind llm @kb-labs/adapters-openai',
    );
    expect(errorOutput.mock.calls[0]?.[0]).not.toContain(' at ');
  });

  // case: S-051.2
  it('keeps the typed failure message intact when stderr is not a terminal', () => {
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = 'Plugin @kb-labs/not-published was not found in the registry. [KB_PLUGIN_NOT_FOUND]';
    const resultOutput: unknown[] = [];

    createCLIUIFacade(undefined, (value) => resultOutput.push(value)).error(message, { hint: 'kb marketplace search' });

    expect(errorOutput).toHaveBeenCalledOnce();
    expect(String(errorOutput.mock.calls[0]?.[0])).toContain(message);
  });

  it('keeps diagnostics on stderr and writes the boundary result unchanged in JSON mode', () => {
    process.env.KB_OUTPUT_MODE = 'json';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const resultOutput: string[] = [];
    const ui = createCLIUIFacade(undefined, (value) => resultOutput.push(JSON.stringify(value)));

    ui.warn('configuration warning');
    ui.json({ plugins: [] });

    expect(stderr).toHaveBeenCalledOnce();
    expect(resultOutput).toEqual(['{"plugins":[]}']);
  });
});
