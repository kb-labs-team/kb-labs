/**
 * TruncationProcessor — truncates tool output exceeding a character limit.
 *
 * Prevents 55k+ token overflows caused by large file reads or shell output.
 * Appends a summary line so the agent knows content was truncated.
 *
 * Default limit: 20_000 chars (~5,000 tokens). Configurable per instance.
 */

import type { OutputProcessor, ToolExecCtx } from '../../sdk/index.js';

export interface TruncationOptions {
  /** Maximum characters to allow through. Default: 20_000. */
  maxChars?: number;
  /**
   * Message appended after truncation.
   * Use {remaining} as placeholder for the number of truncated characters.
   */
  truncationMessage?: string;
}

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_MESSAGE =
  '\n\n[Output truncated: {remaining} additional characters not shown. Use a more targeted query to see the full content.]';

export class TruncationProcessor implements OutputProcessor {
  readonly name = 'truncation';
  private readonly maxChars: number;
  private readonly truncationMessage: string;

  constructor(options: TruncationOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.truncationMessage = options.truncationMessage ?? DEFAULT_MESSAGE;
  }

  process(output: string, _ctx: ToolExecCtx): string {
    if (output.length <= this.maxChars) {return output;}

    const truncated = output.slice(0, this.maxChars);
    const remaining = output.length - this.maxChars;
    const suffix = this.truncationMessage.replace('{remaining}', String(remaining));

    return truncated + suffix;
  }
}
