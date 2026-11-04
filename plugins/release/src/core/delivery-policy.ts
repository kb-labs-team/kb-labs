import { platformFlowPolicies } from './platform-flow-policy.mjs';
import type { ReleaseConfig, ReleaseDeliveryTarget, ReleaseFlowPolicy, ReleaseChannel } from './types';

export interface CandidateGateProvenance {
  policy: 'none' | 'release-cases';
  result: 'passed' | 'failed' | 'skipped';
  runId?: string;
}

export interface CandidateGatePolicy {
  policy: 'none' | 'release-cases';
}

const defaultFlowPolicies: Record<string, ReleaseFlowPolicy> = platformFlowPolicies;

export function resolveDeliveryTargets(config: ReleaseConfig, flow: string): Record<string, ReleaseDeliveryTarget> {
  return {
    ...(defaultFlowPolicies[flow]?.deliveryTargets ?? {}),
    ...config.flows?.[flow]?.deliveryTargets,
  };
}

export function resolveCandidateGatePolicy(flow: string, channel: ReleaseChannel): CandidateGatePolicy {
  const policy = defaultFlowPolicies[flow]?.gatePolicy?.[channel];
  if (!policy) throw new Error(`Release flow ${flow} has no candidate gate policy for ${channel}`);
  return policy;
}

export function resolveChannelDeliveryTarget(flow: string, channel: ReleaseChannel): string {
  const target = defaultFlowPolicies[flow]?.channelDeliveryTargets?.[channel];
  if (!target) throw new Error(`Release flow ${flow} has no delivery target for ${channel}`);
  return target;
}

export function findTestDeliveryTarget(targets: Record<string, ReleaseDeliveryTarget>): string | undefined {
  return Object.entries(targets).find(([, target]) => target.kind === 'test')?.[0];
}
