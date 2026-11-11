import { workflowCommandError } from './errors.js';

workflowCommandError('KB_RUNTIME_INPUT_INVALID', 'Invalid input.', 'Correct the field and retry.', {
  // @ts-expect-error The workflow bridge must accept only catalogue-declared details.
  details: { field: 'input', unexpected: 'value' },
});
