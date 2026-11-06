export type ActiveWorkKind = "workflow" | "job" | "service-job" | "long-command";

export interface ActiveWorkEntry {
  kind: ActiveWorkKind;
  id: string;
}

export interface ActiveWorkItem extends ActiveWorkEntry {
  owningService: string;
}

export type ActiveWorkProvider = () => Promise<readonly ActiveWorkEntry[]>;

/** Providers register when their service starts and are removed on teardown. */
export class ActiveWorkRegistry {
  private readonly providers = new Map<string, ActiveWorkProvider>();

  register(serviceId: string, provider: ActiveWorkProvider): () => void {
    if (this.providers.has(serviceId)) {
      throw new Error(`An active-work provider is already registered for service "${serviceId}".`);
    }
    this.providers.set(serviceId, provider);
    return () => {
      if (this.providers.get(serviceId) === provider) {
        this.providers.delete(serviceId);
      }
    };
  }

  async list(): Promise<ActiveWorkItem[]> {
    const providers = [...this.providers.entries()];
    const items = await Promise.all(providers.map(async ([owningService, provider]) =>
      (await provider()).map((item) => ({ ...item, owningService }))));
    return items.flat().sort((left, right) =>
      left.owningService.localeCompare(right.owningService)
      || left.kind.localeCompare(right.kind)
      || left.id.localeCompare(right.id));
  }
}
