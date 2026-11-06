# ADR-0019: Embeddings-Based Semantic Clustering for Commit Generation

**Date:** 2025-12-27
**Status:** Proposed
**Deciders:** Kirill Baranov
**Last Reviewed:** 2025-12-27
**Tags:** [clustering, embeddings, llm, platform-integration, semantic-analysis]

> **Note:** This ADR proposes leveraging KB Labs' existing embeddings infrastructure (`@kb-labs/mind-embeddings`) to solve the "fat commits" problem through semantic file clustering.

---

## Context

After fixing the "feat bias" problem in [ADR-0018](0018-reasoning-based-classification-with-mandatory-escalation.md), we discovered that the LLM still creates "fat commits" - grouping many unrelated files into a single commit.

**Example Problem:**
```
[309dd74] chore: update additional files (50 files, 3849 insertions)
  - Entire new package core-ipc (14 files)
  - 14 package.json updates
  - New execution contracts
  - Tests
```

**Root Cause:** The LLM attempts to group files after creating priority groups (refactor, chore), but without semantic understanding it groups "leftovers" into one large commit.

**Opportunity:** KB Labs already has a powerful embeddings system in Mind (`@kb-labs/mind-embeddings`) that we can reuse for semantic file clustering.

**Key Constraints:**
- Must work for any programming language (language-agnostic)
- Must be cost-effective (<$0.05 per 100 files)
- Must integrate with existing platform infrastructure
- Should provide confidence scores for clustering quality

### Alternatives Considered

### Option 1: Pattern-Based Pre-Grouping (Current Approach + Enhancement)
**Pros:**
- Simple, deterministic
- No API costs
- Fast

**Cons:**
- Requires maintaining patterns for every language/framework
- Brittle, fails on edge cases
- Still creates fat commits for unmatched files

**Verdict:** ❌ Rejected - doesn't solve the root problem

### Option 2: LLM-Only Grouping with Explicit Instructions
**Pros:**
- No additional infrastructure
- Flexible

**Cons:**
- LLM still creates fat commits despite instructions
- High token cost for large changesets
- No confidence scores for groupings

**Verdict:** ❌ Rejected - already tried, didn't work reliably

### Option 3: Embeddings-Based Semantic Clustering (CHOSEN)
**Pros:**
- Reuses platform infrastructure (`@kb-labs/mind-embeddings`)
- Language agnostic, no patterns to maintain
- Provides clustering confidence scores
- Cheap (~$0.01 per 50 files)
- Handles edge cases automatically
- Caching reduces cost for similar files

**Cons:**
- Requires OpenAI API key (or fallback to deterministic)
- Adds complexity to commit generation pipeline
- Initial implementation effort

**Verdict:** ✅ **Accepted** - best long-term solution, leverages platform

---

## Decision

We will integrate `@kb-labs/mind-embeddings` into the commit generation pipeline to perform **semantic clustering of files BEFORE LLM grouping**.

**Key aspects:**
1. **File Context Builder**: Combines path, change type, diff preview, and keywords into text representation for embedding
2. **Embeddings Generation**: Uses platform's `EmbeddingProvider` (OpenAI text-embedding-3-small or deterministic fallback)
3. **DBSCAN Clustering**: Groups similar files by cosine distance (epsilon=0.3 = 70% similarity threshold)
4. **Cluster-Based Commit Generation**: LLM generates commit message for each semantic cluster
5. **Platform Caching**: Automatic caching in `.kb/mind/embeddings-cache/` (repeat runs are free)

---

## Consequences

### Positive

1. **Platform Reuse**: Leverages existing `@kb-labs/mind-embeddings` infrastructure - no reinvention
2. **Better Grouping**: Semantic clustering produces coherent commits instead of "fat commits"
3. **Language Agnostic**: Works for any codebase without hardcoded patterns
4. **Cost-Effective**: ~$0.0002 for embeddings per 50 files (cheaper than additional LLM tokens)
5. **Automatic Caching**: Platform handles caching - repeated runs are free
6. **Confidence Scores**: Cluster coherence provides quality metrics (0-1 scale)
7. **Fallback Support**: Graceful degradation to deterministic embeddings if OpenAI unavailable

### Negative

1. **Complexity**: Adds clustering logic to commit generation pipeline (4 new modules)
2. **API Dependency**: Best results require OpenAI API key (though deterministic fallback exists)
3. **Initial Latency**: Embeddings generation adds ~2-5s for 50 files (one-time per unique file context)
4. **Learning Curve**: Team needs to understand DBSCAN, cosine similarity, and clustering concepts
5. **Threshold Tuning**: May need to adjust epsilon (0.3) and minCoherence (0.6) based on real usage

### Alternatives Considered

**Why not pattern-based grouping?**
- Brittle, requires maintenance for every language/framework
- Fails on edge cases (e.g., refactor that adds new file)
- Still creates fat commits for unmatched files

**Why not LLM-only with better prompts?**
- Already tried in ADR-0018 - LLM still creates fat commits
- High token cost for large changesets
- No objective confidence scores

**Why embeddings?**
- Objective semantic similarity (not LLM hallucination-prone)
- Platform infrastructure already exists
- Proven approach (used in Mind RAG with 7.0/10 quality score)

---

## Implementation

**When implemented, this decision will require:**

### New Modules (4 files)

1. **`src/clustering/embedding-context.ts`** - Builds text representation for each file change
   - Function: `buildFileContext(summary, diff)` → combines path + change type + diff preview + keywords
   - Purpose: Create meaningful text for embedding generation

2. **`src/clustering/dbscan.ts`** - DBSCAN clustering algorithm
   - Function: `dbscanClustering(embeddings, options)` → returns clusters
   - Uses cosine distance as similarity metric (via Mind's `dotProduct` utility)

3. **`src/clustering/semantic-cluster.ts`** - Main clustering orchestrator
   - Function: `clusterFilesBySemantic(summaries, diffs, embeddingProvider)` → returns clusters with coherence scores
   - Integrates: embedding generation + DBSCAN + coherence calculation

4. **`src/generator/cluster-commit.ts`** - LLM commit generation per cluster
   - Function: `generateCommitFromCluster(cluster, llmComplete)` → returns CommitGroup
   - Calls LLM with cluster context to generate conventional commit

### Modified Modules

**`src/generator/commit-plan.ts`** - Main commit generation flow
- Add semantic clustering step BEFORE LLM grouping (when 10+ files)
- Initialize `embeddingProvider` from runtime
- Pass clusters to LLM for commit message generation

### Configuration Changes

**`@kb-labs/commit/contracts`** - Add clustering options
```typescript
semanticClustering?: {
  enabled?: boolean;        // Default: true
  threshold?: number;       // Files count to trigger (default: 10)
  epsilon?: number;         // DBSCAN epsilon (default: 0.3)
  minCoherence?: number;    // Minimum cluster quality (default: 0.5)
  fallbackToLLM?: boolean;  // Fallback if clustering fails (default: true)
}
```

### Pipeline Flow Change

**Before (current):**
```
File Summaries → Pattern Detection → LLM Grouping → Commits
```

**After (with embeddings):**
```
File Summaries → Semantic Clustering → LLM Grouping (per cluster) → Commits
                 (if 10+ files)
```

### Dependencies

Add to `kb-labs-commit-plugin/packages/commit-core/package.json`:
```json
{
  "dependencies": {
    "@kb-labs/mind-embeddings": "workspace:*"
  }
}
```

### Estimated Implementation Timeline

- **Day 1-2**: Infrastructure (embedding-context, dbscan, semantic-cluster modules)
- **Day 3**: Integration (modify commit-plan, cluster-commit generation)
- **Day 4**: Testing (unit tests, integration tests, benchmarks)

**Total:** ~4 days

### Success Metrics

- Average cluster coherence ≥0.6
- Average commit size 5-15 files (not 50)
- Cost <$0.01 per 50-file changeset
- Performance <10s for 50 files (including embeddings)

**Will this decision be revisited?**

Yes, after initial implementation we should:
1. Tune epsilon threshold based on real usage data
2. Consider hierarchical clustering for >100 file changesets
3. Evaluate adding interactive cluster approval mode
4. Monitor cost and performance metrics

---

## References

- [ADR-0018: Reasoning-Based Classification with Mandatory Escalation](0018-reasoning-based-classification-with-mandatory-escalation.md)
- [Mind Embeddings Package](../../kb-labs-mind/packages/mind-embeddings/)
- [ADR-0017: Embedding Provider Abstraction (Mind)](../../kb-labs-mind/docs/adr/0017-embedding-provider-abstraction.md)
- [DBSCAN Algorithm](https://en.wikipedia.org/wiki/DBSCAN)
- [OpenAI Embeddings API Documentation](https://platform.openai.com/docs/guides/embeddings)
- [OpenAI Pricing](https://openai.com/pricing) - text-embedding-3-small: $0.00002/1K tokens

---

**Last Updated:** 2025-12-27
**Next Review:** After initial implementation (estimated 2026-01-XX)
