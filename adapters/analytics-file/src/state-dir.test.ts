import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRuntimeStatePath } from "@kb-labs/sdk/adapters";
import createAdapter from "./index.js";

const context = { source: { product: "test", version: "1.0.0" }, runId: "run-test" };

let project: string;
let kbHome: string;
let previousKbHome: string | undefined;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "kb-afile-project-")));
  kbHome = realpathSync(mkdtempSync(join(tmpdir(), "kb-afile-home-")));
  previousKbHome = process.env.KB_HOME;
  process.env.KB_HOME = kbHome;
});

afterEach(() => {
  if (previousKbHome === undefined) {
    delete process.env.KB_HOME;
  } else {
    process.env.KB_HOME = previousKbHome;
  }
  rmSync(project, { recursive: true, force: true });
  rmSync(kbHome, { recursive: true, force: true });
});

describe("FileAnalytics default baseDir (ADR-0044)", () => {
  it("writes to the project state directory when no baseDir is configured", async () => {
    const analytics = createAdapter({ workspace: { cwd: project }, analytics: context });
    await analytics.track("llm.complete");

    const dir = resolveRuntimeStatePath(project, ["analytics", "buffer"]);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    expect(existsSync(join(project, ".kb"))).toBe(false);
  });

  it("keeps an explicit relative baseDir under the project", async () => {
    const analytics = createAdapter({ workspace: { cwd: project }, analytics: context, baseDir: "events" });
    await analytics.track("llm.complete");

    expect(readdirSync(join(project, "events")).length).toBeGreaterThan(0);
    expect(existsSync(resolveRuntimeStatePath(project, ["analytics"]))).toBe(false);
  });
});
