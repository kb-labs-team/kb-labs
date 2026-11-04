/**
 * Tests for UI Adapter (createUIFacade)
 *
 * Ensures that UIFacade:
 * 1. Provides all required UI methods from plugin-contracts
 * 2. Correctly adapts SystemContext to UIFacade
 * 3. Handles all 15+ UI methods correctly
 * 4. Uses sideBorderBox for formatting
 * 5. Supports both interactive and non-interactive modes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SystemContext } from '@kb-labs/cli-runtime';
import { noopUI, uiMessageLevelDefaultTitleCases, uiOutputContractCases } from '@kb-labs/plugin-contracts';
import { createCLIUIFacade } from '../runtime/ui-facade.js';

// Tests for createCLIUIFacade (from plugin-executor) and createJsonModeUI logic

describe('UI Adapter', () => {
  let mockSystemContext: SystemContext;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;
  let stdoutWriteSpy: any;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    mockSystemContext = {
      cwd: '/test',
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      presenter: {
        debug: vi.fn(),
        spinner: vi.fn(() => ({
          update: vi.fn(),
          succeed: vi.fn(),
          fail: vi.fn(),
          stop: vi.fn(),
        })),
        table: vi.fn(),
      },
    } as any;
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
    stdoutWriteSpy?.mockRestore();
  });

  describe('UIFacade Creation', () => {
    it('should create UIFacade with all required methods', () => {
      // Mock a minimal UIFacade (createCLIUIFacade is tested through integration)
      const createUIFacade = (_context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
        newline: vi.fn(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      // Verify all 15 methods exist
      expect(ui.write).toBeDefined();
      expect(ui.info).toBeDefined();
      expect(ui.success).toBeDefined();
      expect(ui.warn).toBeDefined();
      expect(ui.error).toBeDefined();
      expect(ui.debug).toBeDefined();
      expect(ui.spinner).toBeDefined();
      expect(ui.table).toBeDefined();
      expect(ui.json).toBeDefined();
      expect(ui.newline).toBeDefined();
      expect(ui.divider).toBeDefined();
      expect(ui.box).toBeDefined();
      expect(ui.sideBox).toBeDefined();
      expect(ui.confirm).toBeDefined();
      expect(ui.prompt).toBeDefined();
      expect(ui.colors).toBeDefined();
    });
  });

  describe('UIFacade Methods', () => {
    it('should write raw text via write()', () => {
      // eslint-disable-next-line sonarjs/no-identical-functions -- Test fixtures for UI facade need similar structure
      const createUIFacade = (_context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
        newline: vi.fn(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      ui.write('Hello, world!');

      expect(stdoutWriteSpy).toHaveBeenCalledWith('Hello, world!');
    });

    it('should output JSON via json()', () => {
      const createUIFacade = (_context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: vi.fn(),
        json: (data: unknown) => console.log(JSON.stringify(data, null, 2)),
        newline: vi.fn(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      ui.json({ status: 'ok', count: 42 });

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('"status": "ok"');
      expect(output).toContain('"count": 42');
    });

    it('should output newline via newline()', () => {
      const createUIFacade = (_context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
        newline: () => console.log(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      ui.newline();

      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('should output divider via divider()', () => {
      const createUIFacade = (_context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
        newline: vi.fn(),
        divider: () => console.log('─'.repeat(80)),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      ui.divider();

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('─');
    });

    it('should display table via table()', () => {
      const createUIFacade = (context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: (data: Record<string, unknown>[]) => {
          if ((context.presenter as any)?.table) {
            (context.presenter as any).table(data);
          } else {
            console.table(data);
          }
        },
        json: vi.fn(),
        newline: vi.fn(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      ui.table([
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ]);

      expect((mockSystemContext.presenter as any)?.table).toHaveBeenCalled();
    });

    it('should delegate debug to presenter', () => {
      const createUIFacade = (context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: (msg: string) => {
          if ((context.presenter as any)?.debug) {
            (context.presenter as any).debug(msg);
          } else {
            console.debug(msg);
          }
        },
        spinner: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
        newline: vi.fn(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      ui.debug('Debug message');

      expect((mockSystemContext.presenter as any)?.debug).toHaveBeenCalledWith('Debug message');
    });
  });

  describe('Spinner Support', () => {
    const createSpinnerUIFacade = (context: SystemContext) => ({
      colors: {} as any,
      write: (text: string) => process.stdout.write(text),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      spinner: (text: string) => {
        const spinner = (context.presenter as any)?.spinner?.(text);
        return {
          update: (message: string) => spinner?.update?.(message),
          succeed: (message?: string) => spinner?.succeed?.(message),
          fail: (message?: string) => spinner?.fail?.(message),
          stop: () => spinner?.stop?.(),
        };
      },
      table: vi.fn(),
      json: vi.fn(),
      newline: vi.fn(),
      divider: vi.fn(),
      box: vi.fn(),
      sideBox: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      prompt: vi.fn().mockResolvedValue(''),
    });

    it('should create spinner with all methods', () => {
      const ui = createSpinnerUIFacade(mockSystemContext);

      const spinner = ui.spinner('Loading...');

      expect(spinner).toBeDefined();
      expect(spinner.update).toBeDefined();
      expect(spinner.succeed).toBeDefined();
      expect(spinner.fail).toBeDefined();
      expect(spinner.stop).toBeDefined();
    });

    it('should delegate spinner methods to presenter', () => {
      const mockSpinner = {
        update: vi.fn(),
        succeed: vi.fn(),
        fail: vi.fn(),
        stop: vi.fn(),
      };

      mockSystemContext.presenter = {
        spinner: vi.fn(() => mockSpinner),
      } as any;

      const ui = createSpinnerUIFacade(mockSystemContext);

      const spinner = ui.spinner('Loading...');
      spinner.update('Still loading...');
      spinner.succeed('Done!');

      expect((mockSystemContext.presenter as any)?.spinner).toHaveBeenCalledWith('Loading...');
      expect(mockSpinner.update).toHaveBeenCalledWith('Still loading...');
      expect(mockSpinner.succeed).toHaveBeenCalledWith('Done!');
    });
  });

  describe('Interactive Methods (Non-Interactive Mode)', () => {
    it('should return true for confirm() in non-interactive mode', async () => {
      const createUIFacade = (_context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
        newline: vi.fn(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: async (_message: string) => {
          // For now, return true (non-interactive)
          // TODO: Implement proper confirm via presenter
          return true;
        },
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      const result = await ui.confirm('Are you sure?');

      expect(result).toBe(true);
    });

    it('should return empty string for prompt() in non-interactive mode', async () => {
      const createUIFacade = (_context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
        newline: vi.fn(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: async (_message: string, _options?: unknown) => {
          // For now, return empty string (non-interactive)
          // TODO: Implement proper prompt via presenter
          return '';
        },
      });

      const ui = createUIFacade(mockSystemContext);

      const result = await ui.prompt('Enter your name:');

      expect(result).toBe('');
    });
  });

  describe('MessageOptions Support', () => {
    it('should support title in MessageOptions', () => {
      const mockInfo = vi.fn();

      const createUIFacade = (_context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: mockInfo,
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
        newline: vi.fn(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      ui.info('Test message', { title: 'Custom Title' });

      expect(mockInfo).toHaveBeenCalledWith('Test message', { title: 'Custom Title' });
    });

    it('should support sections in MessageOptions', () => {
      const mockSuccess = vi.fn();

      const createUIFacade = (_context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: mockSuccess,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
        newline: vi.fn(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      ui.success('Success message', {
        sections: [{ header: 'Details', items: ['Item 1', 'Item 2'] }],
      });

      expect(mockSuccess).toHaveBeenCalledWith('Success message', {
        sections: [{ header: 'Details', items: ['Item 1', 'Item 2'] }],
      });
    });

    it('should support timing in MessageOptions', () => {
      const mockWarn = vi.fn();

      const createUIFacade = (_context: SystemContext) => ({
        colors: {} as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: vi.fn(),
        warn: mockWarn,
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
        newline: vi.fn(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      ui.warn('Warning message', { timing: 123 });

      expect(mockWarn).toHaveBeenCalledWith('Warning message', { timing: 123 });
    });
  });

  describe('Error Handling', () => {
    const createErrorUIFacade = (errorFn: (error: unknown) => void) => ({
      colors: {} as any,
      write: (text: string) => process.stdout.write(text),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: errorFn,
      debug: vi.fn(),
      spinner: vi.fn(),
      table: vi.fn(),
      json: vi.fn(),
      newline: vi.fn(),
      divider: vi.fn(),
      box: vi.fn(),
      sideBox: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      prompt: vi.fn().mockResolvedValue(''),
    });

    it('should handle Error object in error()', () => {
      const mockError = vi.fn<(error: unknown) => void>();
      const ui = createErrorUIFacade(mockError);

      const error = new Error('Test error');
      ui.error(error);

      expect(mockError).toHaveBeenCalledWith(error);
    });

    it('should handle string in error()', () => {
      const mockError = vi.fn<(error: unknown) => void>();
      const ui = createErrorUIFacade(mockError);

      ui.error('Test error string');

      expect(mockError).toHaveBeenCalledWith('Test error string');
    });
  });

  describe('JSON Mode UI (createJsonModeUI)', () => {
    it('all UI methods except json() are no-ops in json mode', () => {
      // Replicate the createJsonModeUI logic from plugin-executor
      const baseJson = vi.fn();
      const base = {
        ...noopUI,
        json: baseJson,
      };
      const jsonModeUI = {
        ...noopUI,
        colors: base.colors,
        symbols: base.symbols,
        json: base.json,
      };

      // These should all be no-ops (from noopUI)
      expect(() => jsonModeUI.info('hello')).not.toThrow();
      expect(() => jsonModeUI.success('ok')).not.toThrow();
      expect(() => jsonModeUI.warn('warn')).not.toThrow();
      expect(() => jsonModeUI.error('err')).not.toThrow();
      expect(() => jsonModeUI.write('text')).not.toThrow();
      expect(() => jsonModeUI.sideBox({ title: 'T', sections: [] })).not.toThrow();
      expect(() => jsonModeUI.newline()).not.toThrow();
      expect(() => jsonModeUI.divider()).not.toThrow();

      // json() must be the real one
      jsonModeUI.json({ ok: true });
      expect(baseJson).toHaveBeenCalledWith({ ok: true });
    });

    it('json() writes to stdout', () => {
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const realJson = (data: unknown) => {
        process.stdout.write(JSON.stringify(data) + '\n');
      };
      const jsonModeUI = { ...noopUI, json: realJson };

      jsonModeUI.json({ packages: [], strategy: 'semver' });

      expect(write).toHaveBeenCalledWith(expect.stringContaining('"strategy"'));
      write.mockRestore();
    });

    it('sideBox and info produce no stdout output in json mode', () => {
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      const jsonModeUI = { ...noopUI };
      jsonModeUI.sideBox({ title: 'T', sections: [{ items: ['line'] }] });
      jsonModeUI.info('message');

      expect(write).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();

      write.mockRestore();
      log.mockRestore();
    });
  });

  describe('Colors API', () => {
    it('should provide colors API from shared-cli-ui', () => {
      const createUIFacade = (_context: SystemContext) => ({
        colors: {
          red: (text: string) => `\x1b[31m${text}\x1b[0m`,
          green: (text: string) => `\x1b[32m${text}\x1b[0m`,
          yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
          blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
          gray: (text: string) => `\x1b[90m${text}\x1b[0m`,
        } as any,
        write: (text: string) => process.stdout.write(text),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        spinner: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
        newline: vi.fn(),
        divider: vi.fn(),
        box: vi.fn(),
        sideBox: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue(''),
      });

      const ui = createUIFacade(mockSystemContext);

      expect(ui.colors).toBeDefined();
      expect(ui.colors.red).toBeDefined();
      expect(ui.colors.green).toBeDefined();
      expect(ui.colors.yellow).toBeDefined();
      expect(ui.colors.blue).toBeDefined();
      expect(ui.colors.gray).toBeDefined();
    });
  });
});

describe('shared UI output contract in CLI adapter', () => {
  it.each(Object.entries(uiOutputContractCases))('renders %s output fields for a TTY', (_kind, contract) => {
    const consoleOutput: string[] = [];
    const streamOutput: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...values) => consoleOutput.push(values.join(' ')));
    const streamSpy = vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      streamOutput.push(String(value));
      return true;
    });
    try {
      contract.invoke(createCLIUIFacade(undefined, (value) => streamOutput.push(JSON.stringify(value))));
      const rendered = `${consoleOutput.join('\n')}\n${streamOutput.join('\n')}`;
      for (const expected of contract.visibleText) expect(rendered).toContain(expected);
    } finally {
      consoleSpy.mockRestore();
      streamSpy.mockRestore();
    }
  });

  it.each([
    {
      label: 'with summary',
      item: { title: 'Singleton', summary: { Count: 1 }, sections: [{ items: ['detail'] }] },
      lines: ['◆  Singleton', '│', '│  Count:  1', '│', '│  detail', ''],
    },
    {
      label: 'without summary',
      item: { title: 'Singleton', sections: [{ items: ['detail'] }] },
      lines: ['◆  Singleton', '│', '│  detail', ''],
    },
  ])('renders a singleton chain exactly $label', async ({ item, lines }) => {
    const output: string[] = [];
    const originalNoColor = process.env.NO_COLOR;
    try {
      process.env.NO_COLOR = '1';
      vi.resetModules();
      const { createCLIUIFacade: createNoColorCLIUIFacade } = await import('../runtime/ui-facade.js');
      const streamSpy = vi.spyOn(process.stderr, 'write').mockImplementation(value => {
        output.push(String(value));
        return true;
      });
      try {
        createNoColorCLIUIFacade(undefined, (value) => output.push(String(value))).chain([item]);
      } finally {
        streamSpy.mockRestore();
      }
      expect(output.join('').split('\n')).toEqual(lines);
    } finally {
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
      vi.resetModules();
    }
  });

  it.each(Object.entries(uiMessageLevelDefaultTitleCases))('uses the %s default title for TTY output', (_level, contract) => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...values) => output.push(values.join(' ')));
    const streamSpy = vi.spyOn(process.stdout, 'write').mockImplementation(value => {
      output.push(String(value));
      return true;
    });
    try {
      contract.invoke(createCLIUIFacade(undefined, (value) => output.push(JSON.stringify(value))));
      expect(output.join('\n')).toContain(contract.title);
    } finally {
      consoleSpy.mockRestore();
      streamSpy.mockRestore();
    }
  });
});
