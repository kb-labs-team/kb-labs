export type ProcessErrorCode =
  | 'PROCESS_TIMEOUT'
  | 'PROCESS_CANCELLED'
  | 'PROCESS_MEMORY_LIMIT'
  | 'PROCESS_CPU_LIMIT'
  | 'PROCESS_LIMIT'
  | 'PROCESS_OUTPUT_LIMIT'
  | 'PROCESS_ADMISSION_TIMEOUT'
  | 'PROCESS_SPAWN_FAILED';

export interface GovernedProcessLimit {
  resource: 'memory (MB)' | 'time (ms)' | 'CPU time (ms)' | 'process count' | 'captured output (bytes)' | 'admission time (ms)';
  observed: number;
  allowed: number;
}

export class GovernedProcessError extends Error {
  readonly code: ProcessErrorCode;
  readonly details: Record<string, unknown>;
  readonly limit?: GovernedProcessLimit;

  constructor(code: ProcessErrorCode, message: string, details: Record<string, unknown> = {}, limit?: GovernedProcessLimit) {
    super(message);
    this.name = 'GovernedProcessError';
    this.code = code;
    this.details = details;
    this.limit = limit;
  }
}
