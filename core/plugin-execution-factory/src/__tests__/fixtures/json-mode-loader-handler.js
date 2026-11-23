import { useLoader } from '@kb-labs/shared-cli-ui';

export default {
  async execute() {
    const loader = useLoader('worker-reused-progress');
    loader.start();
    await new Promise((resolve) => setTimeout(resolve, 240));
    loader.stop();
    return { ok: true };
  },
};
