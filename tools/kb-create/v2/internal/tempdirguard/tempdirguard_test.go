package tempdirguard

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestOwnReportsNewEntriesUnderOwnedPrefixes(t *testing.T) {
	base := t.TempDir()
	t.Setenv("TMPDIR", base)
	for _, name := range []string{"kb-create-fakehost-stale", "kb-create-cli-stale"} {
		if err := os.MkdirAll(filepath.Join(base, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	check := Own("kb-create-fakehost-", "kb-create-cli-")
	for _, name := range []string{"kb-create-fakehost-new", "kb-create-cli-new", "unrelated-leak"} {
		if err := os.MkdirAll(filepath.Join(base, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	leaked := check()
	if !reflect.DeepEqual(leaked, []string{"kb-create-cli-new", "kb-create-fakehost-new"}) {
		t.Fatalf("check() = %v, want the two new owned-prefix entries and nothing else", leaked)
	}
}

func TestOwnReturnsNothingWhenCleanupRemovedEverything(t *testing.T) {
	base := t.TempDir()
	t.Setenv("TMPDIR", base)
	check := Own("kb-create-fakehost-")
	created := filepath.Join(base, "kb-create-fakehost-1")
	if err := os.MkdirAll(created, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(created); err != nil {
		t.Fatal(err)
	}
	if leaked := check(); len(leaked) != 0 {
		t.Fatalf("check() = %v, want nothing leaked after the suite removed its own entries", leaked)
	}
}

func TestOwnReportsTempDirAuditFailure(t *testing.T) {
	base := t.TempDir()
	t.Setenv("TMPDIR", filepath.Join(base, "missing"))
	check := Own("kb-create-fakehost-")
	leaked := check()
	if len(leaked) != 1 || filepath.IsAbs(leaked[0]) || !strings.Contains(leaked[0], "audit temp dir") {
		t.Fatalf("check() = %v, want one audit-failure element naming the temp dir", leaked)
	}
}
