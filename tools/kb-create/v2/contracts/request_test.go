package contracts

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// case: S-039.4
func TestInstallRequestNormalizeReportsFieldAndCorrection(t *testing.T) {
	_, err := (InstallRequest{PlatformRoot: ""}).Normalize()
	var validation *RequestValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("Normalize() error = %T %v, want RequestValidationError", err, err)
	}
	if validation.Field != "platformRoot" || validation.Hint == "" || !strings.Contains(validation.Error(), "platformRoot") {
		t.Fatalf("validation error omitted field or correction: %#v", validation)
	}
}

func TestNormalizeMakesRelativeRootsAbsolute(t *testing.T) {
	projectRoot, err := os.MkdirTemp(".", ".relative-project-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(projectRoot)
	relativeProjectRoot, err := filepath.Rel(".", projectRoot)
	if err != nil {
		t.Fatal(err)
	}
	request, err := (InstallRequest{PlatformRoot: "./kb-platform", ProjectRoot: relativeProjectRoot}).Normalize()
	if err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{request.PlatformRoot, request.ProjectRoot} {
		if !filepath.IsAbs(root) {
			t.Fatalf("root is not absolute: %q", root)
		}
	}
}

func TestInstallRequestNormalizeCanonicalizesRelativeAndSymlinkPlatformRoots(t *testing.T) {
	base, err := os.MkdirTemp(".", ".platform-roots-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	target := filepath.Join(base, "platform")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(base, "platform-alias")
	absoluteTarget, err := filepath.Abs(target)
	if err != nil {
		t.Fatal(err)
	}
	absoluteAlias, err := filepath.Abs(alias)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(absoluteTarget, absoluteAlias); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(absoluteTarget)
	if err != nil {
		t.Fatal(err)
	}
	for name, root := range map[string]string{"relative": target, "symlink": absoluteAlias} {
		t.Run(name, func(t *testing.T) {
			rootInput := root
			if name == "relative" {
				rootInput, err = filepath.Rel(".", root)
				if err != nil {
					t.Fatal(err)
				}
			}
			request, err := (InstallRequest{PlatformRoot: rootInput}).Normalize()
			if err != nil {
				t.Fatalf("Normalize() error = %v", err)
			}
			if request.PlatformRoot != canonical {
				t.Fatalf("normalized platform root = %q, want canonical install root %q", request.PlatformRoot, canonical)
			}
		})
	}
}

func TestInstallRequestNormalizeDoesNotRequireSelectedProjectToExist(t *testing.T) {
	platformRoot := filepath.Join(t.TempDir(), "platform")
	missingProject := filepath.Join(t.TempDir(), "missing-project")
	request, err := (InstallRequest{PlatformRoot: platformRoot, ProjectRoot: missingProject}).Normalize()
	if err != nil {
		t.Fatalf("Normalize() rejected a canonical but missing project path: %v", err)
	}
	if request.ProjectRoot != missingProject {
		t.Fatalf("normalized project root = %q, want %q", request.ProjectRoot, missingProject)
	}
	if _, err := os.Stat(platformRoot); !os.IsNotExist(err) {
		t.Fatalf("request normalization created platform root: stat error = %v", err)
	}
}

func TestInstallRequestNormalizeAcceptsNpmOnlyMarketplaceMirror(t *testing.T) {
	request, err := (InstallRequest{
		PlatformRoot:       "/tmp/platform",
		MarketplaceSources: &MarketplaceSources{NpmURL: "http://verdaccio:4873"},
	}).Normalize()
	if err != nil {
		t.Fatalf("Normalize() rejected an npm-only Marketplace mirror: %v", err)
	}
	if request.MarketplaceSources == nil || request.MarketplaceSources.NpmURL != "http://verdaccio:4873" {
		t.Fatalf("MarketplaceSources = %#v, want npm mirror retained", request.MarketplaceSources)
	}
}

// case: S-187.7
func TestValidateProjectSelectionRejectsMissingProjectBeforePlatformMutation(t *testing.T) {
	platformRoot := filepath.Join(t.TempDir(), "platform")
	missingProject := filepath.Join(t.TempDir(), "missing-project")
	_, err := ValidateProjectSelection(missingProject)
	var validation *RequestValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("Normalize() error = %T %v, want RequestValidationError", err, err)
	}
	commands, parseErr := ParseShellCommands(strings.TrimSuffix(strings.TrimPrefix(validation.Hint, "Create it with `"), "` or pass an existing project directory, then retry."))
	want := []string{"mkdir", "-p", missingProject}
	if validation.Field != "projectRoot" || parseErr != nil || len(commands) != 1 || !reflect.DeepEqual(commands[0], want) {
		t.Fatalf("validation error = %#v, want actionable projectRoot input error", validation)
	}
	if _, err := os.Stat(platformRoot); !os.IsNotExist(err) {
		t.Fatalf("request validation created platform root: stat error = %v", err)
	}
}

// case: S-187.10
func TestValidateProjectSelectionPreservesAbsoluteLexicalSymlinkSpelling(t *testing.T) {
	target := t.TempDir()
	alias := filepath.Join(t.TempDir(), "project-alias")
	if err := os.Symlink(target, alias); err != nil {
		t.Fatal(err)
	}
	selected, err := ValidateProjectSelection(alias)
	if err != nil {
		t.Fatal(err)
	}
	if selected != filepath.Clean(alias) {
		t.Fatalf("selected path = %q, want lexical absolute spelling %q", selected, filepath.Clean(alias))
	}
}

func TestInstallRequestNormalizeDefaultsToSafeCIContract(t *testing.T) {
	request, err := (InstallRequest{PlatformRoot: t.TempDir()}).Normalize()
	if err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if request.Schema != RequestSchema || request.Platform.Channel != ChannelStable || request.Policy != PolicyStrict || request.Source != SourceRegistry {
		t.Fatalf("unexpected defaults: %#v", request)
	}
}

func TestInstallRequestRejectsAmbiguousOrDuplicatePins(t *testing.T) {
	_, err := (InstallRequest{
		PlatformRoot: t.TempDir(),
		Platform:     VersionSelector{Version: "2.1.0", Channel: ChannelCanary},
	}).Normalize()
	if err == nil {
		t.Fatal("expected platform version/channel conflict")
	}

	_, err = (InstallRequest{
		PlatformRoot: t.TempDir(),
		Plugins:      []ComponentRequest{{ID: "review"}, {ID: "review"}},
	}).Normalize()
	if err == nil {
		t.Fatal("expected duplicate plugin error")
	}
}

func TestInstallRequestRejectsRemovedUpgradeSafePolicy(t *testing.T) {
	_, err := (InstallRequest{PlatformRoot: t.TempDir(), Policy: CompatibilityPolicy("upgrade-safe")}).Normalize()
	if err == nil {
		t.Fatal("upgrade-safe must not be accepted as an alias")
	}
}

func TestInstallRequestNormalizesAndValidatesGatewayURL(t *testing.T) {
	request, err := (InstallRequest{PlatformRoot: t.TempDir(), GatewayURL: "http://127.0.0.1:4100/"}).Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if request.GatewayURL != "http://127.0.0.1:4100" {
		t.Fatalf("GatewayURL = %q", request.GatewayURL)
	}
	for _, address := range []string{"https://127.0.0.1:4100", "http://example.com:4100", "http://127.0.0.1", "http://127.0.0.1:4100/path"} {
		if _, err := (InstallRequest{PlatformRoot: t.TempDir(), GatewayURL: address}).Normalize(); err == nil {
			t.Fatalf("Normalize accepted invalid GatewayURL %q", address)
		}
	}
}

func TestInstallRequestSortsComponentsAndRedactsSecretValues(t *testing.T) {
	request, err := (InstallRequest{
		PlatformRoot: t.TempDir(),
		Plugins:      []ComponentRequest{{ID: "workflow"}, {ID: "commit"}},
		SecretInputs: []string{"adapter.llm.apiKey", "adapter.llm.apiKey"},
		Values:       map[string]string{"adapter.llm.apiKey": "must-not-be-here"},
	}).Normalize()
	if err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if request.Plugins[0].ID != "commit" || len(request.SecretInputs) != 1 {
		t.Fatalf("request was not normalized: %#v", request)
	}
	if _, leaked := request.Values[request.SecretInputs[0]]; leaked {
		t.Fatal("secret input leaked into non-secret Values")
	}
}
