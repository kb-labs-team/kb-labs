interface Entry {
  value: unknown;
  expiresAt?: number;
}

export interface Broker {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(pattern?: string): Promise<void>;
  setIfNotExists<T>(key: string, value: T, ttl?: number): Promise<boolean>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrangebyscore(key: string, min: number, max: number): Promise<string[]>;
  zrem(key: string, member: string): Promise<void>;
}

interface BrokerOptions {
  url?: string;
}

export function createBroker(options: BrokerOptions): Broker {
  return options.url ? new HttpBroker(options.url) : new MemoryBroker();
}

class MemoryBroker implements Broker {
  private readonly entries = new Map<string, Entry>();
  private readonly sortedSets = new Map<string, Map<string, number>>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry || this.expired(key, entry)) {return null;}
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: ttl === undefined ? undefined : Date.now() + ttl });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
    this.sortedSets.delete(key);
  }

  async clear(pattern = "*"): Promise<void> {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    for (const key of this.entries.keys()) {if (key.startsWith(prefix)) {this.entries.delete(key);}}
    for (const key of this.sortedSets.keys()) {if (key.startsWith(prefix)) {this.sortedSets.delete(key);}}
  }

  async setIfNotExists<T>(key: string, value: T, ttl?: number): Promise<boolean> {
    if ((await this.get(key)) !== null) {return false;}
    await this.set(key, value, ttl);
    return true;
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    let set = this.sortedSets.get(key);
    if (!set) { set = new Map(); this.sortedSets.set(key, set); }
    set.set(member, score);
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    return [...(this.sortedSets.get(key)?.entries() ?? [])]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
  }

  async zrem(key: string, member: string): Promise<void> { this.sortedSets.get(key)?.delete(member); }

  private expired(key: string, entry: Entry): boolean {
    if (entry.expiresAt === undefined || entry.expiresAt > Date.now()) {return false;}
    this.entries.delete(key);
    return true;
  }
}

class HttpBroker implements Broker {
  constructor(private readonly baseUrl: string) {}

  async get<T>(key: string): Promise<T | null> {
    if (isLegacyShareTokenCacheKey(key)) {
      const response = await this.postByKey("lookup", { key });
      if (response.status === 404) {
        throw new Error("State broker opaque-key lookup is unavailable; upgrade the State Daemon before resolving legacy share tokens");
      }
      return this.read<T | null>(response);
    }
    const response = await fetch(this.path(key));
    if (response.status === 404) {return null;}
    return this.read<T>(response);
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    if (isLegacyShareTokenCacheKey(key)) {
      await this.read(await this.postByKey("store", { key, value, ttl }));
      return;
    }
    await this.read(await fetch(this.path(key), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value, ttl }) }));
  }

  async delete(key: string): Promise<void> {
    if (isLegacyShareTokenCacheKey(key)) {
      await this.read(await this.postByKey("remove", { key }));
      return;
    }
    await this.read(await fetch(this.path(key), { method: "DELETE" }));
  }

  async clear(pattern = "*"): Promise<void> {
    await this.read(await fetch(`${this.baseUrl}/state/clear?pattern=${encodeURIComponent(pattern)}`, { method: "POST" }));
  }

  async setIfNotExists<T>(key: string, value: T, ttl?: number): Promise<boolean> {
    if (isLegacyShareTokenCacheKey(key)) {
      const response = await this.postByKey("put-if-absent", { key, value, ttl });
      if (response.status === 409) {return false;}
      await this.read(response);
      return true;
    }
    const response = await fetch(`${this.path(key)}/if-absent`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value, ttl }) });
    if (response.status === 409) {return false;}
    await this.read(response);
    return true;
  }

  async zadd(key: string, score: number, member: string): Promise<void> { await this.zset(key, "PUT", { score, member }); }
  async zrem(key: string, member: string): Promise<void> { await this.zset(key, "DELETE", { member }); }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    return this.read<string[]>(await fetch(`${this.path(key)}/range?min=${min}&max=${max}`));
  }

  private async zset(key: string, method: "PUT" | "DELETE", body: unknown): Promise<void> {
    await this.read(await fetch(`${this.path(key)}/zset`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  private path(key: string): string { return `${this.baseUrl}/state/${encodeURIComponent(key)}`; }

  private postByKey(operation: string, payload: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}/state/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  private async read<T>(response: Response): Promise<T> {
    if (!response.ok && response.status !== 204) {throw new Error(`State broker HTTP ${response.status}: ${await response.text()}`);}
    if (response.status === 204) {return undefined as T;}
    return (await response.json()) as T;
  }
}

function isLegacyShareTokenCacheKey(key: string): boolean {
  const marker = "registry:sharetoken:";
  const markerAt = key.lastIndexOf(marker);
  if (markerAt < 0) { return false; }
  const suffix = key.slice(markerAt + marker.length);
  return !/^sha256:[a-f0-9]{64}$/i.test(suffix);
}
