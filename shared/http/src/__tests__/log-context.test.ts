import { expect, it } from "vitest";
import type { ILogger } from "@kb-labs/core-platform";
import { createHttpLogger } from "../log-context.js";

it("writes canonical HTTP fields and preserves request correlation", () => {
  const records: Array<Record<string, unknown>> = [];
  const base: ILogger = {
    trace: (_message, meta) => records.push(meta ?? {}),
    debug: (_message, meta) => records.push(meta ?? {}),
    info: (_message, meta) => records.push(meta ?? {}),
    warn: (_message, meta) => records.push(meta ?? {}),
    error: (_message, _error, meta) => records.push(meta ?? {}),
    fatal: (_message, _error, meta) => records.push(meta ?? {}),
    flush: async () => {},
    child: () => base,
  };

  createHttpLogger(base, {
    serviceId: "gateway",
    requestId: "request-1",
    traceId: "trace-1",
    method: "get",
    url: "/api/v1/plugins/release/status?token=ignored",
  })
    .child({ requestId: "override" })
    .info("HTTP request completed");

  expect(records[0]).toMatchObject({
    serviceId: "gateway",
    requestId: "request-1",
    traceId: "trace-1",
    "http.method": "GET",
    "http.route": "/api/v1/plugins/release/status",
  });
});

it("omits URL attributes when the request URL is unavailable", () => {
  const records: Array<Record<string, unknown>> = [];
  const base: ILogger = {
    trace: (_message, meta) => records.push(meta ?? {}),
    debug: (_message, meta) => records.push(meta ?? {}),
    info: (_message, meta) => records.push(meta ?? {}),
    warn: (_message, meta) => records.push(meta ?? {}),
    error: (_message, _error, meta) => records.push(meta ?? {}),
    fatal: (_message, _error, meta) => records.push(meta ?? {}),
    flush: async () => {},
    child: () => base,
  };

  createHttpLogger(base, {
    serviceId: "gateway",
    component: "request-handler",
    operation: "request.completed",
    fields: { customField: "retained" },
  }).info("HTTP request completed");

  expect(records[0]).not.toHaveProperty("http.url");
  expect(records[0]).not.toHaveProperty("http.route");
  expect(records[0]).toMatchObject({
    component: "request-handler",
    operation: "request.completed",
    customField: "retained",
  });
});
