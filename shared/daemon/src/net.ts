import { createServer, type Server } from "node:net";

/** Loopback address that internal (machine-local) modules bind. */
export const LOOPBACK_HOST = "127.0.0.1";

interface LoopbackPortProbe {
  port: number;
  close(): Promise<void>;
}

type OpenLoopbackPortProbe = () => Promise<LoopbackPortProbe>;

const MAX_RESERVATION_BATCHES = 32;

function openLoopbackPortProbe(): Promise<LoopbackPortProbe> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a loopback port")));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}

async function closeProbes(probes: readonly LoopbackPortProbe[]): Promise<void> {
  await Promise.allSettled(probes.map((probe) => probe.close()));
}

/**
 * Selects loopback ports from live probes. The probe factory is injectable so
 * exclusion and cleanup behavior can be tested without relying on OS port
 * selection.
 */
export async function reserveLoopbackPortsWith(
  count: number,
  excludedPorts: readonly number[],
  openProbe: OpenLoopbackPortProbe,
): Promise<number[]> {
  if (count <= 0) {return [];}

  const usedPorts = new Set(excludedPorts);
  const accepted: LoopbackPortProbe[] = [];
  try {
    for (let batchNumber = 0; accepted.length < count; batchNumber += 1) {
      if (batchNumber >= MAX_RESERVATION_BATCHES) {
        throw new Error("Could not reserve enough distinct loopback ports");
      }

      const batch = await Promise.allSettled(
        Array.from({ length: count - accepted.length }, () => openProbe()),
      );
      const opened = batch.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const failure = batch.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) {
        await closeProbes(opened);
        throw failure.reason;
      }

      const excluded: LoopbackPortProbe[] = [];
      for (const probe of opened) {
        if (usedPorts.has(probe.port)) {
          excluded.push(probe);
        } else {
          usedPorts.add(probe.port);
          accepted.push(probe);
        }
      }
      await closeProbes(excluded);
    }

    return accepted.map((probe) => probe.port);
  } finally {
    await closeProbes(accepted);
  }
}

/**
 * Reserves `count` distinct free loopback TCP ports. All probe sockets are held
 * open until every port is known, then released before callers bind. An
 * unavoidable window remains between release and a caller's bind.
 */
export async function reserveLoopbackPorts(
  count: number,
  excludedPorts: readonly number[] = [],
): Promise<number[]> {
  return reserveLoopbackPortsWith(count, excludedPorts, openLoopbackPortProbe);
}
