//go:build darwin || linux

// Package proc owns supervised command runs, process membership, teardown,
// and lifecycle events. It supports Linux and macOS; Windows is unsupported.
//
// Ownership guarantee: while a run is active, its keeper owns the entire live
// descendant tree. On Linux the keeper is a child subreaper, so orphaned
// descendants are adopted regardless of process group, session, run marker, or
// inherited token. Teardown repeatedly signals that tree through the pidfd
// signal owner and reaps adopted children until snapshots are empty; a deadline
// with survivors is reported with their process identities and state. Run-token,
// marker, ancestry, and recorded PID/start evidence continue to support status
// and recovery after the keeper is gone. On macOS, cleanup uses observed
// ancestry and recorded identities; it cannot adopt a detached descendant that
// becomes orphaned before observation.
//
// Two cases are outside this guarantee. The owner does not inspect foreign-UID
// descriptor tables, and supervised runs do not have privilege to change UID,
// so cross-UID descendants are not attributed. macOS has no subreaper or
// cgroup; a same-UID descendant that closes every inherited descriptor, has no
// readable matching marker, and detaches before the first observation cannot be
// attributed after losing ancestry. In particular, a descendant that closes
// inherited fd 3 and clears KBLABS_CLIPROC_RUN before the first process snapshot
// is reported as no-run-marker-or-parent-history and is omitted from owned
// cleanup inventory; this close-before-first-observation interleaving is outside
// the guarantee. Cleanup is bounded and reports unresolved identities rather
// than claiming that unobservable processes were reaped.
package proc
