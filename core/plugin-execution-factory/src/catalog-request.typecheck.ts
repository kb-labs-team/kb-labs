import type { CataloguedExecutionDiagnostic } from './errors.js';

const valid: CataloguedExecutionDiagnostic = { code: 'QUEUE_FULL', details: { queueSize: '1', maxQueueSize: '2' } };
// @ts-expect-error Queue details do not belong to the acquire-timeout code.
const mismatched: CataloguedExecutionDiagnostic = { code: 'ACQUIRE_TIMEOUT', details: { queueSize: '1', maxQueueSize: '2' } };
void valid;
void mismatched;
