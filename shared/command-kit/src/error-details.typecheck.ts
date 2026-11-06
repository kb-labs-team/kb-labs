import { throwSystemCataloguedFailure, throwSystemCommandError } from './define-system-command.js';
import { ServiceNotConfiguredError } from './helpers/platform.js';
import { ValidationError } from './helpers/validation.js';

function validCataloguedFailure(): never {
  return throwSystemCataloguedFailure({ code: 'KB_CONFIG_INVALID', message: 'Invalid config.', hint: 'Repair the config.', details: { path: 'someSection.key' } });
}

function undeclaredCataloguedFailureDetail(): never {
  // @ts-expect-error A catalogued command bridge cannot emit undeclared details.
  return throwSystemCataloguedFailure({ code: 'KB_CONFIG_INVALID', message: 'Invalid config.', hint: 'Repair the config.', details: { path: 'someSection.key', reason: 'project-scope-path' } });
}

function missingRequiredCataloguedFailureDetail(): never {
  // @ts-expect-error The required path template detail cannot be omitted.
  return throwSystemCataloguedFailure({ code: 'KB_CONFIG_INVALID' });
}

function validCommandFailure(): never {
  return throwSystemCommandError('Command failed.', 'Run `kb command --help` and retry.', { command: 'kb command' });
}

function undeclaredCommandFailureDetail(): never {
  // @ts-expect-error The command-failure bridge accepts only catalogue-declared fields.
  return throwSystemCommandError('Command failed.', 'Run `kb command --help` and retry.', { reason: 'failure' });
}

const serviceError = new ServiceNotConfiguredError('llm', '@kb-labs/adapters-openai');
const validationError = new ValidationError('Invalid input.', [{ path: 'name', message: 'Required' }]);

// @ts-expect-error The service error emits only its catalogue details.
serviceError.details.reason;

// @ts-expect-error Validation fields use the catalogue's `field` detail.
validationError.details.name;
