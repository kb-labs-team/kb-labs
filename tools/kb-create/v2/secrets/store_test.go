package secrets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
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

func secretsFile(t *testing.T, root string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, ".kb", "v2", "secrets.env"))
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if key, value, ok := strings.Cut(line, "="); ok {
			values[key] = value
		}
	}
	return values
}

func gatewaySecretPatches() []contracts.ConfigPatch {
	return []contracts.ConfigPatch{
		{Path: "/gateway/access/mode", JSON: `"secured"`, Owner: "manifest:gateway.access.mode"},
		{Owner: "manifest:gateway.jwtSecret", Environment: "GATEWAY_JWT_SECRET", Services: []string{"gateway"}},
		{Owner: "manifest:gateway.bootstrap.password", Environment: "GATEWAY_BOOTSTRAP_ADMIN_PASSWORD", Services: []string{"gateway"}},
	}
}

// A secret must be reachable under the environment variable name the generated
// service env references (kb-dev resolves ${GATEWAY_JWT_SECRET} by that name),
// not only under its requirement ID — whatever put it in the store.
func TestBindEnvironmentsAddsTheBoundEnvironmentKey(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	// As the wizard (or --secret-env) leaves them: keyed by requirement ID only.
	if err := store.Put("gateway.jwtSecret", "jwt-value"); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("gateway.bootstrap.password", "admin-value"); err != nil {
		t.Fatal(err)
	}
	if err := store.BindEnvironments(gatewaySecretPatches()); err != nil {
		t.Fatal(err)
	}
	got := secretsFile(t, root)
	want := map[string]string{
		"gateway.jwtSecret":                "jwt-value",
		"GATEWAY_JWT_SECRET":               "jwt-value",
		"gateway.bootstrap.password":       "admin-value",
		"GATEWAY_BOOTSTRAP_ADMIN_PASSWORD": "admin-value",
	}
	if len(got) != len(want) {
		t.Fatalf("stored keys = %v, want %v", got, want)
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("%s = %q, want %q (all: %v)", key, got[key], value, got)
		}
	}
	if exists, err := store.Exists("gateway.jwtSecret"); err != nil || !exists {
		t.Fatalf("requirement ID must stay verifiable: %v / %v", exists, err)
	}
}

func TestBindEnvironmentsIsIdempotentAndSkipsWhatIsNotThere(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	if err := store.Put("gateway.jwtSecret", "jwt-value"); err != nil {
		t.Fatal(err)
	}
	patches := append(gatewaySecretPatches(),
		// bound to an env equal to its own ID: nothing to add
		contracts.ConfigPatch{Owner: "manifest:OPENAI_API_KEY", Environment: "OPENAI_API_KEY", Services: []string{"gateway"}},
		// a non-secret patch that happens to carry no environment
		contracts.ConfigPatch{Path: "/x", JSON: `1`, Owner: "platform"},
	)
	for i := 0; i < 2; i++ {
		if err := store.BindEnvironments(patches); err != nil {
			t.Fatal(err)
		}
	}
	got := secretsFile(t, root)
	// gateway.bootstrap.password was never provided: no alias is invented for it.
	if len(got) != 2 || got["gateway.jwtSecret"] != "jwt-value" || got["GATEWAY_JWT_SECRET"] != "jwt-value" {
		t.Fatalf("stored keys = %v", got)
	}
}

func TestBindEnvironmentsRejectsConflictingValuesForOneVariable(t *testing.T) {
	store := Store{PlatformRoot: t.TempDir()}
	_ = store.Put("a.secret", "one")
	_ = store.Put("b.secret", "two")
	patches := []contracts.ConfigPatch{
		{Owner: "manifest:a.secret", Environment: "SHARED_ENV", Services: []string{"gateway"}},
		{Owner: "manifest:b.secret", Environment: "SHARED_ENV", Services: []string{"gateway"}},
	}
	if err := store.BindEnvironments(patches); err == nil {
		t.Fatal("two different values for one environment variable must be rejected, not silently last-write-wins")
	}
	_ = store.Put("b.secret", "one")
	if err := store.BindEnvironments(patches); err != nil {
		t.Fatalf("identical values are not a conflict: %v", err)
	}
}
