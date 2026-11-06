# Merge resolution: {stream}

A merge of the integration branch into this worktree is in progress, and some files have conflicts (`git diff --name-only --diff-filter=U`). Resolve every conflict so that both sides' intent is kept:
- keep both streams' tests and case rows;
- renumber colliding case subcase ids, and update their `// case:` tags;
- never drop the other side's behaviour.

Edit files only. Do not run `git add`, commit, abort, checkout, reset or stash; the scheduler stages and commits after you. Run the focused tests for the files you touched. Write `.agent-report.md` with first line `Status: DONE`, followed by the list of resolved files and the decisions you made.
