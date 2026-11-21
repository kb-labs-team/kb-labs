export default {
  async execute(ctx) {
    return ctx.platform.llm.complete('wait for host LLM', { signal: ctx.signal });
  },
};
