// A stand-in for `kb-project-runtime` that speaks the same wire contract
// (args, KB_PROJECT_RUNTIME_TOKEN, x-kb-runtime-token, /__runtime/health,
// /<module>/<path> forwarding) without launching a platform. Behavior is
// driven by `fake-runtime.json` in the project root so each test project can
// misbehave differently.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function arg(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const projectRoot = arg("--project-root");
const projectId = arg("--project-id");
const [host, portText] = arg("--listen").split(":");
const token = process.env.KB_PROJECT_RUNTIME_TOKEN;

let behavior = {};
try {
  behavior = JSON.parse(readFileSync(join(projectRoot, "fake-runtime.json"), "utf8"));
} catch {
  // default behavior
}

if (behavior.exitBeforeReady !== undefined) {
  process.stderr.write("fake runtime: refusing to start\n");
  process.exit(behavior.exitBeforeReady);
}

const startedAt = Date.now();

const server = createServer((req, res) => {
  if (req.headers["x-kb-runtime-token"] !== token) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }
  const url = new URL(req.url, "http://runtime.invalid");
  if (url.pathname === "/__runtime/health") {
    if (behavior.unhealthyAfterMs !== undefined && Date.now() - startedAt > behavior.unhealthyAfterMs) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "degraded", modules: behavior.healthModules ?? {} }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", projectId, projectRoot, pid: process.pid }));
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (url.pathname === "/rest/api/v1/__host-services") {
      const stateDaemonUrl = process.env.KB_STATE_DAEMON_URL;
      const gatewayUrl = process.env.KB_GATEWAY_URL;
      const firstLeaseStatus = stateDaemonUrl
        ? (await fetch(`${stateDaemonUrl}/state/${encodeURIComponent("kb:integration-lease-probe")}`)).status
        : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stateDaemonUrl: stateDaemonUrl ?? null, gatewayUrl: gatewayUrl ?? null, firstLeaseStatus }));
      return;
    }
    if (url.pathname === "/rest/api/v1/__crash") {
      process.exit(1);
    }
    if (url.pathname === "/rest/api/v1/__spawn-child") {
      const stoppedMarker = join(projectRoot, "runtime-child-stopped");
      const child = spawn(process.execPath, ["-e", [
        "const { writeFileSync } = require('node:fs');",
        "const marker = process.argv[1];",
        "process.on('SIGTERM', () => { writeFileSync(marker, 'stopped'); process.exit(0); });",
        "process.stdout.write('ready');",
        "setInterval(() => {}, 1000);",
      ].join(" "), stoppedMarker], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout.once("data", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ childPid: child.pid }));
      });
      return;
    }
    const delayMs = Number(url.searchParams.get("delay") ?? 0);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json", "x-fake-runtime": String(process.pid) });
      res.end(
        JSON.stringify({
          projectId,
          projectRoot,
          pid: process.pid,
          method: req.method,
          path: url.pathname,
          search: url.search,
          body,
          received: {
            tokenHeader: req.headers["x-kb-runtime-token"] ?? null,
            projectHeader: req.headers["x-kb-project-id"] ?? null,
            authorization: req.headers.authorization ?? null,
          },
        }),
      );
    }, delayMs);
  });
});

const startDelay = behavior.startDelayMs ?? 0;
setTimeout(() => {
  server.listen(Number(portText), host, () => {
    const address = server.address();
    process.send?.({
      type: "kb-project-runtime-ready",
      address: { host, port: address.port },
    });
  });
}, startDelay);

// Never outlive the test process, even if it dies without cleaning up.
const parentPid = Number(arg("--parent-pid"));
if (parentPid) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 1000).unref();
}

process.on("SIGTERM", () => {
  if (behavior.ignoreSigterm) {
    return;
  }
  server.close();
  server.closeAllConnections();
  process.exit(0);
});
