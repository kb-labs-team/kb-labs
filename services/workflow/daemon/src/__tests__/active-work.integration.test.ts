import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IStorage } from "@kb-labs/core-platform";
import { InMemoryCache, InMemoryEventBus } from "@kb-labs/core-platform/inmemory";
import { mockLogger } from "@kb-labs/shared-testing";
import { ActiveWorkRegistry } from "@kb-labs/shared-daemon";
import { EnvSecretProvider, WorkflowEngine } from "@kb-labs/workflow-engine";
import { createWorkflowActiveWorkProvider } from "../active-work.js";

describe("workflow active-work provider", () => {
  let workspace: string | undefined;

  afterEach(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch((error: unknown) => {
        console.error("Could not remove workflow active-work fixture:", error);
      });
      workspace = undefined;
    }
  });

  it("feeds the host registry from the workflow state store after engine recreation", async () => {
    workspace = await mkdtemp(join(tmpdir(), "workflow-active-work-"));
    const storage = new TemporaryFileStorage(join(workspace, "state"));
    const firstEngine = new WorkflowEngine({
      projectId: "prj_0000000000000001",
      secretProvider: new EnvSecretProvider(),
      cache: new InMemoryCache(), storage, events: new InMemoryEventBus(), logger: mockLogger(),
      workspaceRoot: workspace,
    });
    const run = await firstEngine.createRun({
      spec: {
        name: "restart-owned-work", version: "1.0.0", on: { manual: true },
        jobs: { build: { runsOn: "local", steps: [{ id: "wait", name: "Wait", uses: "builtin:shell", with: { command: "true" } }] } },
      },
      trigger: { type: "manual" },
    });
    const restartedEngine = new WorkflowEngine({
      projectId: "prj_0000000000000001",
      secretProvider: new EnvSecretProvider(),
      cache: new InMemoryCache(), storage, events: new InMemoryEventBus(), logger: mockLogger(),
      workspaceRoot: workspace,
    });
    const registry = new ActiveWorkRegistry();
    registry.register("workflow", createWorkflowActiveWorkProvider(restartedEngine.getStateStore()));

    await expect(registry.list()).resolves.toEqual([
      { kind: "job", id: run.jobs[0]!.id, owningService: "workflow" },
      { kind: "workflow", id: run.id, owningService: "workflow" },
    ]);
  });
});

/** A file-backed IStorage fixture so the recreated engine reads persisted records. */
class TemporaryFileStorage implements IStorage {
  constructor(private readonly root: string) {}

  async read(path: string): Promise<Buffer | null> {
    try {
      return await readFile(this.file(path));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async write(path: string, data: Buffer): Promise<void> {
    const target = this.file(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  async delete(path: string): Promise<void> {
    await rm(this.file(path), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const start = this.file(prefix);
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(child);
        } else if (entry.isFile()) {
          files.push(relative(this.root, child).split("\\").join("/"));
        }
      }
    };
    await visit(start);
    return files;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.file(path));
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private file(path: string): string {
    const target = resolve(this.root, path);
    if (target !== this.root && !target.startsWith(`${this.root}/`)) {
      throw new Error(`Storage fixture path escapes its temporary root: ${path}`);
    }
    return target;
  }
}
