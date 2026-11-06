import { createErrorEnvelope, createCatalogErrorEnvelope } from './catalog.js';
import { AdapterCredentialsMissingError } from '../errors.js';

createErrorEnvelope('KB_CONFIG_INVALID', {
  details: { path: 'someSection.key', nextCommand: 'kb config set plugins.someSection.key 1' },
});

// @ts-expect-error The catalog does not declare reason as a KB_CONFIG_INVALID detail.
createErrorEnvelope('KB_CONFIG_INVALID', { details: { path: 'someSection.key', reason: 'project-scope-path' } });

// @ts-expect-error The catalog requires the path template parameter.
createErrorEnvelope('KB_CONFIG_INVALID', { details: { nextCommand: 'kb config set plugins.someSection.key 1' } });

// Overriding the hint removes its template parameters from the required set.
createErrorEnvelope('KB_RUNTIME_UNKNOWN_COMMAND', { hint: 'Use the command registry.' });

// @ts-expect-error The hint template still needs binary when it is not overridden.
createErrorEnvelope('KB_RUNTIME_UNKNOWN_COMMAND');

// Overriding both catalog templates removes their otherwise required values.
createErrorEnvelope('KB_PLUGIN_NOT_FOUND', { message: 'Plugin missing.', hint: 'Install it.' });

// @ts-expect-error An error without catalogue detail fields cannot acquire ad hoc fields.
createErrorEnvelope('KB_AUTH_CLOCK_SKEW', { details: { reason: 'clock mismatch' } });

const credentialError = new AdapterCredentialsMissingError('llm', 'OPENAI_API_KEY', 'adapters.llm');

// @ts-expect-error Adapter errors expose only the details declared for their code.
credentialError.details.reason;

createErrorEnvelope('KB_RUNTIME_TIMEOUT', { details: { timeoutMs: '300' } });
// @ts-expect-error Worker execution identity is not a catalogued public timeout detail.
createErrorEnvelope('KB_RUNTIME_TIMEOUT', { details: { executionId: 'exec-1' } });
// @ts-expect-error Catalogued timeout details are strings.
createErrorEnvelope('KB_RUNTIME_TIMEOUT', { details: { timeoutMs: 300 } });

createCatalogErrorEnvelope({ code: 'KB_RUNTIME_TIMEOUT', details: { timeoutMs: '300' } });
// @ts-expect-error The producer's details come from the catalogue.
createCatalogErrorEnvelope({ code: 'KB_RUNTIME_TIMEOUT', details: { executionId: 'exec-1' } });

// @ts-expect-error Required catalog details cannot be omitted by tuple producers.
createCatalogErrorEnvelope({ code: 'KB_CONFIG_INVALID' });

// @ts-expect-error The command diagnostic requires its runtime binary parameter.
createCatalogErrorEnvelope({ code: 'KB_RUNTIME_COMMAND_FAILED',});
// @ts-expect-error Undeclared runtime parameters cannot be supplied.
createCatalogErrorEnvelope({ code: 'KB_RUNTIME_COMMAND_FAILED', templateValues: { binary: 'kb', extra: 'invalid' } });
createCatalogErrorEnvelope({ code: 'KB_RUNTIME_COMMAND_FAILED', templateValues: { binary: 'kb' } });
createCatalogErrorEnvelope({ code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Command failed', hint: 'Retry it' });

// @ts-expect-error Supplying the template object still requires binary.
createCatalogErrorEnvelope({ code: 'KB_RUNTIME_COMMAND_FAILED', templateValues: {} });

createCatalogErrorEnvelope({ code: 'KB_RUNTIME_COMMAND_FAILED', hint: 'Retry the command.' });
// @ts-expect-error Overriding the message does not supply the hint's required binary.
createCatalogErrorEnvelope({ code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Command failed.' });
