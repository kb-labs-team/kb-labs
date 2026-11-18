import { describe, expect, it } from "vitest";
import { LOOPBACK_HOST } from "../net.js";

describe("loopback module bind host", () => {
  it("uses IPv4 loopback", () => {
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
  });
});
