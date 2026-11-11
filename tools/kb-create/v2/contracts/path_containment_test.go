package contracts

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPathWithinResolvesSymlinkedRootsAndTargets(t *testing.T) {
	base := t.TempDir()
	realRoot := filepath.Join(base, "real")
	if err := os.Mkdir(realRoot, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(realRoot, link); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(base, "real-sibling")
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	escape := filepath.Join(realRoot, "escape")
	if err := os.Symlink(outside, escape); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		root, path string
		want       bool
	}{
		{link, filepath.Join(realRoot, "missing", "state"), true},
		{realRoot, filepath.Join(link, "missing"), true},
		{link, realRoot, true},
		{link, filepath.Join(outside, "missing"), false},
		{link, filepath.Join(escape, "missing"), false},
	} {
		got, err := PathWithin(tc.root, tc.path)
		if err != nil || got != tc.want {
			t.Errorf("PathWithin(%q, %q) = %v, %v; want %v", tc.root, tc.path, got, err, tc.want)
		}
	}
}
