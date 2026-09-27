package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
)

func TestRunSealsNormalizedReleaseExport(t *testing.T) {
	dir := t.TempDir()
	input, output := filepath.Join(dir, "export.json"), filepath.Join(dir, "release", "index.json")
	manifestRoot := filepath.Join(dir, "staging")
	if err := os.WriteFile(input, []byte(`{"channels":{"stable":"2.0.0"},"compatibility":{"schema":"kb.release-compatibility/2","labels":[{"id":"platform@2.0.0","kind":"platform","artifactId":"platform","version":"2.0.0","status":"prepared","validatedBy":["stage"]}]},"platforms":[{"id":"platform","version":"2.0.0","package":"@kb/platform","tarball":"https://example.test/platform.tgz","sha256":"artifact","host":{"command":"node_modules/.bin/kb-host","healthUrl":"http://127.0.0.1:4000/health"},"profiles":{"default":{}}}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(manifestRoot, "node_modules", "@kb", "platform"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(manifestRoot, "node_modules", "@kb", "platform", "kb-create.manifest.json"), []byte(`{"schema":"kb.create.artifact-manifest/v2","id":"platform","package":"@kb/platform","version":"2.0.0"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(input, output, manifestRoot); err != nil {
		t.Fatal(err)
	}
	sealed, err := catalog.LoadFile(output)
	if err != nil || sealed.Digest == "" {
		t.Fatalf("sealed/error = %#v / %v", sealed, err)
	}
}

func TestRunRejectsMissingPublishPaths(t *testing.T) {
	if err := run("", "", ""); err == nil {
		t.Fatal("expected missing paths")
	}
}
