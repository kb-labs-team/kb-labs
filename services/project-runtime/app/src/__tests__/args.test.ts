import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeProjectPath,
  deriveProjectId,
} from "@kb-labs/core-project-registry";
import {
  parseListen,
  parseRuntimeArgs,
  RuntimeArgsError,
} from "../args.js";
import { RUNTIME_TOKEN_ENV } from "../protocol.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("parseListen", () => {
  it("accepts loopback host:port", () => {
    expect(parseListen("127.0.0.1:4711")).toEqual({ host: "127.0.0.1", port: 4711 });
    expect(parseListen("localhost:4711")).toEqual({ host: "localhost", port: 4711 });
    expect(parseListen("[::1]:4711")).toEqual({ host: "::1", port: 4711 });
  });

  it("refuses anything that would expose the runtime", () => {
    expect(() => parseListen("0.0.0.0:4711")).toThrow(RuntimeArgsError);
    expect(() => parseListen("192.168.1.10:4711")).toThrow(/loopback only/);
  });

  it("refuses malformed values", () => {
    expect(() => parseListen("4711")).toThrow(RuntimeArgsError);
    expect(() => parseListen("127.0.0.1:0")).toThrow(/invalid port/);
    expect(() => parseListen("127.0.0.1:99999")).toThrow(/invalid port/);
  });
});

describe("parseRuntimeArgs", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function project(): Promise<{ root: string; id: string }> {
    dir = await mkdtemp(join(tmpdir(), "kb-runtime-args-"));
    const root = await canonicalizeProjectPath(dir);
    return { root, id: deriveProjectId(root) };
  }

  it("parses a complete command line", async () => {
    const { root, id } = await project();

    const args = await parseRuntimeArgs(
      [
        "--project-root", root,
        `--project-id=${id}`,
        "--listen", "127.0.0.1:5123",
        "--parent-pid", "4242",
      ],
      { [RUNTIME_TOKEN_ENV]: TOKEN },
    );

    expect(args).toEqual({
      projectRoot: root,
      projectId: id,
      listen: { host: "127.0.0.1", port: 5123 },
      token: TOKEN,
      parentPid: 4242,
    });
  });

  it("resolves a symlinked or differently spelled root to the canonical one", async () => {
    const { root, id } = await project();

    const args = await parseRuntimeArgs(
      ["--project-root", `${root}/`, "--project-id", id, "--listen", "127.0.0.1:5123"],
      { [RUNTIME_TOKEN_ENV]: TOKEN },
    );

    expect(args.projectRoot).toBe(root);
  });

  it("refuses a project id that does not belong to the root", async () => {
    const { root } = await project();

    await expect(
      parseRuntimeArgs(
        ["--project-root", root, "--project-id", "prj_0000000000000000", "--listen", "127.0.0.1:5123"],
        { [RUNTIME_TOKEN_ENV]: TOKEN },
      ),
    ).rejects.toThrow(/does not match the project root/);
  });

  it("requires an absolute existing directory", async () => {
    const { root, id } = await project();
    const base = ["--project-id", id, "--listen", "127.0.0.1:5123"];
    const env = { [RUNTIME_TOKEN_ENV]: TOKEN };

    await expect(
      parseRuntimeArgs(["--project-root", "relative/dir", ...base], env),
    ).rejects.toThrow(/absolute path/);
    await writeFile(join(root, "file.txt"), "x");
    await expect(
      parseRuntimeArgs(["--project-root", join(root, "file.txt"), ...base], env),
    ).rejects.toThrow(/not a directory/);
    await expect(
      parseRuntimeArgs(["--project-root", join(root, "missing"), ...base], env),
    ).rejects.toThrow(/not a directory/);
  });

  it("requires the secret in the environment, and a long enough one", async () => {
    const { root, id } = await project();
    const argv = ["--project-root", root, "--project-id", id, "--listen", "127.0.0.1:5123"];

    await expect(parseRuntimeArgs(argv, {})).rejects.toThrow(RUNTIME_TOKEN_ENV);
    await expect(
      parseRuntimeArgs(argv, { [RUNTIME_TOKEN_ENV]: "short" }),
    ).rejects.toThrow(/at least 16/);
  });

  it("names the missing flag", async () => {
    await expect(parseRuntimeArgs([], { [RUNTIME_TOKEN_ENV]: TOKEN })).rejects.toThrow(
      "--project-root is required",
    );
  });
});
