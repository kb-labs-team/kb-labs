/**
 * BufferedUI — a UIFacade implementation that captures all output into a string
 * buffer instead of writing to a TTY. Used to run plugin commands headlessly and
 * return their textual output as an MCP tool result.
 *
 * Output methods append to the buffer. Interactive methods fail because an MCP
 * tool call has no prompt responder; required values belong in tool arguments.
 */

import { InteractiveInputRequiredError, noopUI, renderUIOutputText } from '@kb-labs/plugin-contracts';
import type { UIOutput, UIFacade } from '@kb-labs/plugin-contracts';

export interface BufferedUI {
  ui: UIFacade;
  getOutput: () => string;
  getStructuredOutput: () => UIOutput[];
}

function stringifyError(error: Error | string): string {
  return typeof error === 'string' ? error : error.message;
}

/**
 * Create a buffered UI facade.
 *
 * @param pushFn - Optional external push function. When provided (e.g. from the
 *   AsyncLocalStorage-backed uiProvider in bootstrap), output is appended there
 *   and `getOutput()` returns an empty string. When omitted, output is stored in
 *   an internal array and available via `getOutput()`.
 */
export function createBufferedUI(pushFn?: (text: string, output?: UIOutput) => void): BufferedUI {
  const lines: string[] = [];
  const structuredOutput: UIOutput[] = [];
  const push = (text: string): void => {
    if (pushFn) {pushFn(text);}
    else {lines.push(text);}
  };
  const emit = (output: UIOutput): void => {
    structuredOutput.push(output);
    const text = renderUIOutputText(output);
    if (pushFn) {pushFn(text, output);}
    else {lines.push(text);}
  };

  const unavailablePrompt = (message: string): InteractiveInputRequiredError =>
    new InteractiveInputRequiredError(
      'Provide the value as an explicit tool argument, then retry the tool call.',
      `The prompt "${message}" cannot be answered during an MCP tool call.`,
    );

  const ui: UIFacade = {
    colors: noopUI.colors,
    symbols: noopUI.symbols,
    write: (text) => push(text),
    info: (message, options) => emit({ kind: 'message', level: 'info', message, options }),
    success: (message, options) => emit({ kind: 'message', level: 'success', message, options }),
    warn: (message, options) => emit({ kind: 'message', level: 'warn', message, options }),
    error: (error, options) => emit({ kind: 'message', level: 'error', message: stringifyError(error), options }),
    debug: (message) => push(`[debug] ${message}`),
    spinner: (message) => {
      push(`[spinner] ${message}`);
      return {
        update: (m) => push(`[spinner] ${m}`),
        succeed: (m) => push(`[ok] ${m ?? ''}`.trimEnd()),
        fail: (m) => push(`[fail] ${m ?? ''}`.trimEnd()),
        stop: () => {},
      };
    },
    table: (data, columns) => emit({ kind: 'table', data, columns }),
    json: (data, options) => emit({ kind: 'json', data, pretty: options?.pretty }),
    newline: () => push(''),
    divider: () => push('---'),
    box: (content, title) => push(title ? `[${title}]\n${content}` : content),
    sideBox: (options) => emit({ kind: 'sideBox', options }),
    chain: (items) => emit({ kind: 'chain', items }),
    log: (entry) => push(`[${entry.level}] ${entry.message}`),
    confirm: async (message) => { throw unavailablePrompt(message); },
    prompt: async (message) => { throw unavailablePrompt(message); },
    select: async (message) => { throw unavailablePrompt(message); },
    multiSelect: async (message) => { throw unavailablePrompt(message); },
  };

  return { ui, getOutput: () => lines.join('\n'), getStructuredOutput: () => structuredOutput };
}
