import { getArtifactId } from '../../contracts/index.js';
import { defineHandler, type PluginContextV3 } from '@kb-labs/sdk';
import { createGreeting } from '../../core/greeting';
import type { HelloRequest } from '../schemas/hello-schema';

const HELLO_GREETING_ARTIFACT_ID = getArtifactId('template.hello.greeting');

/**
 * Hello REST handler
 */
export const handleHello = defineHandler({
  async execute(ctx: PluginContextV3, request: HelloRequest) {
    const greeting = createGreeting(request.name as string | undefined);

    ctx.platform?.logger?.info('Hello REST endpoint executed', {
      requestId: ctx.requestId,
      target: greeting.target,
      produces: [HELLO_GREETING_ARTIFACT_ID],
    });

    return { message: greeting.message, target: greeting.target };
  },
});
