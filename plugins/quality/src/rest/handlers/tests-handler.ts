/**
 * GET /tests handler
 *
 * Test execution and coverage tracking across monorepo
 */

import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { runTests } from '../../core/tests/index.js';
import type { TestRunResult } from '../../contracts/index.js';

export type TestsRequest = {
  package?: string;
  timeout?: number;
  withCoverage?: boolean;
  coverageOnly?: boolean;
};

export type TestsResponse = TestRunResult;

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<TestsRequest, unknown>
  ): Promise<TestsResponse> {
    try {
      const { package: packageFilter, timeout, withCoverage, coverageOnly } = input.query ?? {};

      return runTests(ctx.cwd, {
        packageFilter,
        timeout: timeout || 60000,
        withCoverage: withCoverage ?? false,
        coverageOnly: coverageOnly ?? false,
      });
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
