import { cliBinaryName } from './cli-binary.js';
/**
 * CLI UI Facade factory.
 *
 * Constructs a UIFacade for the CLI host using sideBorderBox for rich terminal output.
 * Accepts an optional presenter to delegate spinner, debug, and table output.
 */

import { sideBorderBox, sideBorderChain, safeColors, safeSymbols, formatTable, logLine, confirm as promptConfirm, text as promptText, select as promptSelect, multiSelect as promptMultiSelect } from '@kb-labs/shared-cli-ui';
import type { UIFacade, UILogEntry, MessageOptions, Spinner, SelectChoice, MultiSelectChoice, TableColumn, ChainItem, UIOutput } from '@kb-labs/plugin-contracts';
import { AdapterUnavailableError, toErrorEnvelope } from '@kb-labs/core-platform';
import type { CliResultWriter } from './result-serializer.js';

// Workspace root — used to shorten absolute paths in stack traces
const WORKSPACE_ROOT = process.cwd();

/**
 * Format Error stack into display lines.
 * - Paths shortened to relative from workspace root
 * - node:internal/ frames dimmed (not hidden — errors must be readable)
 * - Each frame on its own line for clarity
 */
function formatErrorStack(err: Error): Array<string | { text: string; dim: boolean }> {
  if (!err.stack) {return [];}

  const lines = err.stack.split('\n');
  // Skip first line — it's the error message, already shown above
  const frameLines = lines.slice(1);

  return frameLines
    .map(line => line.trim())
    .filter(line => line.startsWith('at '))
    .map(line => {
      // Shorten absolute paths to relative
      const shortened = line.replace(WORKSPACE_ROOT + '/', '');
      // Dim node internals and node_modules — they're context, not user code
      const isInternal = shortened.includes('node:internal/') || shortened.includes('node_modules/');
      return { text: shortened, dim: isInternal };
    });
}

interface PresenterDelegate {
  debug?: (msg: string) => void;
  spinner?: (text: string) => Spinner;
  table?: (data: Record<string, unknown>[]) => void;
}

function renderTTYOutput(output: UIOutput, writeOutput: (text: string) => void, writeResult: CliResultWriter, layout?: { wrap?: boolean; width?: number }): void {
  switch (output.kind) {
    case 'message': {
      const sections = output.options?.sections?.map(section => ({ header: section.header, items: section.items })) ?? [];
      if (output.options?.cause) {sections.push({ header: 'Cause', items: [{ text: output.options.cause, dim: true }] });}
      if (output.options?.hint) {
        const hint: Array<string | { text: string; dim: boolean }> = [output.options.hint];
        if (output.options.command) {hint.push({ text: `$ ${output.options.command}`, dim: true });}
        sections.push({ header: 'Hint', items: hint });
      } else if (output.options?.command) {
        sections.push({ header: 'Hint', items: [{ text: `$ ${output.options.command}`, dim: true }] });
      }
      const boxOutput = sideBorderBox({
        title: output.options?.title ?? (output.level === 'error' ? 'Error' : output.level === 'warn' ? 'Warning' : output.level === 'success' ? 'Success' : 'Info'),
        sections: [{ items: [output.message] }, ...sections],
        status: output.level === 'warn' ? 'warning' : output.level === 'error' ? 'error' : output.level,
        ...layout,
        timing: output.options?.timing,
        summary: output.options?.summary,
      });
      writeOutput(boxOutput);
      return;
    }
    case 'sideBox':
      writeOutput(sideBorderBox({
        title: output.options.title,
        sections: output.options.sections?.map(section => ({ header: section.header, items: section.items })) ?? [],
        status: output.options.status,
        timing: output.options.timing,
        summary: output.options.summary,
      }));
      return;
    case 'chain':
      writeOutput(sideBorderChain(output.items.map(item => ({
        title: item.title,
        sections: item.sections?.map(section => ({ header: section.header, items: section.items })) ?? [],
        summary: item.summary,
        status: item.status,
        timing: item.timing,
      }))));
      return;
    case 'table': {
      if (output.data.length === 0) {return;}
      const columns: TableColumn[] = output.columns ?? Object.keys(output.data[0]!).map(key => ({ header: key, key }));
      const rows = output.data.map(row => columns.map(column => String(row[column.key] ?? '')));
      for (const line of formatTable(columns.map(column => ({ header: column.header, width: column.width, align: column.align })), rows, { separator: '' })) {
        writeOutput(`  ${line}`);
      }
      return;
    }
    case 'json':
      writeResult(output.data, output.pretty);
      return;
    default: {
      const exhaustive: never = output;
      throw new Error(`Unsupported UI output: ${String(exhaustive)}`);
    }
  }
}

export function createCLIUIFacade(presenter: PresenterDelegate | undefined, writeResult: CliResultWriter): UIFacade {
  const jsonMode = () => process.env.KB_OUTPUT_MODE === 'json';
  const writeOutput = (value: string) => {
    const output = value.endsWith('\n') ? value : `${value}\n`;
    if (jsonMode()) {
      process.stderr.write(output);
    } else {
      writeResult(output);
    }
  };

  return {
    colors: safeColors,
    symbols: safeSymbols,

    write: (text: string) => {
      writeOutput(text);
    },

    info: (msg: string, options?: MessageOptions) => {
      renderTTYOutput({ kind: 'message', level: 'info', message: msg, options }, writeOutput, writeResult);
    },

    success: (msg: string, options?: MessageOptions) => {
      renderTTYOutput({ kind: 'message', level: 'success', message: msg, options }, writeOutput, writeResult);
    },

    warn: (msg: string, options?: MessageOptions) => {
      renderTTYOutput({ kind: 'message', level: 'warn', message: msg, options }, writeOutput, writeResult);
    },

    error: (err: Error | string, options?: MessageOptions) => {
      if (err instanceof AdapterUnavailableError && err.reason === 'not-configured') {
        const envelope = toErrorEnvelope(err, { binary: cliBinaryName });
        const command = envelope.actions?.[0]?.command;
        if (jsonMode()) {
          writeResult({ ok: false, error: envelope });
        } else {
          console.error(command
            ? `${envelope.message} Configure it with: ${command}`
            : `${envelope.message} ${envelope.hint}`);
        }
        return;
      }

      const message = err instanceof Error ? err.message : err;
      if (jsonMode()) {
        writeResult({ ok: false, error: toErrorEnvelope(err, { binary: cliBinaryName }) });
        return;
      }
      const sections = [...(options?.sections ?? [])];
      if (err instanceof Error && err.stack && !options?.sections) {
        const stackLines = formatErrorStack(err);
        if (stackLines.length > 0) {sections.push({ header: 'Stack', items: stackLines });}
      }
      renderTTYOutput(
        { kind: 'message', level: 'error', message, options: { ...options, sections } },
        value => console.error(value),
        writeResult,
        { wrap: process.stderr.isTTY === true, width: process.stderr.columns },
      );
    },

    debug: (msg: string) => {
      if (presenter?.debug) {
        presenter.debug(msg);
      } else {
        console.debug(msg);
      }
    },

    spinner: (text: string): Spinner => {
      return presenter?.spinner?.(text) ?? {
        update: () => {},
        succeed: () => {},
        fail: () => {},
        stop: () => {},
      };
    },

    table: (data: Record<string, unknown>[], columns?: TableColumn[]) => {
      const output: UIOutput = { kind: 'table', data, columns };
      if (presenter?.table) {
        presenter.table(output.data);
        return;
      }
      renderTTYOutput(output, writeOutput, writeResult);
    },

    json: (data: unknown, options?: { pretty?: boolean }) => {
      renderTTYOutput({ kind: 'json', data, pretty: options?.pretty }, writeOutput, writeResult);
    },

    newline: () => {
      writeOutput('');
    },

    divider: () => {
      writeOutput('─'.repeat(process.stdout.columns || 80));
    },

    box: (content: string, title?: string) => {
      const boxOutput = sideBorderBox({
        title: title || '',
        sections: [{ items: content.split('\n') }],
        status: 'info',
      });
      writeOutput(boxOutput);
    },

    sideBox: (options) => {
      renderTTYOutput({ kind: 'sideBox', options }, writeOutput, writeResult);
    },

    chain: (items: ChainItem[]) => {
      renderTTYOutput({ kind: 'chain', items }, writeOutput, writeResult);
    },

    confirm: async (message: string, options?) => {
      return promptConfirm({ message, defaultValue: options?.defaultValue ?? false });
    },

    prompt: async (message: string, options?) => {
      return promptText({ message, defaultValue: options?.default, mask: options?.mask });
    },

    select: async <T>(message: string, choices: SelectChoice<T>[]) => {
      return promptSelect({ message, choices });
    },

    multiSelect: async <T>(message: string, choices: MultiSelectChoice<T>[]) => {
      return promptMultiSelect({ message, choices });
    },

    log: (entry: UILogEntry) => {
      writeOutput(logLine(entry.level as 'info' | 'warn' | 'error' | 'debug', entry.message));
    },
  };
}
