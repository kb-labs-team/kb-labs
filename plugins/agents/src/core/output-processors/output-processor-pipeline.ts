/**
 * OutputProcessorPipeline — chains OutputProcessors in registration order.
 *
 * Called by ToolManager after GuardPipeline.validateOutput():
 *   tool.execute() → GuardPipeline.validateOutput() → OutputProcessorPipeline.run()
 *                                                    → append to context
 *
 * Each processor receives the output of the previous one (pipeline, not fan-out).
 */

import type { OutputProcessor, ToolExecCtx } from '../../sdk/index.js';

export class OutputProcessorPipeline {
  private readonly processors: OutputProcessor[];

  constructor(processors: OutputProcessor[] = []) {
    this.processors = processors;
  }

  async run(output: string, ctx: ToolExecCtx): Promise<string> {
    let current = output;
    for (const processor of this.processors) {
      current = await Promise.resolve(processor.process(current, ctx));
    }
    return current;
  }
}
