import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertManagedCandidateRoots } from "./managed-generation-mutation.js";

describe("managed Marketplace root guard", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("accepts only a non-active candidate from the same install root", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "managed-marketplace-roots-")));
    const active = join(root, "versions", "1.0.0");
    const stage = join(root, "versions", ".stage-managed-test");
    for (const version of [active, stage]) {
      await mkdir(join(version, ".kb", "v2"), { recursive: true });
      await writeFile(join(version, ".kb", "v2", "receipt.json"), JSON.stringify({ installationId: "install-a" }));
    }
    await symlink(relative(root, active), join(root, "current"));
    await expect(assertManagedCandidateRoots(stage, active, stage)).resolves.toBeUndefined();
    await expect(assertManagedCandidateRoots(active, active, active)).rejects.toThrow(/managed candidate generation/);
    await expect(assertManagedCandidateRoots(stage, root, stage)).rejects.toThrow(/config root/);
    const external = join(root, "not-a-candidate");
    await mkdir(external);
    await expect(assertManagedCandidateRoots(external, active, external)).rejects.toThrow(/managed candidate generation/);
  });

  it("rejects a candidate whose receipt belongs to another install", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "managed-marketplace-receipt-")));
    const active = join(root, "versions", "1.0.0");
    const stage = join(root, "versions", ".stage-managed-test");
    const roots: Array<[string, string]> = [[active, "install-a"], [stage, "install-b"]];
    for (const [version, id] of roots) {
      await mkdir(join(version, ".kb", "v2"), { recursive: true });
      await writeFile(join(version, ".kb", "v2", "receipt.json"), JSON.stringify({ installationId: id }));
    }
    await symlink(relative(root, active), join(root, "current"));
    await expect(assertManagedCandidateRoots(stage, active, stage)).rejects.toThrow(/does not belong to the active installation/);
  });
});
