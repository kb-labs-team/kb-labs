Review the completed stream {stream} in its persisted worktree.

Inspect the full working tree diff and the stream's `.agent-report.md`. Check the reported root causes, tests, implementation, and any user-visible behavior against the task and product cases. Run relevant Go checks where practical. Do not change source files.

Write the complete report to the run-owned output path `{review-report}`. This report is private to this review task; do not read or rely on another reviewer's output. Its first line must be exactly `ACCEPT` when the work is ready for the scheduler to land, or exactly `REJECT` when changes are required. Explain the verdict and cite file and line evidence below the first line.
