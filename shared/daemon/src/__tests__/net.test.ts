import { describe, expect, it } from "vitest";
import { reserveLoopbackPorts } from "../net.js";

describe("reserveLoopbackPorts", () => {
  it("returns distinct free ports", async () => {
    const ports = await reserveLoopbackPorts(4);
    expect(new Set(ports).size).toBe(4);
    for (const port of ports) {
      expect(port).toBeGreaterThan(1023);
    }
  });
});
