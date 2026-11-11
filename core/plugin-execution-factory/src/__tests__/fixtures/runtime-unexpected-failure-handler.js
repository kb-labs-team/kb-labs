import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform';

export default {
  async execute(input) {
    const error = new ErrorEnvelopeError(createErrorEnvelope('KB_RUNTIME_UNEXPECTED', {
      correlationId: input.correlationId,
    }));
    error.cause = new Error('unexpected REST handler fixture cause');
    throw error;
  },
};
