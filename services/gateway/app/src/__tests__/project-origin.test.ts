import { describe, expect, it } from "vitest";
import { isTrustedGatewayOrigin } from "../project-origin.js";

describe("isTrustedGatewayOrigin", () => {
  it("trusts the exact operator-configured public origin, including a custom port", () => {
    expect(isTrustedGatewayOrigin({
      origin: "https://studio.example.test:8443",
      host: "studio.example.test:8443",
      peerAddress: "10.0.0.12",
      localPort: 4000,
    }, {
      publicUrl: "https://studio.example.test:8443",
      authEnabled: true,
    })).toBe(true);
  });

  it("does not trust a different origin, including one with a different port", () => {
    expect(isTrustedGatewayOrigin({
      origin: "https://studio.example.test:8444",
      host: "gateway.internal:4000",
      peerAddress: "10.0.0.12",
      localPort: 4000,
    }, {
      publicUrl: "https://studio.example.test:8443",
      authEnabled: true,
    })).toBe(false);
  });

  it("does not trust the configured Origin when the raw Host names another public authority", () => {
    expect(isTrustedGatewayOrigin({
      origin: "https://studio.example.test:8443",
      host: "tenant.example.test:8443",
      peerAddress: "10.0.0.12",
      localPort: 4000,
    }, {
      publicUrl: "https://studio.example.test:8443",
      authEnabled: true,
    })).toBe(false);
  });

  it("requires the configured nondefault port in the raw Host authority", () => {
    expect(isTrustedGatewayOrigin({
      origin: "https://studio.example.test:8443",
      host: "studio.example.test",
      peerAddress: "10.0.0.12",
      localPort: 4000,
    }, {
      publicUrl: "https://studio.example.test:8443",
      authEnabled: true,
    })).toBe(false);
  });

  it("does not trust null or cross-origin values", () => {
    const options = { publicUrl: "https://studio.example.test:8443", authEnabled: true };
    expect(isTrustedGatewayOrigin({
      origin: "null",
      host: "gateway.internal:4000",
      peerAddress: "10.0.0.12",
      localPort: 4000,
    }, options)).toBe(false);
    expect(isTrustedGatewayOrigin({
      origin: "http://attacker.example:4000",
      host: "attacker.example:4000",
      peerAddress: "10.0.0.12",
      localPort: 4000,
    }, options)).toBe(false);
  });

  it("does not let the public URL expand trust in local unauthenticated mode", () => {
    expect(isTrustedGatewayOrigin({
      origin: "https://studio.example.test:8443",
      host: "studio.example.test:8443",
      peerAddress: "127.0.0.1",
      localPort: 4000,
    }, {
      publicUrl: "https://studio.example.test:8443",
      authEnabled: false,
    })).toBe(false);
  });

  it.each([
    { host: "localhost:4000", peerAddress: "127.0.0.1", origin: "http://localhost:4000" },
    { host: "127.0.0.1:4000", peerAddress: "::1", origin: "http://127.0.0.1:4000" },
    { host: "[::1]:4000", peerAddress: "127.0.0.1", origin: "http://[::1]:4000" },
  ])("trusts a matching direct loopback request ($host)", ({ host, peerAddress, origin }) => {
    expect(isTrustedGatewayOrigin({ origin, host, peerAddress, localPort: 4000 }, {
      authEnabled: false,
    })).toBe(true);
  });

  it.each([
    { host: "localhost:4001", peerAddress: "127.0.0.1", localPort: 4000, origin: "http://localhost:4001" },
    { host: "localhost:4000", peerAddress: "10.0.0.12", localPort: 4000, origin: "http://localhost:4000" },
    { host: "attacker.example:4000", peerAddress: "127.0.0.1", localPort: 4000, origin: "http://attacker.example:4000" },
  ])("does not trust an unmatched or non-loopback direct request ($host, $peerAddress)", ({ host, peerAddress, localPort, origin }) => {
    expect(isTrustedGatewayOrigin({ origin, host, peerAddress, localPort }, {
      authEnabled: false,
    })).toBe(false);
  });

  it("leaves originless CLI requests outside the browser-origin suppression path", () => {
    expect(isTrustedGatewayOrigin({
      host: "localhost:4000",
      peerAddress: "127.0.0.1",
      localPort: 4000,
    }, {
      publicUrl: "http://localhost:4000",
      authEnabled: false,
    })).toBe(false);
  });

  it("rejects malformed public URL configuration", () => {
    expect(isTrustedGatewayOrigin({
      origin: "https://studio.example.test",
      host: "gateway.internal:4000",
      peerAddress: "10.0.0.12",
      localPort: 4000,
    }, {
      publicUrl: "https://user:password@studio.example.test/path",
      authEnabled: true,
    })).toBe(false);
  });
});
