import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { ActiveWorkItem, ActiveWorkRegistry } from "@kb-labs/shared-daemon";
import type { ProjectRuntimeManager } from "./project-runtime/manager.js";
import type { MarketplaceClient, ReconcileMarketplaceRequest } from "./marketplace-client.js";
import { MarketplaceClientError } from "./marketplace-client.js";
import { createErrorEnvelope } from "@kb-labs/core-platform/error-envelope";

export const HOST_ACTIVE_WORK_ADDRESS_HEADER = "x-kb-host-active-work-address";

export interface HostActiveWorkControl {
  address: string;
  close(): Promise<void>;
}

export interface MarketplaceReconciliationRequest extends ReconcileMarketplaceRequest {
  installationId: string;
}

function credentialMatches(expected: string, received: string | undefined): boolean {
  if (!received) {return false;}
  const expectedDigest = createHash("sha256").update(expected).digest();
  const receivedDigest = createHash("sha256").update(received).digest();
  return timingSafeEqual(expectedDigest, receivedDigest);
}

export async function startHostActiveWorkControl(
  credential: string,
  providers: ActiveWorkRegistry,
  projectRuntimes: ProjectRuntimeManager,
  installationId?: string,
  marketplace?: MarketplaceClient,
): Promise<HostActiveWorkControl> {
  if (credential.length < 32) {throw new Error("Host active-work control credential is missing or too short.");}
  const server: Server = createServer((request, response) => {
    if (!credentialMatches(credential, request.headers.authorization?.replace(/^Bearer /, ""))) {
      response.writeHead(403).end();
      request.resume();
      return;
    }
    if (request.method === "POST" && request.url === "/v1/marketplace/reconcile") {
      if (!installationId || !marketplace) {
        response.writeHead(503).end();
        request.resume();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 1_048_576) {
          response.writeHead(413).end();
          request.destroy();
        }
      });
      request.on("end", () => {
        void (async () => {
          let input: MarketplaceReconciliationRequest | undefined;
          try {
            input = JSON.parse(body) as MarketplaceReconciliationRequest;
            if (input.installationId !== installationId || input.scope !== "platform" || !Array.isArray(input.expected) || input.expected.length === 0) {
              response.writeHead(409).end();
              return;
            }
            const matched = await marketplace.reconcileMarketplace({ scope: input.scope, expected: input.expected });
            const output = JSON.stringify({ ok: true, installationId, ...(matched as object) });
            response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(output) });
            response.end(output);
          } catch (error) {
            const drift = error instanceof MarketplaceClientError && error.status === 409;
            const details = {
              package: input?.expected?.[0]?.id ?? "unknown",
              scope: "platform",
            };
            const envelope = drift
              ? createErrorEnvelope("KB_MARKETPLACE_STATE_DRIFT", {
                details,
                templateValues: {
                  loginCommand: "kb auth login --gateway-url <gateway-url>",
                  installCommand: `kb marketplace install ${input?.expected?.[0]?.spec ?? "<package-spec>"} --scope platform`,
                },
                hint: "Sign in to the installed Gateway and reinstall the requested scenario package in platform scope.",
              })
              : createErrorEnvelope("KB_MARKETPLACE_STATE_UNAVAILABLE", {
                details,
                templateValues: {
                  startCommand: "kb-create start --platform-root <platform-root>",
                  statusCommand: "kb-create status --platform-root <platform-root>",
                },
                hint: "Check that the installed host is running and its Marketplace service is available, then retry.",
              });
            const output = JSON.stringify({ ok: false, error: envelope });
            response.writeHead(drift ? 409 : 503, { "content-type": "application/json", "content-length": Buffer.byteLength(output) });
            response.end(output);
          }
        })();
      });
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
  if (!address || typeof address === "string") {throw new Error("Host active-work control endpoint did not bind a TCP address.");}
  return {
    address: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    }),
  };
}
