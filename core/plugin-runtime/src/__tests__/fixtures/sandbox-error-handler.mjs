import {
  AdapterUnavailableError,
  ErrorEnvelopeError,
  createProductErrorEnvelope,
} from '@kb-labs/core-platform';

export default {
  /** @type {import('@kb-labs/plugin-contracts').CommandHandler} */
  async execute(_context, input) {
    if (input.kind === 'adapter') {
      const error = new AdapterUnavailableError(
        'llm',
        'load-failed',
        'fixture adapter failed to load',
        undefined,
        {
          hint: 'Inspect the fixture adapter and retry.',
          userMessage: 'The fixture adapter is unavailable.',
          action: {
            id: 'inspect-fixture-adapter',
            label: 'Inspect fixture adapter',
            command: 'kb adapter bind llm @kb-labs/adapters-openai',
          },
        },
      );
      error.stack = 'AdapterUnavailableError: fixture adapter failed to load\n    at fixture (sandbox-error-handler.mjs:1:1)';
      throw error;
    }

    const error = new ErrorEnvelopeError(createProductErrorEnvelope({
      code: 'SANDBOX_FIXTURE_FAILED',
      message: 'Fixture product failure.',
      hint: 'Repair the fixture product failure and retry.',
      retryable: false,
      details: { fixture: 'sandbox-error-handler' },
      actions: [{
        id: 'repair-fixture',
        label: 'Repair fixture',
        command: 'kb plugin repair sandbox-fixture',
      }],
    }));
    error.stack = 'ProductFailure: Fixture product failure.\n    at fixture (sandbox-error-handler.mjs:2:1)';
    throw error;
  },
};
