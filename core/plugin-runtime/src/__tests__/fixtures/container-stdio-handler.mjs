export default {
  async execute(ctx) {
    console.log('container-stdio-handler-log');
    return ctx.platform.cache.get('container-stdio-key');
  },
};
