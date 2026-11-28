import { describe, expect, it } from "vitest";
import { redactHttpUrl } from "../redact-http-url.js";

describe("redactHttpUrl", () => {
  it("preserves URLs without credentials", () => {
    expect(redactHttpUrl("/plugins/release/status")).toBe("/plugins/release/status");
    expect(redactHttpUrl("/plugins/release/status#details")).toBe(
      "/plugins/release/status#details",
    );
    expect(redactHttpUrl("/plugins?view=compact#details")).toBe(
      "/plugins?view=compact#details",
    );
    expect(redactHttpUrl("/plugins?view=compact#details&token=secret")).toBe(
      "/plugins?view=compact#details&token=[REDACTED]",
    );
  });

  it("redacts case-insensitive credentials while preserving ordinary query values", () => {
    expect(redactHttpUrl("/plugins?TOKEN=secret&view=full")).toBe(
      "/plugins?TOKEN=[REDACTED]&view=full",
    );
  });

  it("redacts percent-encoded credential keys", () => {
    expect(redactHttpUrl("/events?share%5Ftoken=secret&cursor=next")).toBe(
      "/events?share%5Ftoken=[REDACTED]&cursor=next",
    );
  });

  it("keeps query flags without values unchanged", () => {
    expect(redactHttpUrl("/plugins?enabled&view=compact")).toBe(
      "/plugins?enabled&view=compact",
    );
  });

  it("does not throw on a malformed percent-encoded key", () => {
    expect(redactHttpUrl("/plugins?%ZZ=value&token=secret")).toBe(
      "/plugins?%ZZ=value&token=[REDACTED]",
    );
  });

  it("redacts credentials in a fragment-only URL", () => {
    expect(redactHttpUrl("/events#access_token=secret&cursor=next")).toBe(
      "/events#access_token=[REDACTED]&cursor=next",
    );
  });
});
