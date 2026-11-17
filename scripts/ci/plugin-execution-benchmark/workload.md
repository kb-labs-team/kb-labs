# `ctx-ipc-microbenchmark` workload contract

This workload measures a narrow path: transfer a 4 KiB CLI host-context field, execute a small handler, and perform one deterministic cache call. It is a microbenchmark for ctx transport and host-mediated IPC overhead, not a proxy for normal plugin application performance.

The same ESM handler runs in all three execution modes: `in-process`, `subprocess`, and `worker-pool`. The host context includes a fixed `flags.padding` string of 4096 bytes. The handler returns request identity and sequence, and makes a cache lookup keyed by sequence:

```js
export default {
  async execute(ctx, input) {
    const marker = await ctx.platform.cache.get(`benchmark:marker:${input.sequence}`);
    return {
      requestId: ctx.requestId,
      pluginId: ctx.pluginId,
      host: ctx.host,
      marker,
      padding: ctx.hostContext.flags.padding,
      sequence: input.sequence,
    };
  },
};
```

The descriptor grants `permissions.platform.cache: true`. The host cache returns a fixed marker and records each sequence key. Each execution is checked against its own expected request ID, plugin ID, host, marker, padding, and sequence. A canonical digest validates each individual result. Digests are not required to match between source revisions because request IDs encode the source SHA. The benchmark asserts exact host-call count and unique sequence coverage; concurrent completion order is allowed to vary.

Any unavailable mode, failed call, result mismatch, missing/duplicate host-call sequence, incorrect backend stats, unhealthy final state, or leftover child process invalidates the whole paired repeat. No timing is reported for an incomplete pair.

## Per-mode protocol

For every `source_sha × mode × repeat`:

1. Create a fresh backend and record construction duration.
2. Measure the first backend `execute()` call after construction. The factory does not expose backend `start()`; for worker-pool this cold first execution includes lazy pool startup. The field names this scope explicitly.
3. Execute 30 verified warmups, excluded from the latency samples.
4. Execute 500 serial calls. Capture each duration immediately when `backend.execute()` resolves, before correctness checks; report p50/p95/p99 and preserve the raw duration array.
5. Measure separate 10-second verified-workload throughput windows at concurrency 1 and 8. Throughput counts only correct completed calls and includes the small harness assertion cost; it is reported as verified calls/second.
6. Execute a 100-call serial correctness soak in every fast repeat; the optional separate extended-soak artifact runs 2,000 additional calls per mode/revision once and verify backend stats/health.
7. Sample Linux `/proc` process-tree VmRSS every 100 ms and at phase boundaries. Report sampled process-tree RSS as a lower bound. For child RSS, also report observed child count and sample count; if no subprocess/worker was observed, mark child RSS `unmeasurable_no_child_sampled` and emit no numeric child-RSS peak. In-process has no child RSS metric. This avoids presenting a missed transient child as a zero or exact peak.
8. Shut down in `finally`, then verify no descendant process remains.

Each paired repeat uses the same hosted runner for baseline and candidate, alternates revision order, and rotates mode order. Aggregate medians are calculated from paired per-repeat values and ratios. Outliers are retained.
