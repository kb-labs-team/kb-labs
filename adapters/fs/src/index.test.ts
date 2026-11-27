/**
 * @module @kb-labs/adapters-fs/__tests__
 * Unit tests for FilesystemStorageAdapter
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createAdapter } from "./index.js";
import { manifest } from "./manifest.js";
import { resolveRuntimeStatePath } from "@kb-labs/sdk/adapters";

describe("FilesystemStorageAdapter manifest", () => {
  it("declares storage as a built-in provider default", () => {
    expect(manifest.defaultFor).toEqual({ storage: [] });
  });
});

describe("FilesystemStorageAdapter", () => {
  let tmpDir: string;
  let storage: ReturnType<typeof createAdapter>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kb-test-fs-"));
    storage = createAdapter({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(`${tmpDir}-sibling`, { recursive: true, force: true });
  });

  it("stores default data under the platform state directory for an unregistered project", async () => {
    const previousCwd = process.cwd();
    const previousKbHome = process.env.KB_HOME;
    const kbHome = join(tmpDir, "platform-state");
    process.env.KB_HOME = kbHome;
    process.chdir(tmpDir);
    try {
      const defaultStorage = createAdapter();
      await defaultStorage.write("default-path.txt", Buffer.from("state"));

      const stateFile = resolveRuntimeStatePath(tmpDir, ["storage", "default-path.txt"], { root: kbHome });
      expect(existsSync(stateFile)).toBe(true);
      expect(await defaultStorage.read("default-path.txt")).toEqual(Buffer.from("state"));
      expect(existsSync(join(tmpDir, ".kb"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      if (previousKbHome === undefined) delete process.env.KB_HOME;
      else process.env.KB_HOME = previousKbHome;
    }
  });

  describe("Basic Operations", () => {
    it("should write and read a file", async () => {
      const content = Buffer.from("Hello, World!");

      await storage.write("test.txt", content);
      const result = await storage.read("test.txt");

      expect(result).toEqual(content);
      expect(result?.toString()).toBe("Hello, World!");
    });

    it("keeps the previous complete file when atomic replacement fails", async () => {
      await storage.write("registry/meta.json", Buffer.from('{"version":1}'));
      const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("simulated commit failure"));

      await expect(storage.write("registry/meta.json", Buffer.from('{"version":2}')))
        .rejects.toThrow("simulated commit failure");
      rename.mockRestore();

      expect(await storage.read("registry/meta.json")).toEqual(Buffer.from('{"version":1}'));
      expect(await fs.readdir(join(tmpDir, "registry"))).toEqual(["meta.json"]);
    });

    it("writes valid long filenames using a bounded temporary name", async () => {
      const filepath = `${"f".repeat(240)}.json`;
      const content = Buffer.from("complete");

      await storage.write(filepath, content);

      expect(await storage.read(filepath)).toEqual(content);
    });

    it("should return null when reading nonexistent file", async () => {
      const result = await storage.read("nonexistent.txt");

      expect(result).toBeNull();
    });

    it("should write file in nested directory", async () => {
      const content = Buffer.from("Nested content");

      await storage.write("docs/nested/file.txt", content);
      const result = await storage.read("docs/nested/file.txt");

      expect(result).toEqual(content);
    });

    it("should check if file exists", async () => {
      await storage.write("exists.txt", Buffer.from("test"));

      expect(await storage.exists("exists.txt")).toBe(true);
      expect(await storage.exists("nonexistent.txt")).toBe(false);
    });

    it("should delete a file", async () => {
      await storage.write("to-delete.txt", Buffer.from("test"));
      expect(await storage.exists("to-delete.txt")).toBe(true);

      await storage.delete("to-delete.txt");

      expect(await storage.exists("to-delete.txt")).toBe(false);
    });

    it("should not throw when deleting nonexistent file", async () => {
      await expect(storage.delete("nonexistent.txt")).resolves.not.toThrow();
    });
  });

  describe("List Operations", () => {
    it("should list files with prefix", async () => {
      await storage.write("docs/file1.txt", Buffer.from("1"));
      await storage.write("docs/file2.txt", Buffer.from("2"));
      await storage.write("other/file3.txt", Buffer.from("3"));

      const files = await storage.list("docs/");

      expect(files).toHaveLength(2);
      expect(files).toContain("docs/file1.txt");
      expect(files).toContain("docs/file2.txt");
    });

    it("should return empty array when no files match prefix", async () => {
      const files = await storage.list("nonexistent/");

      expect(files).toEqual([]);
    });
  });

  describe("Security", () => {
    it("should prevent directory traversal attacks", async () => {
      await expect(
        storage.write("../outside.txt", Buffer.from("bad")),
      ).rejects.toThrow("Path traversal detected");
    });

    it("should prevent absolute path escaping baseDir", async () => {
      await expect(
        storage.write("/etc/passwd", Buffer.from("bad")),
      ).rejects.toThrow("Path traversal detected");
    });

    it("should prevent absolute sibling paths that only share the baseDir prefix", async () => {
      const siblingFile = join(`${tmpDir}-sibling`, "outside.txt");

      await expect(
        storage.write(siblingFile, Buffer.from("bad")),
      ).rejects.toThrow("Path traversal detected");
      await expect(access(siblingFile)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("Extended Methods - stat()", () => {
    it("should return file metadata", async () => {
      const content = Buffer.from("Test content");
      await storage.write("test.txt", content);

      const metadata = await storage.stat("test.txt");

      expect(metadata).not.toBeNull();
      expect(metadata?.path).toBe("test.txt");
      expect(metadata?.size).toBe(content.length);
      expect(metadata?.contentType).toBe("text/plain");
      expect(metadata?.lastModified).toBeDefined();
    });

    it("should return null for nonexistent file", async () => {
      const metadata = await storage.stat("nonexistent.txt");

      expect(metadata).toBeNull();
    });

    it("should detect content types correctly", async () => {
      await storage.write("test.json", Buffer.from("{}"));
      await storage.write("test.md", Buffer.from("# Title"));
      await storage.write("test.png", Buffer.from("fake-png"));

      expect((await storage.stat("test.json"))?.contentType).toBe(
        "application/json",
      );
      expect((await storage.stat("test.md"))?.contentType).toBe(
        "text/markdown",
      );
      expect((await storage.stat("test.png"))?.contentType).toBe("image/png");
    });

    it("should return octet-stream for unknown extensions", async () => {
      await storage.write("test.unknown", Buffer.from("data"));

      const metadata = await storage.stat("test.unknown");

      expect(metadata?.contentType).toBe("application/octet-stream");
    });
  });

  describe("Extended Methods - copy()", () => {
    it("should copy file", async () => {
      const content = Buffer.from("Original content");
      await storage.write("source.txt", content);

      await storage.copy("source.txt", "destination.txt");

      const sourceStat = await storage.stat("source.txt");
      const destStat = await storage.stat("destination.txt");

      expect(sourceStat).not.toBeNull();
      expect(destStat).not.toBeNull();
      expect(destStat?.size).toBe(sourceStat?.size);

      const destContent = await storage.read("destination.txt");
      expect(destContent).toEqual(content);
    });

    it("should copy to nested directory", async () => {
      await storage.write("source.txt", Buffer.from("test"));

      await storage.copy("source.txt", "nested/dir/copy.txt");

      expect(await storage.exists("nested/dir/copy.txt")).toBe(true);
    });
  });

  describe("Extended Methods - move()", () => {
    it("should move file", async () => {
      const content = Buffer.from("Content to move");
      await storage.write("source.txt", content);

      await storage.move("source.txt", "destination.txt");

      expect(await storage.exists("source.txt")).toBe(false);
      expect(await storage.exists("destination.txt")).toBe(true);

      const movedContent = await storage.read("destination.txt");
      expect(movedContent).toEqual(content);
    });

    it("should move to nested directory", async () => {
      await storage.write("source.txt", Buffer.from("test"));

      await storage.move("source.txt", "nested/dir/moved.txt");

      expect(await storage.exists("source.txt")).toBe(false);
      expect(await storage.exists("nested/dir/moved.txt")).toBe(true);
    });

    it("should overwrite existing file when moving", async () => {
      await storage.write("source.txt", Buffer.from("new content"));
      await storage.write("destination.txt", Buffer.from("old content"));

      await storage.move("source.txt", "destination.txt");

      const content = await storage.read("destination.txt");
      expect(content?.toString()).toBe("new content");
    });
  });

  describe("Extended Methods - listWithMetadata()", () => {
    it("should list files with metadata", async () => {
      await storage.write("docs/file1.txt", Buffer.from("content1"));
      await storage.write("docs/file2.md", Buffer.from("content2"));

      const files = await storage.listWithMetadata("docs/");

      expect(files).toHaveLength(2);
      expect(files[0]!.path).toBeDefined();
      expect(files[0]!.size).toBeGreaterThan(0);
      expect(files[0]!.lastModified).toBeDefined();
      expect(files[0]!.contentType).toBeDefined();
    });

    it("should return empty array when no files match", async () => {
      const files = await storage.listWithMetadata("nonexistent/");

      expect(files).toEqual([]);
    });

    it("should include correct content types", async () => {
      await storage.write("docs/file.json", Buffer.from("{}"));
      await storage.write("docs/file.txt", Buffer.from("text"));

      const files = await storage.listWithMetadata("docs/");

      const jsonFile = files.find((f) => f.path.endsWith(".json"));
      const txtFile = files.find((f) => f.path.endsWith(".txt"));

      expect(jsonFile?.contentType).toBe("application/json");
      expect(txtFile?.contentType).toBe("text/plain");
    });
  });
});
