package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

func TestColorEnabledNonFileWriter(t *testing.T) {
	unsetColorOverrides(t)
	t.Setenv("TERM", "xterm-256color")
	if ColorEnabled(&strings.Builder{}) {
		t.Fatal("a non-file writer must not enable color")
	}
}

func TestColorEnabledRegularFile(t *testing.T) {
	unsetColorOverrides(t)
	t.Setenv("TERM", "xterm-256color")
	f, err := os.Create(filepath.Join(t.TempDir(), "out.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if ColorEnabled(f) {
		t.Fatal("a regular file is not a terminal")
	}
}

func unsetColorOverrides(t *testing.T) {
	t.Helper()
	for _, name := range []string{"NO_COLOR", "FORCE_COLOR"} {
		value, set := os.LookupEnv(name)
		if err := os.Unsetenv(name); err != nil {
			t.Fatalf("unset %s: %v", name, err)
		}
		t.Cleanup(func() {
			if set {
				if err := os.Setenv(name, value); err != nil {
					t.Errorf("restore %s: %v", name, err)
				}
			} else if err := os.Unsetenv(name); err != nil {
				t.Errorf("restore unset %s: %v", name, err)
			}
		})
	}
}

func TestColorDisabledUsesLipglossNoColor(t *testing.T) {
	if _, ok := color(false, "10").(lipgloss.NoColor); !ok {
		t.Fatalf("disabled color type = %T", color(false, "10"))
	}
}

func TestColorEnabledUsesLipglossColor(t *testing.T) {
	got, ok := color(true, "10").(lipgloss.Color)
	if !ok || string(got) != "10" {
		t.Fatalf("enabled color = %T(%v)", color(true, "10"), color(true, "10"))
	}
}
