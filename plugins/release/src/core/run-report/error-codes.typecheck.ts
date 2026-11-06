import { createReleaseError } from './error-codes';

createReleaseError({
  code: 'KB_RELEASE_INDEX_SEAL_FAILED',
  details: { gate: 'publish', rule: 'immutable' },
});

createReleaseError({
  code: 'KB_RELEASE_INDEX_SEAL_FAILED',
  // @ts-expect-error Release details must be declared for the selected catalogue code.
  details: { gate: 'publish', rule: 'immutable', reason: 'wrong' },
});
