import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("managed Marketplace helper with an installed-shaped candidate", () => {
  it("runs the installed helper child to install a real adapter with the receipt-pinned shared cache", async () => {
    const installRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "managed-marketplace-child-")));
    const active = path.join(installRoot, "versions", "1.0.0");
    const candidate = path.join(installRoot, "versions", ".stage-managed-integration");
    const cacheRoot = path.join(installRoot, "state", "cache");
    const home = path.join(installRoot, "test-home");
    const packageId = "@kb-labs/integration-adapter";
    const sealedId = "@kb-labs/sealed-fixture";
    const packageFiles = new Map<string, { archive: Buffer; integrity: string }>();
    let registryUrl = "";
    const server = createServer(async (request, response) => {
      const requestPath = decodeURIComponent(new URL(request.url ?? "/", `http://${request.headers.host}`).pathname.slice(1));
      const isTarball = requestPath.includes("/-/");
      const name = isTarball ? requestPath.slice(0, requestPath.indexOf("/-/")) : requestPath;
      const published = packageFiles.get(name);
      if (!published) { response.writeHead(404).end("not found"); return; }
      if (isTarball) { response.writeHead(200, { "content-type": "application/octet-stream" }).end(published.archive); return; }
      const fileName = name.split("/").at(-1);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        name,
        "dist-tags": { latest: "1.0.0" },
        time: { "1.0.0": new Date().toISOString() },
        versions: { "1.0.0": {
          name, version: "1.0.0", kb: { adapter: { manifest: "./manifest.mjs" } }, dependencies: {},
          dist: { integrity: published.integrity, tarball: `${registryUrl}/${encodeURIComponent(name)}/-/${fileName}-1.0.0.tgz` },
        } },
      }));
    });

    async function publish(name: string): Promise<void> {
      const packageRoot = path.join(installRoot, "published", name.replaceAll("/", "__"), "package");
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name, version: "1.0.0", type: "module", kb: { adapter: { manifest: "./manifest.mjs" } },
      }));
      await fs.writeFile(path.join(packageRoot, "manifest.mjs"), `export const manifest = ${JSON.stringify({
        schema: "kb.adapter/1", manifestVersion: "1.0.0", id: name, name, version: "1.0.0",
        type: "extension", implements: "IAdapterFixture", networkRequired: false,
      })};`);
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export { manifest } from '../manifest.mjs';\n");
      const archivePath = path.join(installRoot, "published", `${name.replaceAll("/", "__")}.tgz`);
      execFileSync("tar", ["-czf", archivePath, "-C", path.dirname(packageRoot), "package"]);
      const archive = await fs.readFile(archivePath);
      packageFiles.set(name, { archive, integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}` });
    }

    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture registry did not bind");
      registryUrl = `http://127.0.0.1:${address.port}`;
      await publish(packageId);
      await publish(sealedId);

      for (const root of [active, candidate]) {
        await fs.mkdir(path.join(root, ".kb", "v2"), { recursive: true });
        await fs.writeFile(path.join(root, ".kb", "v2", "receipt.json"), JSON.stringify({ installationId: "fixture-installation" }));
      }
      await fs.symlink(path.relative(installRoot, active), path.join(installRoot, "current"));
      await fs.mkdir(path.join(active, ".kb"), { recursive: true });
      await fs.writeFile(path.join(active, ".kb", "kb.config.jsonc"), JSON.stringify({ marketplace: { sources: [{ kind: "npm", url: registryUrl }] } }));
      await fs.mkdir(path.join(cacheRoot, "packages"), { recursive: true });
      const sealed = packageFiles.get(sealedId)!;
      const sealedDigest = createHash("sha256").update(sealed.archive).digest("hex");
      await fs.writeFile(path.join(cacheRoot, "packages", `${sealedDigest}.tgz`), sealed.archive);
      const receipt = { installationId: "fixture-installation", plan: { artifacts: [{ package: sealedId, sha256: sealedDigest, tarball: "registry/sealed-fixture.tgz", kind: "sdk" }] } };
      await fs.writeFile(path.join(candidate, ".kb", "v2", "receipt.json"), JSON.stringify(receipt));
      await fs.writeFile(path.join(candidate, "package.json"), JSON.stringify({
        name: "kb-platform", version: "1.0.0", packageManager: "pnpm@11.4.0", dependencies: { [sealedId]: "1.0.0" },
      }));
      await fs.writeFile(path.join(candidate, "pnpm-workspace.yaml"), [
        "minimumReleaseAge: 10080", "minimumReleaseAgeExclude: []", "overrides:",
        `  "${sealedId}": "file:${path.join(cacheRoot, "packages", `${sealedDigest}.tgz`).replaceAll("\\", "/")}"`, "",
      ].join("\n"));

      const corepackHome = process.env.COREPACK_HOME ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "node", "corepack");
      const pnpmScript = path.join(corepackHome, "v1", "pnpm", "11.4.0", "bin", "pnpm.cjs");
      await fs.access(pnpmScript);
      const binDirectory = path.join(installRoot, "pm-bin");
      await fs.mkdir(binDirectory);
      await fs.writeFile(path.join(binDirectory, "pnpm"), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${pnpmScript.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
      await fs.mkdir(path.join(home, "store"), { recursive: true });
      const request = { mutation: { operation: "install", specs: [`${packageId}@1.0.0`] }, environment: {} };
      const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
      await fs.access(helperPath);
      const helperEnv = {
        PATH: `${binDirectory}:${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        HOME: home,
        COREPACK_HOME: corepackHome,
        npm_config_registry: registryUrl,
        npm_config_store_dir: path.join(home, "store"),
        KB_PLATFORM_ROOT: candidate,
        KB_MARKETPLACE_CONFIG_ROOT: active,
        KB_MANAGED_ARTIFACT_CACHE_ROOT: cacheRoot,
        KB_HOME: home,
      };
      const child = spawn(process.execPath, [helperPath, "--managed-generation-mutation"], { cwd: candidate, env: helperEnv, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
      const exit = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error(`installed Marketplace helper exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`)));
      });
      child.stdin.end(JSON.stringify(request));
      const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try { await exit; } finally { clearTimeout(timeout); }

      const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { schema: number; operation: string; installed: Array<{ packageId: string; version: string; primaryKind: string }> };
      expect(result).toMatchObject({ schema: 1, operation: "install", installed: [{ packageId, version: "1.0.0", primaryKind: "adapter" }] });
      const lock = JSON.parse(await fs.readFile(path.join(candidate, ".kb", "marketplace.lock"), "utf8")) as { adapters: Record<string, { source?: string; enabled?: boolean }> };
      expect(lock.adapters[packageId]).toMatchObject({ source: "marketplace", enabled: true });
      expect(await fs.lstat(path.join(candidate, ".kb", "v2", "cache")).catch(error => ({ code: (error as NodeJS.ErrnoException).code }))).toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await fs.rm(installRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
