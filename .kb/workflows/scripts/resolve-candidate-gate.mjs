#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformFlowPolicies } from '../../../plugins/release/src/core/platform-flow-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const flow = value('--flow');
const channel = value('--channel');
if (!flow || !channel) throw new Error('--flow and --channel are required');

const policy = platformFlowPolicies[flow]?.gatePolicy?.[channel]?.policy;
if (!policy) throw new Error(`release flow ${flow} has no gate policy for channel ${channel}`);
const target = platformFlowPolicies[flow]?.channelDeliveryTargets?.[channel];
if (!target || !platformFlowPolicies[flow]?.deliveryTargets?.[target]) {
  throw new Error(`release flow ${flow} has no declared delivery target for channel ${channel}`);
}
const required = policy === 'release-cases';
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_OUTPUT, `required=${required}\npolicy=${policy}\ntarget=${target}\n`);
}
process.stdout.write(`required=${required}\ntarget=${target}\n`);
