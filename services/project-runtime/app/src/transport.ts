/**
 * @module @kb-labs/project-runtime-app/transport
 *
 * The runtime's in-process service topology. The runtime picks loopback ports
 * for its own modules, so the addresses a module binds and the addresses other
 * modules of the same project route to always agree, and never collide with
 * another project's runtime.
 *
 * Unlike the host, the generated map is authoritative for the ids it knows:
 * a project's `adapterOptions.serviceTransport` may still carry hand-written
 * `rest`/`workflow` ports from the one-process-per-service days, and honoring
 * them would make two projects fight for the same port. Ids the runtime does
 * not own (marketplace, state) fall through to the configured transport.
 */

import type { HttpServiceTransport } from "@kb-labs/adapters-service-transport-http";
import type {
  IServiceTransport,
  ServiceConnectionInfo,
  ServiceListenAddress,
  ServiceTransportRequest,
  ServiceTransportResponse,
  ServiceTransportStream,
} from "@kb-labs/core-platform";

function hasDestroy(value: object): value is { destroy(): Promise<void> } {
  return "destroy" in value && typeof value.destroy === "function";
}

export class RuntimeServiceTransport implements IServiceTransport {
  constructor(
    private readonly generated: HttpServiceTransport,
    private readonly configured?: IServiceTransport,
  ) {}

  private pick(serviceId: string): IServiceTransport {
    if (this.generated.connectionInfo(serviceId) || !this.configured) {
      return this.generated;
    }
    return this.configured;
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
