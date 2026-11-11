# Commit Type Accuracy Benchmarks

This directory contains benchmark results for commit type classification accuracy.

## Running Benchmarks

```bash
# From kb-labs-commit-plugin directory
cd packages/commit-core

# Run benchmark suite
pnpm test:benchmarks

# Run all tests (unit + benchmarks)
pnpm test:all
```

## Benchmark Structure

### Test Cases

Test cases are stored in `tests/benchmarks/test-cases/`:
- `pattern-new-package.json` - New package detection (should be `feat`, not `chore`)
- `pattern-refactor-modify.json` - Modified files with refactoring (should be `refactor`, not `feat`)
- `pattern-deletions.json` - File deletions (should be `chore` or `refactor`, not `feat`)
- `pattern-bulk-move.json` - Bulk file moves (should be `refactor`, not `feat`)

### Results

`pnpm test:benchmarks` saves results to:
- `latest-results.json` - Most recent benchmark run (ordinary `vitest run` leaves it untouched)
- `baseline-results.json` - Baseline before improvements (Phase 1)
- `improved-results.json` - Results after pattern detection (Phase 2+)

## Metrics

### Overall Metrics
- **Accuracy** - Percentage of correct commit types (passed / total)
- **Precision** - True Positives / (True Positives + False Positives)
- **Recall** - True Positives / (True Positives + False Negatives)
- **F1-Score** - Harmonic mean of precision and recall

### Per-Category Metrics
- `new-package` - New package detection accuracy
- `refactor-move` - Bulk move detection accuracy
- `refactor-modify` - Modified file refactoring accuracy
- `deletions` - Deletion detection accuracy
- `mixed` - Complex mixed patterns

### Per-Difficulty Metrics
- `easy` - Simple, clear-cut cases
- `medium` - Moderate complexity
- `hard` - Complex edge cases

## Expected Results

### Baseline (ADR-0015 only)
- Overall accuracy: ~60%
- Common errors:
  - New packages → `chore` (should be `feat`)
  - Bulk moves → `feat` (should be `refactor`)
  - Modified files → `feat` (should be `refactor`)

### Target (ADR-0016 implemented)
- Overall accuracy: 85-90%
- Pattern detection catches 80% of misclassifications
- Few-shot examples reduce LLM training bias
- Extended validation rules handle remaining edge cases

## Adding New Test Cases

1. Create a new test case in appropriate category file:

```json
{
  "id": "unique-test-id",
  "description": "Human-readable description",
  "category": "new-package",
  "difficulty": "medium",
  "files": [
    {
      "path": "path/to/file.ts",
      "status": "added",
      "additions": 100,
      "deletions": 0,
      "isNewFile": true
    }
  ],
  "expected": {
    "commits": [
      {
        "type": "feat",
        "scope": "package-name",
        "message": "add new feature",
        "files": ["path/to/file.ts"],
        "releaseHint": "minor"
      }
    ]
  },
  "baseline": {
    "type": "chore",
    "correct": false,
    "confidence": 0.75,
    "phase": 1
  },
  "tags": ["new-package", "high-priority"]
}
```

2. Run benchmarks to verify:

```bash
pnpm test:benchmarks
```

## Interpreting Results

### Good Signs ✅
- Accuracy improving over baseline
- F1-score > 0.8 for main types (`feat`, `refactor`, `chore`)
- High accuracy on `easy` and `medium` difficulty
- Low Phase 2 escalation rate (<30%)

### Warning Signs ⚠️
- Accuracy regressing from baseline
- F1-score < 0.6 for any common type
- Low accuracy on `easy` difficulty (<80%)
- High Phase 2 escalation rate (>50%)

### Next Steps
1. Check failed test cases in `latest-results.json`
2. Analyze mismatches to identify patterns
3. Adjust pattern detection thresholds or add new rules
4. Update few-shot examples if LLM consistently makes same error
5. Re-run benchmarks to verify improvement

## CI Integration

Benchmarks run automatically on:
- Pull requests to `main`
- Commits to `main`
- Nightly builds

CI will fail if:
- Accuracy drops below baseline
- New regressions introduced (previously passing tests now fail)
- Critical tests fail (tagged with `high-priority`)

## References

- [ADR-0016: Hybrid Pattern Detection](../adr/0016-hybrid-pattern-detection-commit-classification.md)
- [ADR-0017: Benchmark Suite](../adr/0017-benchmark-suite-commit-type-accuracy.md)
- [Implementation Plan](../IMPLEMENTATION_PLAN.md)
