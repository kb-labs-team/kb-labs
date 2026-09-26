import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runtime state goes to $KB_HOME/state/<projectId>/ (ADR-0044): keep tests
    // away from the real ~/.kb.
    setupFiles: ['./src/__tests__/setup-kb-home.ts'],
  },
});
