import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { ActiveWorkItem, ActiveWorkRegistry } from "@kb-labs/shared-daemon";
import type { ProjectRuntimeManager } from "./project-runtime/manager.js";

export const HOST_ACTIVE_WORK_ADDRESS_HEADER = "x-kb-host-active-work-address";

export interface HostActiveWorkControl {
  address: string;
  close(): Promise<void>;
}

function credentialMatches(expected: string, received: string | undefined): boolean {
  if (!received) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const receivedDigest = createHash("sha256").update(received).digest();
  return timingSafeEqual(expectedDigest, receivedDigest);
}

export async function startHostActiveWorkControl(
  credential: string,
  providers: ActiveWorkRegistry,
  projectRuntimes: ProjectRuntimeManager,
): Promise<HostActiveWorkControl> {
  if (credential.length < 32) throw new Error("Host active-work control credential is missing or too short.");
  const server: Server = createServer((request, response) => {
    if (!credentialMatches(credential, request.headers.authorization?.replace(/^Bearer /, ""))) {
      response.writeHead(403).end();
      request.resume();
      return;
    }
    if (request.method !== "GET" || request.url !== "/v1/active-work") {
      response.writeHead(404).end();
      request.resume();
      return;
    }
    void Promise.all([providers.list(), projectRuntimes.listActiveWork()]).then(([local, project]): void => {
      const items: ActiveWorkItem[] = [...local, ...project].sort((left, right) =>
        left.owningService.localeCompare(right.owningService) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
      const body = JSON.stringify(items);
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
    }, (): void => {
      response.writeHead(503).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Host active-work control endpoint did not bind a TCP address.");
  return {
    address: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
