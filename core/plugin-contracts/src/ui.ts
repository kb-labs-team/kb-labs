/**
 * UI Facade for V3 Plugin System
 *
 * Provides a host-agnostic interface for user interaction.
 * Implementation varies by host:
 * - CLI: chalk/ora to stdout
 * - REST: Collected for response
 * - Workflow: Logged to run
 */

/**
 * Spinner interface for long-running operations
 */
export interface Spinner {
  /**
   * Update spinner message
   */
  update(message: string): void;

  /**
   * Mark as successful
   */
  succeed(message?: string): void;

  /**
   * Mark as failed
   */
  fail(message?: string): void;

  /**
   * Stop the spinner
   */
  stop(): void;
}

/**
 * Table column configuration
 */
export interface TableColumn {
  /** Column header */
  header: string;
  /** Property key in data objects */
  key: string;
  /** Column width (optional) */
  width?: number;
  /** Text alignment */
  align?: 'left' | 'center' | 'right';
}

/**
 * Color function type - takes a string and returns it wrapped in ANSI color codes
 */
export type ColorFunction = (text: string) => string;

/**
 * Colors API - strategic color application for semantic and accent colors
 */
export interface Colors {
  // Semantic colors
  success: ColorFunction;
  error: ColorFunction;
  warning: ColorFunction;
  info: ColorFunction;

  // Accent palette
  primary: ColorFunction;
  accent: ColorFunction;
  highlight: ColorFunction;
  secondary: ColorFunction;
  emphasis: ColorFunction;
  muted: ColorFunction;
  foreground: ColorFunction;

  // Formatting helpers
  dim: ColorFunction;
  bold: ColorFunction;
  underline: ColorFunction;
  inverse: ColorFunction;
}

/**
 * Symbols API - visual indicators and box-drawing characters
 */
export interface Symbols {
  // Status symbols
  success: string;
  error: string;
  warning: string;
  info: string;

  // UI elements
  bullet: string;
  clock: string;
  folder: string;
  package: string;
  pointer: string;
  section: string;
  step: string;
  stepDone: string;
  arrow: string;
  diamond: string;

  // Box-drawing characters
  separator: string;
  border: string;
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  leftT: string;
  rightT: string;
}

/**
 * Structured log entry for ctx.ui.log().
 * Stateless, fire-and-forget, no boxing.
 * See UIFacade.log() for full semantics.
 */
export interface UILogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  fields?: Record<string, unknown>;
}

/**
 * UI Facade interface
 *
 * All output goes through this interface so plugins don't need to know
 * which entry point they're running in.
 */
export interface UIFacade {
  /**
   * Color utilities for semantic and accent colors
   *
   * Example:
   * ```
   * ctx.ui.write(ctx.ui.colors.success('✓ Success') + '\n');
   * ctx.ui.write(ctx.ui.colors.accent('Plugin loaded') + '\n');
   * ```
   */
  colors: Colors;

  /**
   * Symbol characters for visual indicators and box-drawing
   *
   * Example:
   * ```
   * ctx.ui.write(ctx.ui.symbols.success + ' Done\n');
   * ctx.ui.write(ctx.ui.symbols.pointer + ' Item\n');
   * ```
   */
  symbols: Symbols;

  /**
   * Write raw text to output (without newline)
   *
   * Use this for low-level output control. For most cases, prefer
   * info(), success(), warn(), error() which provide semantic formatting.
   *
   * @param text - Text to write (can include ANSI color codes)
   */
  write(text: string): void;

  /**
   * Print info message
   *
   * @param message - Main message text
   * @param options - Optional formatting options (title, sections, timing)
   */
  info(message: string, options?: MessageOptions): void;

  /**
   * Print success message (usually green)
   *
   * @param message - Main message text
   * @param options - Optional formatting options (title, sections, timing)
   */
  success(message: string, options?: MessageOptions): void;

  /**
   * Print warning message (usually yellow)
   *
   * @param message - Main message text
   * @param options - Optional formatting options (title, sections, timing)
   */
  warn(message: string, options?: MessageOptions): void;

  /**
   * Print error message/object (usually red)
   *
   * @param error - Error object or message string
   * @param options - Optional formatting options (title, sections, timing)
   */
  error(error: Error | string, options?: MessageOptions): void;

  /**
   * Print debug message (only shown in verbose mode)
   */
  debug(message: string): void;

  /**
   * Start a spinner/progress indicator
   *
   * Returns a Spinner that can be updated, succeeded, failed, or stopped.
   */
  spinner(message: string): Spinner;

  /**
   * Print a table of data
   *
   * @param data Array of objects to display
   * @param columns Optional column configuration
   */
  table(data: Record<string, unknown>[], columns?: TableColumn[]): void;

  /**
   * Print raw JSON (for --json mode).
   *
   * Defaults to a single compact line — the machine-readable contract agents
   * rely on (`… --json | grep "^{"` yields one parseable object). Pass
   * `{ pretty: true }` for human-readable multi-line indentation.
   */
  json(data: unknown, options?: { pretty?: boolean }): void;

  /**
   * Print a newline
   */
  newline(): void;

  /**
   * Print a horizontal rule/divider
   */
  divider(): void;

  /**
   * Print a box with content
   */
  box(content: string, title?: string): void;

  /**
   * Print a structured side box with title, summary, sections, and timing
   *
   * Example:
   * ```
   * ctx.ui.sideBox({
   *   title: 'Hello Command',
   *   status: 'success',
   *   summary: {
   *     'Target': 'World',
   *     'Mode': 'production'
   *   },
   *   sections: [
   *     { header: 'Details', items: ['Item 1', 'Item 2'] }
   *   ],
   *   timing: 1234
   * });
   * ```
   */
  sideBox(options: SideBoxOptions): void;

  /**
   * Print multiple side boxes as a continuous visual chain.
   *
   * Each item renders `◆  Title` as a block opener on a shared rail.
   * Only the last item gets `└  status  timing`.
   *
   * Example:
   * ```
   * ctx.ui.chain([
   *   { title: 'Metrics', sections: [{ items: ['cpu: 80%'] }] },
   *   { title: 'Warning', sections: [{ items: ['High load detected'] }], status: 'warning', timing: 12 },
   * ]);
   * ```
   */
  chain(items: ChainItem[]): void;

  /**
   * Prompt for confirmation. A context without a prompt responder rejects with
   * InteractiveInputRequiredError instead of substituting defaultValue.
   */
  confirm(message: string, options?: { defaultValue?: boolean }): Promise<boolean>;

  /**
   * Prompt for text input. A context without a prompt responder rejects with
   * InteractiveInputRequiredError instead of substituting a default.
   */
  prompt(message: string, options?: PromptOptions): Promise<string>;

  /**
   * Prompt to select a single value from a list. A context without a prompt
   * responder rejects with InteractiveInputRequiredError.
   */
  select<T = string>(message: string, choices: SelectChoice<T>[]): Promise<T>;

  /**
   * Prompt to select multiple values from a list. A context without a prompt
   * responder rejects with InteractiveInputRequiredError.
   */
  multiSelect<T = string>(message: string, choices: MultiSelectChoice<T>[]): Promise<T[]>;

  /**
   * Emit a structured log entry — stateless, fire-and-forget, no boxing.
   *
   * Unlike info/warn/error (which render rich sideBorderBox UI), this is a
   * compact single-line log primitive intended for high-frequency output.
   *
   * In workflow context: flows through StreamingUI → log.line → onLog → SQLite + SSE.
   * In CLI context: renders as a compact line via logLine() from shared-cli-ui.
   * In JSON mode: emitted as NDJSON to stdout.
   *
   * See: services/workflow/docs/adr/0019-log-stream-separation.md
   */
  log(entry: UILogEntry): void;
}

/** UI methods available to plugin handlers. Command results and failures are returned, not printed. */
export type PluginHandlerUIFacade = Omit<UIFacade, 'json' | 'error'>;

/**
 * Options for text prompts
 */
export interface PromptOptions {
  /** Default value */
  default?: string;
  /** Whether to mask input (for passwords) */
  mask?: boolean;
  /** Validation function */
  validate?: (value: string) => boolean | string;
}

/**
 * A choice for select/multiSelect prompts
 */
export interface SelectChoice<T = string> {
  label: string;
  value: T;
  hint?: string;
}

/**
 * A choice for multiSelect prompts (with optional pre-check)
 */
export interface MultiSelectChoice<T = string> extends SelectChoice<T> {
  checked?: boolean;
}

/**
 * Rich section item — either a plain string or a descriptor with optional dim styling
 */
export interface RichOutputSectionItem {
  text: string;
  /** Render text in muted/dim color */
  dim?: boolean;
  /** Hard-truncate to N visible chars instead of wrapping. Use large value (e.g. 500) to prevent wrapping without truncation. */
  truncate?: number;
}

/** A section item — either a plain string or a rich descriptor */
export type OutputSectionItem = string | RichOutputSectionItem;

/**
 * Section for structured output (sideBox)
 */
export interface OutputSection {
  /** Section header (optional) */
  header?: string;
  /** List of items in this section */
  items: OutputSectionItem[];
}

/**
 * Options for formatted output messages (info, success, warn, error)
 */
export interface MessageOptions {
  /** Optional title for the box (defaults to message type) */
  title?: string;
  /** Content sections to display in box */
  sections?: OutputSection[];
  /** Timing in milliseconds to display in footer */
  timing?: number;
  /** Root cause — shown below the message in muted text */
  cause?: string;
  /** Human-readable hint — what to do next */
  hint?: string;
  /** Suggested command to run — shown as `$ <command>` */
  command?: string;
  /** Summary key-value pairs rendered before sections */
  summary?: Record<string, string | number | boolean>;
}

/**
 * A single block in a chained output (used with UIFacade.chain)
 */
export interface ChainItem {
  title: string;
  sections?: OutputSection[];
  summary?: Record<string, string | number | boolean>;
  status?: 'success' | 'error' | 'info' | 'warning';
  timing?: number;
}

/**
 * Options for sideBox structured output
 */
export interface SideBoxOptions {
  /** Box title */
  title: string;
  /** Status indicator */
  status?: 'success' | 'error' | 'info' | 'warning';
  /** Summary key-value pairs */
  summary?: Record<string, string | number | boolean>;
  /** Additional content sections */
  sections?: OutputSection[];
  /** Timing in milliseconds */
  timing?: number;
}

/** Structured representation of a single UIFacade output call. */
export type UIOutput =
  | { kind: 'message'; level: 'info' | 'success' | 'warn' | 'error'; message: string; options?: MessageOptions }
  | { kind: 'sideBox'; options: SideBoxOptions }
  | { kind: 'chain'; items: ChainItem[] }
  | { kind: 'table'; data: Record<string, unknown>[]; columns?: TableColumn[] }
  | { kind: 'json'; data: unknown; pretty?: boolean };

function outputItemText(item: OutputSectionItem): string {
  return typeof item === 'string' ? item : item.text;
}

function outputSectionsText(sections: OutputSection[] = []): string[] {
  return sections.flatMap(section => [
    ...(section.header ? [section.header] : []),
    ...section.items.map(outputItemText),
  ]);
}

/** Plain text rendering of the shared UI model for non-terminal consumers. */
export function renderUIOutputText(output: UIOutput): string {
  switch (output.kind) {
    case 'message': {
      const options = output.options;
      const displayLevel = output.level === 'success' ? 'ok' : output.level;
      const lines = [`[${displayLevel}] ${options?.title ?? output.message}`];
      if (options?.title && options.title !== output.message) lines.push(output.message);
      for (const [key, value] of Object.entries(options?.summary ?? {})) lines.push(`${key}: ${value}`);
      lines.push(...outputSectionsText(options?.sections));
      if (options?.cause) lines.push(`Cause: ${options.cause}`);
      if (options?.hint) lines.push(`Hint: ${options.hint}`);
      if (options?.command) lines.push(`$ ${options.command}`);
      if (options?.timing !== undefined) lines.push(`Completed in ${options.timing}ms`);
      return lines.join('\n');
    }
    case 'sideBox': {
      const { options } = output;
      return [
        `[${options.title}]`,
        ...Object.entries(options.summary ?? {}).map(([key, value]) => `${key}: ${value}`),
        ...outputSectionsText(options.sections),
        ...(options.timing === undefined ? [] : [`Completed in ${options.timing}ms`]),
      ].join('\n');
    }
    case 'chain':
      return output.items.map(item => [
        `◆ ${item.title}`,
        ...Object.entries(item.summary ?? {}).map(([key, value]) => `${key}: ${value}`),
        ...outputSectionsText(item.sections),
        ...(item.timing === undefined ? [] : [`Completed in ${item.timing}ms`]),
      ].join('\n')).join('\n');
    case 'table': {
      if (output.data.length === 0) return '';
      const columns = output.columns ?? Object.keys(output.data[0]!).map(key => ({ header: key, key }));
      return [columns.map(column => column.header).join('\t'), ...output.data.map(row => columns.map(column => String(row[column.key] ?? '')).join('\t'))].join('\n');
    }
    case 'json':
      return output.pretty ? JSON.stringify(output.data, null, 2) : JSON.stringify(output.data);
    default: {
      const exhaustive: never = output;
      return exhaustive;
    }
  }
}

/**
 * No-op color functions (return text as-is)
 */
const noopColor = (text: string) => text;

/**
 * No-op colors implementation
 */
const noopColors: Colors = {
  success: noopColor,
  error: noopColor,
  warning: noopColor,
  info: noopColor,
  primary: noopColor,
  accent: noopColor,
  highlight: noopColor,
  secondary: noopColor,
  emphasis: noopColor,
  muted: noopColor,
  foreground: noopColor,
  dim: noopColor,
  bold: noopColor,
  underline: noopColor,
  inverse: noopColor,
};

/**
 * No-op symbols implementation (plain text fallback)
 */
const noopSymbols: Symbols = {
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: '◆',
  bullet: '•',
  clock: '◷',
  folder: '▸',
  package: '◆',
  pointer: '❯',
  section: '│',
  step: '○',
  stepDone: '●',
  arrow: '→',
  diamond: '◆',
  separator: '─',
  border: '│',
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  leftT: '├',
  rightT: '┤',
};

/** Structured failure for a required prompt in an execution context without a responder. */
export class InteractiveInputRequiredError extends Error {
  readonly code = 'KB_RUNTIME_INPUT_INVALID';
  override readonly cause: string;

  constructor(readonly hint: string, cause: string) {
    super();
    this.cause = cause;
  }
}

function unavailablePrompt(message: string): InteractiveInputRequiredError {
  return new InteractiveInputRequiredError(
    'Provide the value as workflow or request input, then run `kb workflow run --help`.',
    `The prompt "${message}" cannot be answered in this execution context.`,
  );
}

/**
 * Silent UI implementation. Output is discarded, but required prompts fail
 * because this context has no responder that can collect their values.
 */
export const noopUI: UIFacade = {
  colors: noopColors,
  symbols: noopSymbols,
  write: () => {},
  info: () => {},
  success: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  spinner: () => ({
    update: () => {},
    succeed: () => {},
    fail: () => {},
    stop: () => {},
  }),
  table: () => {},
  json: () => {},
  newline: () => {},
  divider: () => {},
  box: () => {},
  sideBox: () => {},
  chain: () => {},
  confirm: async (message) => { throw unavailablePrompt(message); },
  prompt: async (message) => { throw unavailablePrompt(message); },
  select: async (message) => { throw unavailablePrompt(message); },
  multiSelect: async (message) => { throw unavailablePrompt(message); },
  log: () => {},
};
