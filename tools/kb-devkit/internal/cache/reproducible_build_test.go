package cache

import (
	"crypto/sha256"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDevkitBuildIsStableAcrossWallClockChanges(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate build reproducibility test")
	}
	moduleRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../.."))
	tempDir := t.TempDir()
	fakeBin := filepath.Join(tempDir, "bin")
	if err := os.MkdirAll(fakeBin, 0o755); err != nil {
		t.Fatal(err)
	}
	fakeDate := filepath.Join(fakeBin, "date")
	if err := os.WriteFile(fakeDate, []byte("#!/bin/sh\nprintf '%s\\n' \"$X168_FAKE_DATE\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	build := func(output, date string) [sha256.Size]byte {
		t.Helper()
		cmd := exec.Command("make", "build", "BINARY="+output)
		cmd.Dir = moduleRoot
		cmd.Env = append(os.Environ(),
			"PATH="+fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"),
			"X168_FAKE_DATE="+date,
		)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("make build: %v\n%s", err, output)
		}
		binary, err := os.ReadFile(output)
		if err != nil {
			t.Fatalf("read built executable: %v", err)
		}
		return sha256.Sum256(binary)
	}

	first := build(filepath.Join(tempDir, "kb-devkit-first"), "2026-10-25T10:00:00Z")
	second := build(filepath.Join(tempDir, "kb-devkit-second"), "2026-10-25T11:00:00Z")
	if first != second {
		t.Fatal("DevKit build output changed when only wall-clock time changed")
	}
}
