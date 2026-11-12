import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BoundedFileSink,
  type BoundedFileSinkFs,
} from "./bounded-file-sink.js";

let dir: string;
beforeEach(() => {
  dir = nodeFs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "bfs-"));
});
afterEach(() => {
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

const dirBytes = () =>
  nodeFs
    .readdirSync(dir)
    .reduce((sum, name) => sum + nodeFs.statSync(path.join(dir, name)).size, 0);

describe("BoundedFileSink rotation", () => {
  it("keeps the total within maxFiles × maxFileBytes and the newest line", () => {
    const file = path.join(dir, "host.jsonl");
    const sink = new BoundedFileSink({
      path: file,
      maxFileBytes: 100,
      maxFiles: 3,
      report: (message) => {
        throw new Error(`unexpected report: ${message}`);
      },
    });
    const line = `${"x".repeat(36)}\n`;
    for (let index = 0; index < 500; index += 1) {
      sink.write(line);
    }
    sink.write("NEWEST\n");
    sink.close();
    expect(dirBytes()).toBeLessThanOrEqual(300);
    expect(nodeFs.readdirSync(dir).sort()).toEqual([
      "host.jsonl",
      "host.jsonl.1",
      "host.jsonl.2",
    ]);
    expect(nodeFs.readFileSync(file, "utf8")).toContain("NEWEST");
  });

  it("resumes appending to an existing file within the budget", () => {
    const file = path.join(dir, "host.jsonl");
    nodeFs.writeFileSync(file, "y".repeat(90));
    const sink = new BoundedFileSink({ path: file, maxFileBytes: 100, maxFiles: 2 });
    sink.write("z".repeat(20));
    sink.close();
    expect(nodeFs.readFileSync(`${file}.1`, "utf8")).toBe("y".repeat(90));
    expect(nodeFs.readFileSync(file, "utf8")).toBe("z".repeat(20));
  });
});

describe("BoundedFileSink failing disk", () => {
  // The sink takes the platform fs as a dependency; this one is a disk that
  // refuses writes the way a full one does until it is "freed".
  function fullDisk() {
    const state = { full: true, written: [] as string[] };
    const fs: BoundedFileSinkFs = {
      ...nodeFs,
      writeSync(fd, data) {
        if (state.full) {
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
            code: "ENOSPC",
          });
        }
        state.written.push(Buffer.from(data).toString());
        return data.length;
      },
    };
    return { state, fs };
  }

  it("does not throw, reports once per episode, and resumes when writes succeed", () => {
    const { state, fs } = fullDisk();
    const reports: string[] = [];
    const sink = new BoundedFileSink({
      path: path.join(dir, "host.jsonl"),
      fs,
      report: (message) => void reports.push(message),
    });
    for (let index = 0; index < 5; index += 1) {
      expect(() => sink.write(`lost ${index}\n`)).not.toThrow();
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("ENOSPC");
    expect(reports[0]).toContain("host.jsonl");

    state.full = false;
    sink.write("back\n");
    expect(state.written).toEqual(["back\n"]);

    state.full = true;
    sink.write("lost again\n");
    expect(reports).toHaveLength(2);
  });

  it("drops a record larger than the file budget instead of breaking it", () => {
    const reports: string[] = [];
    const sink = new BoundedFileSink({
      path: path.join(dir, "host.jsonl"),
      maxFileBytes: 10,
      report: (message) => void reports.push(message),
    });
    sink.write("a record that is far too long\n");
    expect(reports).toHaveLength(1);
    expect(dirBytes()).toBe(0);
  });
});

// Runs the built adapter, the artifact the host loads, so build before testing.
describe("PinoLoggerAdapter with KB_LOG_FILE", () => {
  it("logs to the file after the process's stdout/stderr readers are gone", async () => {
    const file = path.join(dir, "host.jsonl");
    const adapterUrl = new URL("../dist/index.js", import.meta.url).href;
    const script = `
      const { PinoLoggerAdapter } = await import(${JSON.stringify(adapterUrl)});
      const logger = new PinoLoggerAdapter({ level: "info" });
      process.stdin.setEncoding("utf8");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      logger.info("after launcher died", { marker: "pino-line" });
      console.log("stdout is not the log");
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: { ...process.env, KB_LOG_FILE: file, KB_LOG_LEVEL: "info" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout!.on("data", (chunk) => void (stdout += chunk));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // The launcher's pipe to the host's stdout/stderr is gone.
    child.stdout!.destroy();
    child.stderr!.destroy();
    child.stdin!.write("go\n");
    child.stdin!.end();
    await exited;
    const lines = nodeFs.readFileSync(file, "utf8").trim().split("\n");
    const record = JSON.parse(lines.at(-1)!);
    expect(record).toMatchObject({ msg: "after launcher died", marker: "pino-line" });
    expect(stdout).not.toContain("pino-line");
  }, 20_000);
});
