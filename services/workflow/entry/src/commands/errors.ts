import type { DetailsFor, DetailsOptionFor, PlatformErrorCode } from '@kb-labs/core-platform/error-envelope';

type WorkflowErrorCode = Extract<PlatformErrorCode,
  'KB_RUNTIME_INPUT_INVALID' | 'KB_RUNTIME_COMMAND_FAILED' | 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY'>;

type WorkflowErrorOptions<C extends WorkflowErrorCode> = DetailsOptionFor<C> & { cause?: string };
type WorkflowCommandFailure<C extends WorkflowErrorCode> = {
  ok: false;
  error: { code: C; message: string; hint: string } & WorkflowErrorOptions<C>;
};

export function workflowCommandError<C extends WorkflowErrorCode>(
  code: C,
  message: string,
  hint: string,
  options: WorkflowErrorOptions<C>
): WorkflowCommandFailure<C> {
  return {
    ok: false,
    error: { code, message, hint, ...options },
  };
}
