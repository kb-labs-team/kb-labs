export type PluginType = 'plugin' | 'adapter' | 'widget' | 'hook';

export type MarketplaceItem = {
  slug: string;
  name: string;
  type: PluginType;
  version: string;
  author: string;
  authorType: 'official' | 'community';
  description: string;
  longDescription: string;
  tags: string[];
  installCmd: string;
  commands?: string[];
  permissions?: string[];
  envVars?: string[];
  allowedHosts?: string[];
  weeklyDownloads: number;
  stars: number;
  updatedAt: string;
  docs?: string;
  readme?: string;
};

export const TYPE_LABELS: Record<PluginType | 'all', string> = {
  all: 'All',
  plugin: 'Plugins',
  adapter: 'Adapters',
  widget: 'Widgets',
  hook: 'Hooks',
};

const REGISTRY_URL = process.env.KB_REGISTRY_URL ?? 'https://api.kblabs.ru/api/v1/registry';

interface RegistryAuthor { name: string; email?: string; url?: string }

interface RegistryEntryMeta {
  description?: string;
  readme?: string;
  permissions?: string[];
  envVars?: string[];
  allowedHosts?: string[];
  commands?: string[];
  [key: string]: unknown;
}

interface RegistryEntryDetail {
  name: string;
  authorHandle: string;
  meta: RegistryEntryMeta;
}

interface RegistrySummary {
  handle: string;
  name: string;
  fullName: string;
  version: string;
  description?: string;
  author?: RegistryAuthor | string;
  keywords?: string[];
  primaryKind: string;
  trust: string;
  installs: number;
  publishedAt: string;
}

function kindToPluginType(kind: string): PluginType {
  if (kind === 'adapter') return 'adapter';
  if (kind === 'studio-widget') return 'widget';
  return 'plugin';
}

function authorString(author?: RegistryAuthor | string): string {
  if (!author) return 'Unknown';
  if (typeof author === 'string') return author;
  return author.name;
}

function packageSlug(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1] ?? name.replace(/^@/, '');
}

function summaryToItem(s: RegistrySummary, detail?: RegistryEntryDetail): MarketplaceItem {
  const rawName = s.name.split('/').pop() ?? s.name;
  // Use handle as author fallback when author field is absent
  const author = authorString(s.author) !== 'Unknown' ? authorString(s.author) : s.handle;
  const meta = detail?.meta;
  return {
    slug: packageSlug(s.name),
    name: rawName,
    type: kindToPluginType(s.primaryKind),
    version: s.version,
    author,
    authorType: s.trust === 'trusted' ? 'official' : 'community',
    description: s.description ?? '',
    longDescription: s.description ?? '',
    tags: s.keywords ?? [],
    installCmd: `kb marketplace install kb:${s.fullName}`,
    weeklyDownloads: s.installs,
    stars: 0,
    updatedAt: s.publishedAt.slice(0, 10),
    readme: meta?.readme,
    permissions: meta?.permissions,
    envVars: meta?.envVars,
    allowedHosts: meta?.allowedHosts,
    commands: meta?.commands,
  };
}

export async function fetchRegistryItems(): Promise<MarketplaceItem[]> {
  try {
    const res = await fetch(`${REGISTRY_URL}/packages`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    const data = await res.json() as RegistrySummary[];
    return data.map((s) => summaryToItem(s));
  } catch {
    return [];
  }
}

export async function fetchRegistryItem(slug: string): Promise<MarketplaceItem | undefined> {
  try {
    // Fetch list to find the matching summary (needed for handle + full package name)
    const listRes = await fetch(`${REGISTRY_URL}/packages`, {
      next: { revalidate: 300 },
    });
    if (!listRes.ok) return undefined;
    const data = await listRes.json() as RegistrySummary[];
    const match = data.find((s) => packageSlug(s.name) === slug);
    if (!match) return undefined;

    // Fetch full entry for readme + manifest fields
    let detail: RegistryEntryDetail | undefined;
    try {
      const detailRes = await fetch(
        `${REGISTRY_URL}/packages/${match.handle}/${encodeURIComponent(match.name)}`,
        { next: { revalidate: 300 } },
      );
      if (detailRes.ok) {
        detail = await detailRes.json() as RegistryEntryDetail;
      }
    } catch {
      // non-fatal — render without readme/manifest fields
    }

    return summaryToItem(match, detail);
  } catch {
    return undefined;
  }
}
