import fs from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';
import { compileMDX } from 'next-mdx-remote/rsc';
import rehypePrettyCode, { type Options as PrettyCodeOptions } from 'rehype-pretty-code';
import remarkGfm from 'remark-gfm';

import { MdxComponents } from '@/components/MdxComponents';
import { syncDocSources } from './expand-doc-sources.mjs';
import generatedDocSources from '../generated/doc-source-snippets.json';

const prettyCodeOptions: PrettyCodeOptions = {
  theme: { light: 'github-light', dark: 'github-dark-dimmed' },
  keepBackground: false,
  defaultLang: 'plaintext',
  bypassInlineCode: true,
};

export type Frontmatter = {
  title: string;
  description?: string;
  updatedAt?: string;
  order?: number;
  hidden?: boolean;
};

const contentRoot = path.resolve(process.cwd(), 'content');

function resolveFilePath(localeDir: string, slugParts: string[]): string | null {
  const base = path.join(contentRoot, localeDir, ...slugParts);
  if (fs.existsSync(`${base}.mdx`)) return `${base}.mdx`;
  if (fs.existsSync(path.join(base, 'index.mdx'))) return path.join(base, 'index.mdx');
  return null;
}

async function loadPage(filePath: string) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { content, data } = matter(raw);
  const sourceSyncedContent = syncDocSources(content, path.relative(process.cwd(), filePath), generatedDocSources);

  const compiled = await compileMDX<Frontmatter>({
    source: sourceSyncedContent,
    components: MdxComponents,
    options: {
      parseFrontmatter: false,
      mdxOptions: {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [[rehypePrettyCode, prettyCodeOptions]],
      },
    },
  });

  return {
    frontmatter: data as Frontmatter,
    content: compiled.content,
  };
}

export async function getDocPage(locale: string, slugParts: string[]) {
  const localePath = resolveFilePath(locale, slugParts);
  if (localePath) {
    return { ...(await loadPage(localePath)), isFallback: false, isIndex: localePath.endsWith('/index.mdx') };
  }

  if (locale !== 'en') {
    const fallbackPath = resolveFilePath('en', slugParts);
    if (fallbackPath) {
      return { ...(await loadPage(fallbackPath)), isFallback: true, isIndex: fallbackPath.endsWith('/index.mdx') };
    }
  }

  return null;
}

export function extractHeadings(locale: string, slugParts: string[]): { id: string; text: string; level: 2 | 3 }[] {
  const filePath = resolveFilePath(locale, slugParts) ?? resolveFilePath('en', slugParts);
  if (!filePath) return [];

  const raw = fs.readFileSync(filePath, 'utf8');
  const { content } = matter(raw);

  const headings: { id: string; text: string; level: 2 | 3 }[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const h2 = line.match(/^## (.+)/);
    const h3 = line.match(/^### (.+)/);
    if (h2) {
      const text = h2[1].trim();
      headings.push({ id: slugify(text), text, level: 2 });
    } else if (h3) {
      const text = h3[1].trim();
      headings.push({ id: slugify(text), text, level: 3 });
    }
  }

  return headings;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}
