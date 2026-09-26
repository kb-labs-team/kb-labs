import { createServer, type Server } from "node:net";

/** Loopback address that internal (machine-local) modules bind. */
export const LOOPBACK_HOST = "127.0.0.1";

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
        new Promise<Server>((resolve, reject) => {
          const probe = createServer();
          probe.once("error", reject);
          probe.listen(0, LOOPBACK_HOST, () => resolve(probe));
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
