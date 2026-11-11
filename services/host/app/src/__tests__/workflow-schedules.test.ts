import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectView } from "@kb-labs/core-contracts";
import { findScheduledProjects } from "../project-runtime/workflow-schedules.js";

describe("findScheduledProjects", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps projects warm for enabled user crons and ignores disabled or legacy job files", async () => {
    const root = await mkdtemp(join(tmpdir(), "kb-scheduled-project-"));
    roots.push(root);
    await mkdir(join(root, ".kb", "workflows"), { recursive: true });
    await mkdir(join(root, ".kb", "jobs"), { recursive: true });
    await mkdir(join(root, ".kb", "crons"), { recursive: true });
    await writeFile(join(root, ".kb", "workflows", "release.yml"),
      "name: release\non:\n  schedule:\n    cron: '* * * * *'\n");
    await writeFile(join(root, ".kb", "jobs", "enabled.yml"),
      "name: legacy\nschedule: '* * * * *'\nenabled: true\njobs: {}\n");
    await writeFile(join(root, ".kb", "crons", "enabled.yml"),
      "schedule: '* * * * *'\nworkflow: release\nenabled: true\n");
    await writeFile(join(root, ".kb", "crons", "disabled.yml"),
      "schedule: '* * * * *'\nworkflow: release\nenabled: false\n");
    await writeFile(join(root, ".kb", "crons", "enabled-handler.yml"),
      "schedule: '* * * * *'\nhandler: steward:daily-review\nenabled: true\n");

    const view = {
      project: { id: "prj_test", name: "scheduled", status: "active", addedAt: "", path: root },
      declaration: {},
      pathExists: true,
      stateDir: join(root, ".state"),
    } as ProjectView;
    const registry = { list: async () => ({ projects: [view], diagnostics: [] }) };

    await expect(findScheduledProjects(registry)).resolves.toMatchObject([
      { id: "prj_test", root, keptRunningSchedules: 2 },
    ]);
  });
});
