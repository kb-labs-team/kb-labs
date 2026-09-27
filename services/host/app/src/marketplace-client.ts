/**
 * @module @kb-labs/host-app/marketplace-client
 *
 * Thin HTTP client to the marketplace module the host co-locates in the same
 * process (ADR-0043: `INTERNAL_MODULES` in `host.ts`). It calls the exact
 * same REST surface as `kb marketplace plugins list|enable|disable`
 * (`plugins/marketplace/api/src/routes/packages.ts`,
 * `plugins/marketplace/entry/src/commands/plugins/*`) — the single source of
 * truth for `.kb/marketplace.lock` state — so `/api/v1/plugins` and the CLI
 * never disagree about what "enabled" means. Reached on the host's internal
 * loopback address (never through the gateway): no auth token needed, this
 * call never leaves the process boundary.
 */

export interface MarketplacePackageEntry {
  id: string;
  version: string;
  source: string;
  primaryKind: string;
  provides: string[];
  enabled: boolean;
  scope: "platform" | "project";
}

export interface ListPackagesParams {
  kind?: string;
  scope: "platform" | "project" | "all";
  projectRoot?: string;
}

export interface SetEnabledParams {
  packageId: string;
  scope: "platform" | "project";
  projectRoot?: string;
}

/** Thrown when the marketplace responds with a non-2xx status. */
export class MarketplaceClientError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Marketplace request failed (${status}): ${body}`);
    this.name = "MarketplaceClientError";
  }
}

export class MarketplaceClient {
  constructor(private readonly baseUrl: string) {}

  async listPackages(
    params: ListPackagesParams,
  ): Promise<{ entries: MarketplacePackageEntry[]; total: number }> {
    const url = new URL("/packages", this.baseUrl);
    if (params.kind) {
      url.searchParams.set("kind", params.kind);
    }
    url.searchParams.set("scope", params.scope);
    if (params.projectRoot) {
      url.searchParams.set("projectRoot", params.projectRoot);
    }
    return this.request<{ entries: MarketplacePackageEntry[]; total: number }>(
      url,
      { method: "GET" },
    );
  }

  async setEnabled(params: SetEnabledParams, enabled: boolean): Promise<void> {
    const url = new URL(`/packages/${enabled ? "enable" : "disable"}`, this.baseUrl);
    await this.request<unknown>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packageId: params.packageId,
        scope: params.scope,
        ...(params.projectRoot ? { projectRoot: params.projectRoot } : {}),
      }),
    });
  }

  private async request<T>(url: URL, init: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new MarketplaceClientError(response.status, body);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}
