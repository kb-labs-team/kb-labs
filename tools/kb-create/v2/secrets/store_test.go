package secrets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoreIsPrivateAndSupportsExistenceOnly(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	if err := store.Put("OPENAI_API_KEY", "super-secret"); err != nil {
		t.Fatal(err)
	}
	exists, err := store.Exists("OPENAI_API_KEY")
	if err != nil || !exists {
		t.Fatalf("exists/error = %v / %v", exists, err)
	}
	path := filepath.Join(root, ".kb", "v2", "secrets.env")
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), "super-secret") {
		t.Fatalf("store/error = %s / %v", data, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode/error = %v / %v", info.Mode(), err)
	}
}
func TestStoreRejectsInjectionName(t *testing.T) {
	if err := (Store{PlatformRoot: t.TempDir()}).Put("TOKEN\nEVIL", "x"); err == nil {
		t.Fatal("accepted injection name")
	}
}

func TestGetReturnsStoredValueAndReportsAbsence(t *testing.T) {
	store := Store{PlatformRoot: t.TempDir()}
	if _, present, err := store.Get("missing"); err != nil || present {
		t.Fatalf("absent secret: present=%v err=%v", present, err)
	}
	if err := store.Put("gateway.jwtSecret", "value=with=equals"); err != nil {
		t.Fatal(err)
	}
	value, present, err := store.Get("gateway.jwtSecret")
	if err != nil || !present || value != "value=with=equals" {
		t.Fatalf("value/present/err = %q / %v / %v", value, present, err)
	}
	if _, _, err := store.Get("bad=name"); err == nil {
		t.Fatal("an invalid name must be rejected")
	}
}
