import type { DiagnosticCode } from '@kb-labs/plugin-contracts';

export interface HandlerAccessFailure {
  code: Extract<DiagnosticCode, 'COMMAND_HANDLER_MISSING' | 'COMMAND_HANDLER_UNREADABLE'>;
  reason: string;
}

export function describeHandlerAccessFailure(error: unknown): HandlerAccessFailure {
  const errno = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (errno === 'ENOENT') {
    return { code: 'COMMAND_HANDLER_MISSING', reason: 'was not found' };
  }
  return {
    code: 'COMMAND_HANDLER_UNREADABLE',
    reason: `could not be accessed: ${error instanceof Error ? error.message : String(error)}`,
  };
}
