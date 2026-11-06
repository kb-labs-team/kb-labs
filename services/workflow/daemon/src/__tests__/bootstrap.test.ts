import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runService: vi.fn(),
}));

vi.mock("@kb-labs/shared-daemon", () => ({
  runService: mocks.runService,
}));

import { bootstrap } from "../bootstrap.js";

describe("workflow daemon standalone launcher", () => {
  const originalProjectId = process.env.KB_PROJECT_ID;

  afterEach(() => {
    mocks.runService.mockReset();
    if (originalProjectId === undefined) {
      delete process.env.KB_PROJECT_ID;
    } else {
      process.env.KB_PROJECT_ID = originalProjectId;
    }
  });

  it("maps the standalone project identity into service context configuration once", async () => {
    process.env.KB_PROJECT_ID = "prj_1234567890123456";

    await bootstrap("/registered/project");

    expect(mocks.runService).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "workflow-daemon",
        startDir: "/registered/project",
        projectScope: "required",
        projectId: "prj_1234567890123456",
      }),
    );
  });
});
