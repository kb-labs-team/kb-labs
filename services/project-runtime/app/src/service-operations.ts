import type { RegisteredServiceCommandOperation, ServiceManifest } from '@kb-labs/plugin-contracts';

/** One module's manifest and trusted operation registrations. */
export interface ProjectServiceOperationModule {
  manifest: ServiceManifest;
  operations?: readonly RegisteredServiceCommandOperation[];
}

/** Validate registrations against the module that owns their service manifest. */
export function collectProjectServiceOperations(
  modules: readonly ProjectServiceOperationModule[],
): readonly RegisteredServiceCommandOperation[] {
  const result: RegisteredServiceCommandOperation[] = [];
  const registrations = new Set<string>();
  for (const module of modules) {
    const ownerServiceId = module.manifest.projectApi?.serviceId;
    if (!ownerServiceId) {
      throw new Error(`Service manifest "${module.manifest.id}" is missing projectApi configuration.`);
    }
    const declared = new Set((module.manifest.commands ?? [])
      .filter((command) => command.kind !== 'local' && command.invocation)
      .map((command) => command.invocation!.operationId));
    const registered = new Set<string>();
    for (const operation of module.operations ?? []) {
      if (operation.serviceId !== ownerServiceId) {
        throw new Error(`Service operation "${operation.operationId}" is registered by module "${module.manifest.id}" but names owner "${operation.serviceId}"; expected "${ownerServiceId}".`);
      }
      const key = `${ownerServiceId}:${operation.operationId}`;
      if (registrations.has(key)) {throw new Error(`Duplicate project service operation registration: ${key}.`);}
      registrations.add(key);
      registered.add(operation.operationId);
      if (!declared.has(operation.operationId)) {
        throw new Error(`Service module "${module.manifest.id}" registers undeclared operation "${operation.operationId}".`);
      }
      result.push(operation);
    }
    for (const operationId of declared) {
      if (!registered.has(operationId)) {
        throw new Error(`Service module "${module.manifest.id}" declares operation "${operationId}" without registering it.`);
      }
    }
  }
  return result;
}
