/**
 * Fixture corpora + golden query-set for the benchmark harness.
 *
 * Four corpora exercise different RAG behaviours (code / docs / text / mixed),
 * each indexed under its own indexId so isolation is exercised too. Golden
 * queries carry graded relevance for nDCG and an `expectAbstain` flag for the
 * no-answer case.
 */

import type { GradedRelevant } from './metrics';

export type Corpus = Record<string, string>;

export const CORPORA: Record<string, Corpus> = {
  code: {
    'src/auth.ts':
      'export function login(user, password) {\n  return authenticate(user, password);\n}\nexport function logout(session) { session.destroy(); }',
    'src/cart.ts':
      'export function addToCart(item) {\n  cart.push(item);\n}\nexport function removeFromCart(id) { cart.splice(id, 1); }',
    'src/payment.ts':
      'export function chargeCard(card, amount) {\n  return gateway.charge(card, amount);\n}',
    'src/search.ts':
      'export function rankResults(results) {\n  return results.sort((a, b) => b.score - a.score);\n}',
  },
  docs: {
    'docs/billing.md':
      '# Billing\nInvoices are generated monthly and emailed to the customer automatically.',
    'docs/onboarding.md':
      '# Onboarding\nNew users complete a guided setup wizard on first login.',
    'docs/adr/ADR-001-storage.md':
      '# ADR-001 Storage\nWe chose object storage for durability and cost over block storage.',
  },
  text: {
    'notes/weather.txt': 'The forecast predicts heavy rain and strong winds over the weekend.',
    'notes/recipe.txt': 'Combine flour, sugar and eggs, then bake at 180 degrees for 25 minutes.',
  },
  mixed: {
    'src/auth.ts': 'export function login(user) { return authenticate(user); }',
    'docs/auth.md': '# Authentication\nLogin is handled by the auth service via OAuth tokens.',
  },
};

export interface GoldenQuery {
  id: string;
  group: 'exact_code' | 'concept' | 'doc_fact' | 'paraphrase' | 'abstain';
  corpus: keyof typeof CORPORA;
  query: string;
  relevant: GradedRelevant[];
  expectAbstain?: boolean;
}

export const GOLDEN: GoldenQuery[] = [
  {
    id: 'code-login',
    group: 'exact_code',
    corpus: 'code',
    query: 'login authenticate user password',
    relevant: [{ path: 'src/auth.ts', grade: 3 }],
  },
  {
    id: 'code-cart',
    group: 'exact_code',
    corpus: 'code',
    query: 'add item to cart',
    relevant: [{ path: 'src/cart.ts', grade: 3 }],
  },
  {
    id: 'code-payment',
    group: 'concept',
    corpus: 'code',
    query: 'charge a credit card payment',
    relevant: [{ path: 'src/payment.ts', grade: 3 }],
  },
  {
    id: 'docs-billing',
    group: 'doc_fact',
    corpus: 'docs',
    query: 'how are invoices generated',
    relevant: [{ path: 'docs/billing.md', grade: 3 }],
  },
  {
    id: 'docs-storage-adr',
    group: 'doc_fact',
    corpus: 'docs',
    query: 'why object storage decision durability',
    relevant: [{ path: 'docs/adr/ADR-001-storage.md', grade: 3 }],
  },
  {
    id: 'text-recipe',
    group: 'paraphrase',
    corpus: 'text',
    query: 'baking cake flour sugar eggs oven',
    relevant: [{ path: 'notes/recipe.txt', grade: 3 }],
  },
  {
    id: 'mixed-auth',
    group: 'concept',
    corpus: 'mixed',
    query: 'how does authentication login work',
    relevant: [
      { path: 'docs/auth.md', grade: 3 },
      { path: 'src/auth.ts', grade: 2 },
    ],
  },
  {
    id: 'code-logout',
    group: 'exact_code',
    corpus: 'code',
    query: 'logout destroy session',
    relevant: [{ path: 'src/auth.ts', grade: 3 }],
  },
  {
    id: 'code-removecart',
    group: 'exact_code',
    corpus: 'code',
    query: 'remove item from cart splice',
    relevant: [{ path: 'src/cart.ts', grade: 3 }],
  },
  {
    id: 'code-rank',
    group: 'concept',
    corpus: 'code',
    query: 'sort results by score ranking',
    relevant: [{ path: 'src/search.ts', grade: 3 }],
  },
  {
    id: 'docs-onboarding',
    group: 'doc_fact',
    corpus: 'docs',
    query: 'new user setup wizard first login',
    relevant: [{ path: 'docs/onboarding.md', grade: 3 }],
  },
  {
    id: 'text-weather',
    group: 'paraphrase',
    corpus: 'text',
    query: 'forecast rain wind weekend',
    relevant: [{ path: 'notes/weather.txt', grade: 3 }],
  },
  {
    id: 'abstain-kubernetes',
    group: 'abstain',
    corpus: 'code',
    query: 'kubernetes helm chart deployment rollout',
    relevant: [],
    expectAbstain: true,
  },
  {
    id: 'abstain-docs-graphql',
    group: 'abstain',
    corpus: 'docs',
    query: 'graphql subscription websocket schema stitching',
    relevant: [],
    expectAbstain: true,
  },
];
