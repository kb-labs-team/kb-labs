/**
 * @module @kb-labs/host-app/transport
 *
 * In-process service topology for modules the host runs itself.
 *
 * The host picks a loopback port for every internal module, builds the
 * `serviceTransport` services map from that, and installs it on the platform,
 * so nobody has to write `adapterOptions.serviceTransport.services` by hand.
 * A transport already configured (explicit routes in kb.config) stays
 * authoritative for the service ids it knows.
 */

import { createServer } from "node:net";
import { HttpServiceTransport } from "@kb-labs/adapters-service-transport-http";
import type {
  IServiceTransport,
  ServiceConnectionInfo,
  ServiceListenAddress,
  ServiceTransportRequest,
  ServiceTransportResponse,
  ServiceTransportStream,
} from "@kb-labs/core-platform";

export const INTERNAL_BIND_HOST = "127.0.0.1";

/**
 * Reserves `count` distinct free loopback TCP ports. All probe sockets are held
 * open until every port is known, so the same port is never handed out twice.
 * There is an unavoidable window between release and the module's own bind;
 * callers bind immediately after.
 */
export async function reserveLoopbackPorts(count: number): Promise<number[]> {
  const probes = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
          const probe = createServer();
          probe.once("error", reject);
          probe.listen(0, INTERNAL_BIND_HOST, () => resolve(probe));
        }),
    ),
  );
  const ports = probes.map((probe) => {
    const address = probe.address();
    if (address === null || typeof address === "string") {
      throw new Error("Could not reserve a loopback port");
    }
    return address.port;
  });
  await Promise.all(
    probes.map(
      (probe) =>
        new Promise<void>((resolve) => {
          probe.close(() => resolve());
        }),
    ),
  );
  return ports;
}

/** Builds the transport for the host-owned services: `serviceId -> loopback port`. */
export function createGeneratedTransport(
  ports: Readonly<Record<string, number>>,
): HttpServiceTransport {
  const services: Record<string, { url: string }> = {};
  for (const [serviceId, port] of Object.entries(ports)) {
    services[serviceId] = { url: `http://${INTERNAL_BIND_HOST}:${port}` };
  }
  // offset 0: these ports are already free ephemeral ports; the local network
  // shift applies to configured (well-known) ports only.
  return new HttpServiceTransport({ services, offset: 0 });
}

function hasDestroy(value: object): value is { destroy(): Promise<void> } {
  return "destroy" in value && typeof value.destroy === "function";
}

/**
 * Routes a service id to the explicitly configured transport when that knows
 * the id, otherwise to the generated one. Platform shutdown calls `close()`,
 * which releases both connection pools.
 */
export class HostServiceTransport implements IServiceTransport {
  constructor(
    private readonly generated: HttpServiceTransport,
    private readonly configured?: IServiceTransport,
  ) {}

  private pick(serviceId: string): IServiceTransport {
    if (this.configured?.connectionInfo(serviceId)) {
      return this.configured;
    }
    return this.generated;
  }

  connectionInfo(serviceId: string): ServiceConnectionInfo | undefined {
    return this.pick(serviceId).connectionInfo(serviceId);
  }

  listenAddress(serviceId: string): ServiceListenAddress | undefined {
    return this.pick(serviceId).listenAddress?.(serviceId);
  }

  call(
    serviceId: string,
    req: ServiceTransportRequest,
  ): Promise<ServiceTransportResponse> {
    return this.pick(serviceId).call(serviceId, req);
  }

  stream(
    serviceId: string,
    req: ServiceTransportRequest,
  ): Promise<ServiceTransportStream> {
    return this.pick(serviceId).stream(serviceId, req);
  }

  async close(): Promise<void> {
    await this.generated.destroy();
    if (this.configured && hasDestroy(this.configured)) {
      await this.configured.destroy();
    }
  }
}
