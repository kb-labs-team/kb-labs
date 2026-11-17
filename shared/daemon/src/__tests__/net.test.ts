import { describe, expect, it } from "vitest";
import { reserveLoopbackPorts, reserveLoopbackPortsWith } from "../net.js";

describe("reserveLoopbackPorts", () => {
  it("returns distinct free ports", async () => {
    const ports = await reserveLoopbackPorts(4);
    expect(new Set(ports).size).toBe(4);
    for (const port of ports) {
      expect(port).toBeGreaterThan(1023);
    }
  });

  it("does not return a caller-reserved port", async () => {
    const closed: number[] = [];
    const ports = [41000, 41001, 41002];
    const internalPorts = await reserveLoopbackPortsWith(
      2,
      [41000],
      async () => {
        const port = ports.shift();
        if (port === undefined) {throw new Error("No fake port left");}
        return {
          port,
          async close() {closed.push(port);},
        };
      },
    );

    expect(internalPorts).toEqual([41001, 41002]);
    expect(closed).toEqual([41000, 41001, 41002]);
  });

  it("closes successful probes when another probe fails", async () => {
    const closed: number[] = [];
    let nextPort = 42000;

    await expect(reserveLoopbackPortsWith(2, [], async () => {
      const port = nextPort++;
      if (port === 42001) {throw new Error("probe failed");}
      return {
        port,
        async close() {closed.push(port);},
      };
    })).rejects.toThrow("probe failed");

    expect(closed).toEqual([42000]);
  });

  it("stops after repeated excluded ports and closes held probes", async () => {
    const closed: number[] = [];
    await expect(reserveLoopbackPortsWith(1, [43000], async () => ({
      port: 43000,
      async close() {closed.push(43000);},
    }))).rejects.toThrow("Could not reserve enough distinct loopback ports");

    expect(closed).toHaveLength(32);
  });
});
