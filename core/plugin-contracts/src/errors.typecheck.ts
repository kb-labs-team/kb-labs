import { createProductErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import { PluginError, ProductPluginError } from './errors.js';

const productError = createProductErrorEnvelope({
  code: 'COMMIT_NOTHING_STAGED',
  message: 'Nothing is staged.',
  hint: 'Stage the intended changes, then retry.',
  retryable: false,
});

new ProductPluginError('Nothing is staged.', productError.code, 400, undefined, productError.hint);

// Product failures require a user-facing hint; platform errors keep their catalogued optional hint.
// @ts-expect-error ProductPluginError requires a hint.
new ProductPluginError('Nothing is staged.', productError.code, 400, undefined);

// @ts-expect-error ProductPluginError does not accept non-string hints.
new ProductPluginError('Nothing is staged.', productError.code, 400, undefined, { remedy: 'stage' });

// @ts-expect-error Platform plugin errors allow an omitted hint, but a present hint is a string.
new PluginError('Unexpected failure.', 'KB_RUNTIME_UNEXPECTED', undefined, { remedy: 'inspect logs' });
