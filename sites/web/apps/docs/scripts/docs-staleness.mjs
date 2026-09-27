#!/usr/bin/env node
/**
 * docs-staleness.mjs — find doc pages affected by changed code files
 *
 * Input:  CHANGED_FILES env var — newline-separated paths relative to repo root
 * Output: JSON to stdout:
 *   {
 *     affected: [
 *       { slug, type, docPath, stalenessRisk, matchedFile, matchedOwner }
 *     ]
 *   }
 *
 * Standalone: CHANGED_FILES="plugins/workflow/core/executor.ts" node docs-staleness.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sourceFileForCommand } from './docs-source-sync.mjs';

const cwd = process.cwd();
const sitemapPath = join(cwd, 'sitemap.config.json');

function ownerMatches(ownerGlob, filePath) {
  // Patterns are like "plugins/workflow/**" or "core/platform/**"
  // Strip trailing /** and check prefix match
  const base = ownerGlob.replace(/\/\*\*$/, '').replace(/\*\*$/, '');
  return filePath === base || filePath.startsWith(base + '/');
}

function collectPages(sitemap) {
  const pages = [];
  for (const section of sitemap.sections ?? []) {
    for (const page of section.pages ?? []) {
      pages.push({
        ...page,
        type: page.type ?? section.type,
        stalenessRisk: page.stalenessRisk ?? section.stalenessRisk ?? 'medium',
      });
    }
    for (const sub of section.subsections ?? []) {
      for (const page of sub.pages ?? []) {
        pages.push({
          ...page,
          type: page.type ?? sub.type ?? section.type,
          stalenessRisk: page.stalenessRisk ?? sub.stalenessRisk ?? section.stalenessRisk ?? 'medium',
        });
      }
    }
  }
  return pages;
}

function slugToDocPath(slug) {
  // Convert slug to URL path: sdk/plugin-api/index → /docs/sdk/plugin-api
  const withoutIndex = slug.replace(/\/index$/, '');
  return `/docs/${withoutIndex}`;
}

function collectSourceReferences(pages) {
  const pageBySlug = new Map(pages.map((page) => [page.slug, page]));
  const refs = [];
  const contentRoot = join(cwd, 'content');

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.mdx')) continue;

      const content = readFileSync(filePath, 'utf8');
      const localeRelative = filePath.slice(contentRoot.length + 1).replaceAll('\\', '/');
      const localeSeparator = localeRelative.indexOf('/');
      const docRelative = localeRelative.slice(localeSeparator + 1);
      const slug = docRelative.replace(/\.mdx$/, '').replace(/\/index$/, '');
      const page = pageBySlug.get(slug);
      if (!page) continue;

      const directive = /<CommandExamples\s+command="([^"]+)"(?:\s+match="([^"]+)")?\s*\/>/g;
      for (const match of content.matchAll(directive)) {
        const sourceFile = sourceFileForCommand(match[1]);
        if (sourceFile) refs.push({ page, sourceFile, command: match[1] });
      }
    }
  }

  if (existsSync(contentRoot)) walk(contentRoot);
  return refs;
}

function main() {
  const changedFilesRaw = process.env.CHANGED_FILES ?? '';
  const changedFiles = changedFilesRaw
    .split('\n')
    .map(f => f.trim())
    .filter(Boolean);

  if (changedFiles.length === 0) {
    process.stdout.write(JSON.stringify({ affected: [] }));
    process.exit(0);
  }

  if (!existsSync(sitemapPath)) {
    process.stderr.write('sitemap.config.json not found\n');
    process.exit(1);
  }

  const sitemap = JSON.parse(readFileSync(sitemapPath, 'utf-8'));
  const pages = collectPages(sitemap);
  const sourceRefs = collectSourceReferences(pages);

  // For each changed file, find the most-specific owner match per doc page.
  // "Most specific" = longest owner prefix (e.g. plugins/workflow/core/** beats plugins/workflow/**).
  // This prevents broad patterns from flooding unrelated pages.
  const affectedMap = new Map(); // slug → entry

  for (const file of changedFiles) {
    // An explicit source reference is stronger than a broad ownership zone.
    // When a page embeds a generated fragment from this file, route this
    // change only to those explicitly linked pages instead of every page that
    // happens to own the containing subsystem.
    const explicitlyReferenced = sourceRefs.some((ref) => ref.sourceFile === file);
    if (explicitlyReferenced) continue;

    // Collect all (page, owner) matches for this file, scored by specificity
    const matches = [];
    for (const page of pages) {
      if (!page.owners?.length) continue;
      if (page.type === 'auto') continue;

      for (const owner of page.owners) {
        if (ownerMatches(owner, file)) {
          const specificity = owner.replace(/\/\*\*$/, '').split('/').length;
          matches.push({ page, owner, specificity });
          break; // one owner per page is enough
        }
      }
    }

    // Report only the most-specific matching ownership zones for this file.
    // Parent zones are fallback hints: once a page has a more precise match,
    // including package-wide owners would reintroduce unrelated pages.
    if (matches.length === 0) continue;
    const maxSpec = Math.max(...matches.map(m => m.specificity));
    const threshold = maxSpec;

    for (const { page, owner, specificity } of matches) {
      if (specificity < threshold) continue;

      if (!affectedMap.has(page.slug)) {
        affectedMap.set(page.slug, {
          slug: page.slug,
          type: page.type,
          docPath: slugToDocPath(page.slug),
          stalenessRisk: page.stalenessRisk,
          matchedFiles: [],
          matchedOwner: owner,
          specificity,
          matchKind: 'zone',
        });
      }
      const entry = affectedMap.get(page.slug);
      if (!entry.matchedFiles.includes(file)) entry.matchedFiles.push(file);
      if (specificity > entry.specificity) {
        entry.matchedOwner = owner;
        entry.specificity = specificity;
      }
    }
  }

  // Exact generated-source references complement broad sitemap ownership.
  for (const file of changedFiles) {
    for (const ref of sourceRefs.filter((item) => item.sourceFile === file)) {
      const page = ref.page;
      if (!affectedMap.has(page.slug)) {
        affectedMap.set(page.slug, {
          slug: page.slug,
          type: page.type,
          docPath: slugToDocPath(page.slug),
          stalenessRisk: page.stalenessRisk,
          matchedFiles: [],
          matchedOwner: `source:${ref.command}`,
          specificity: Number.MAX_SAFE_INTEGER,
          matchKind: 'exact',
          sourceReferences: [],
        });
      }
      const entry = affectedMap.get(page.slug);
      if (!entry.matchedFiles.includes(file)) entry.matchedFiles.push(file);
      entry.sourceReferences ??= [];
      if (!entry.sourceReferences.includes(ref.command)) entry.sourceReferences.push(ref.command);
    }
  }

  const affected = [...affectedMap.values()].sort((a, b) => {
    const risk = { high: 0, medium: 1, low: 2 };
    return (risk[a.stalenessRisk] ?? 1) - (risk[b.stalenessRisk] ?? 1);
  });

  process.stdout.write(JSON.stringify({ affected }, null, 2));
}

main();
