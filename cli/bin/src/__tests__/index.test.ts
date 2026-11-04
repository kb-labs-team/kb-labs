import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { executeCliMock } = vi.hoisted(() => {
  const executeCliMock = vi.fn();
  return { executeCliMock };
});

vi.mock("../runtime/bootstrap", () => ({
  executeCli: executeCliMock,
}));

const { run } = await import("../index");

describe("CLI run function", () => {
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => { });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    executeCliMock.mockReset();
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
  });

  it("delegates execution to executeCli", async () => {
    executeCliMock.mockResolvedValue(0);
    const resultWriter = vi.fn();
    const result = await run(["--help"], { resultWriter });

    expect(executeCliMock).toHaveBeenCalledWith(
      ["--help"],
      { moduleUrl: undefined, resultWriter },
    );
    expect(result).toBe(0);
  });

  it("propagates exit codes from executeCli", async () => {
    executeCliMock.mockResolvedValue(42);
    const resultWriter = vi.fn();

    const result = await run(["version"], { resultWriter });

    expect(result).toBe(42);
  });
});
