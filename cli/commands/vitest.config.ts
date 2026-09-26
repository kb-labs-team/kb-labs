import config from "@kb-labs/devkit/vitest/node";

export default {
  ...config,
  test: {
    ...config.test,
    // Runtime state goes to $KB_HOME/state/<projectId>/ (ADR-0044): keep tests
    // away from the real ~/.kb.
    setupFiles: [...(config.test?.setupFiles ?? []), "./src/__tests__/setup-kb-home.ts"],
  },
};
