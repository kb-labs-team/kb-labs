package wizard

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/flow"
	"github.com/kb-labs/create/v2/scenario"
	"github.com/kb-labs/create/v2/secrets"
)

func gatewaySource(t *testing.T) catalog.Catalog {
	t.Helper()
	source, err := catalog.Seal(catalog.Catalog{
		Channels:  map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform", Profiles: map[string]contracts.ServiceGraph{"default": {}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return source
}

func storedSecrets(t *testing.T, root string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, ".kb", "v2", "secrets.env"))
	if os.IsNotExist(err) {
		return map[string]string{}
	}
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

// custom: channel, profile, Studio access, then (secured only) email, password + confirmation, signing secret.
func runCustom(t *testing.T, root, input string) (contracts.InstallRequest, string, error) {
	t.Helper()
	var output bytes.Buffer
	request, err := RequestScenario(gatewaySource(t), root, "custom", IO{In: bytes.NewBufferString(input), Out: &output})
	return request, output.String(), err
}

func TestSecuredJourneyStoresTypedAndGeneratedSecretsAndNeverEchoesThem(t *testing.T) {
	root := t.TempDir()
	const password = "Sup3r-secret-pw"
	request, output, err := runCustom(t, root, "\n\nsecured\nadmin@example.com\n\n"+password+"\n"+password+"\n\n")
	if err != nil {
		t.Fatal(err)
	}

	if got := strings.Join(request.SecretInputs, ","); got != "gateway.bootstrap.password,gateway.jwtSecret" {
		t.Fatalf("secret inputs = %v", request.SecretInputs)
	}
	if request.Values["gateway.access.mode"] != `"secured"` || request.Values["gateway.bootstrap.adminEmail"] != `"admin@example.com"` {
		t.Fatalf("values = %#v", request.Values)
	}

	stored := storedSecrets(t, root)
	if stored["gateway.bootstrap.password"] != password {
		t.Fatalf("typed password not stored: %v", stored)
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(stored["gateway.jwtSecret"]) {
		t.Fatalf("a blank signing secret must be generated as 256-bit hex, got %q", stored["gateway.jwtSecret"])
	}

	// The values exist in exactly one place: the private store.
	serialized, _ := json.Marshal(request)
	for name, secret := range stored {
		if strings.Contains(output, secret) {
			t.Fatalf("%s leaked to the terminal output", name)
		}
		if strings.Contains(string(serialized), secret) {
			t.Fatalf("%s leaked into the request", name)
		}
	}
	if !strings.Contains(output, "generated a random value") {
		t.Fatalf("the user is told the secret was generated:\n%s", output)
	}
	info, err := os.Stat(filepath.Join(root, ".kb", "v2", "secrets.env"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("secret store must be private: %v / %v", info, err)
	}
}

func TestSecuredJourneyWithBlankPasswordSkipsItButStillSecuresSessions(t *testing.T) {
	root := t.TempDir()
	request, output, err := runCustom(t, root, "\n\nsecured\n\n\n\n\n")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(request.SecretInputs, ","); got != "gateway.jwtSecret" {
		t.Fatalf("only the generated signing secret is expected, got %v", request.SecretInputs)
	}
	if _, present := request.Values["gateway.bootstrap.adminEmail"]; present {
		t.Fatalf("a skipped email must not be emitted: %#v", request.Values)
	}
	stored := storedSecrets(t, root)
	if _, present := stored["gateway.bootstrap.password"]; present {
		t.Fatalf("a skipped password must not be stored: %v", stored)
	}
	if !strings.Contains(output, "skipped") {
		t.Fatalf("the user is told it was skipped:\n%s", output)
	}
}

func TestLocalJourneyAsksForNoAdminAndStoresNothing(t *testing.T) {
	root := t.TempDir()
	request, output, err := runCustom(t, root, "\n\nlocal\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(request.SecretInputs) != 0 {
		t.Fatalf("secret inputs = %v", request.SecretInputs)
	}
	if strings.Contains(output, "Admin") || strings.Contains(output, "signing") {
		t.Fatalf("admin questions must not appear for local access:\n%s", output)
	}
	if _, err := os.Stat(filepath.Join(root, ".kb", "v2", "secrets.env")); !os.IsNotExist(err) {
		t.Fatalf("no secret store is created for a local install: %v", err)
	}
}

func TestSecuredChoiceOnTheSamePageOpensTheAdminQuestions(t *testing.T) {
	// custom defaults to local; choosing secured must reveal the admin page.
	_, output, err := runCustom(t, t.TempDir(), "\n\nsecured\n\n\n\n\n")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Admin email", "Admin password", "Session signing secret"} {
		if !strings.Contains(output, want) {
			t.Fatalf("%q was never asked:\n%s", want, output)
		}
	}
}

func TestSecretsWithJSONSpecialCharactersRoundTrip(t *testing.T) {
	root := t.TempDir()
	const password = `pa"ss\wörd-🔑-1234`
	if _, _, err := runCustom(t, root, "\n\nsecured\n\n\n"+password+"\n"+password+"\n\n"); err != nil {
		t.Fatal(err)
	}
	if got := storedSecrets(t, root)["gateway.bootstrap.password"]; got != password {
		t.Fatalf("password = %q, want %q", got, password)
	}
}

func TestMismatchedConfirmationAndShortPasswordsAreReAskedNotFatal(t *testing.T) {
	root := t.TempDir()
	// 1st: entries differ; 2nd: too short (confirmation matches); 3rd: valid.
	input := "\n\nsecured\n\n\n" + "Aaaaaaaa1\nBbbbbbbb2\n" + "short\nshort\n" + "Valid-pass-1\nValid-pass-1\n" + "\n"
	request, output, err := runCustom(t, root, input)
	if err != nil {
		t.Fatalf("recoverable mistakes must not abort the journey: %v", err)
	}
	if storedSecrets(t, root)["gateway.bootstrap.password"] != "Valid-pass-1" || !contains(request.SecretInputs, "gateway.bootstrap.password") {
		t.Fatalf("stored = %v, inputs = %v", storedSecrets(t, root), request.SecretInputs)
	}
	for _, want := range []string{"do not match", "at least 8 characters"} {
		if !strings.Contains(output, want) {
			t.Fatalf("expected %q in output:\n%s", want, output)
		}
	}
	for _, leaked := range []string{"Aaaaaaaa1", "Bbbbbbb2", "short"} {
		if strings.Contains(strings.ReplaceAll(output, "at least 8 characters", ""), leaked+"\n") {
			t.Fatalf("rejected secret %q echoed", leaked)
		}
	}
}

func TestGivesUpAfterRepeatedBadSecretsAndStoresNothing(t *testing.T) {
	root := t.TempDir()
	input := "\n\nsecured\n\n\n" + "short\nshort\n" + "short\nshort\n" + "short\nshort\n"
	if _, _, err := runCustom(t, root, input); err == nil {
		t.Fatal("three invalid entries must fail the journey")
	}
	if got := storedSecrets(t, root); len(got) != 0 {
		t.Fatalf("a failed journey must not leave secrets behind: %v", got)
	}
}

func TestInjectedSecretReaderIsUsedForSecretsOnly(t *testing.T) {
	root := t.TempDir()
	var asked int
	var output bytes.Buffer
	_, err := RequestScenario(gatewaySource(t), root, "custom", IO{
		// Everything except secrets comes from In.
		In:  bytes.NewBufferString("\n\nsecured\nadmin@example.com\n\n"),
		Out: &output,
		ReadSecret: func() (string, error) {
			asked++
			switch asked {
			case 1, 2:
				return "Injected-pass-1", nil // entry + confirmation
			default:
				return "", nil // blank signing secret -> generated
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if asked != 3 {
		t.Fatalf("secret reader asked %d times, want 3 (password, confirmation, signing secret)", asked)
	}
	if storedSecrets(t, root)["gateway.bootstrap.password"] != "Injected-pass-1" {
		t.Fatalf("stored = %v", storedSecrets(t, root))
	}
}

func secretField(generate, required bool) scenario.Field {
	return scenario.Field{ID: "s", Requirement: "some.secret", Type: "string", Secret: true, Generate: generate, Required: required}
}

func newSession(t *testing.T, field scenario.Field) *flow.Session {
	t.Helper()
	session, err := flow.New(scenario.Scenario{Schema: scenario.Schema, ID: "t", Fields: []scenario.Field{field}}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	return &session
}

func TestAnAnsweredSecretIsRecordedInTheCallersSession(t *testing.T) {
	field := secretField(false, false)
	session := newSession(t, field)
	var output bytes.Buffer
	reader := bufio.NewReader(bytes.NewBufferString("value-1\nvalue-1\n"))
	value, skipped, err := askSecret(reader, IO{Out: &output}, session, field, "Secret")
	if err != nil || skipped || value != "value-1" {
		t.Fatalf("value/skipped/err = %q / %v / %v", value, skipped, err)
	}
	if _, answered := session.State.Answers["s"]; !answered {
		t.Fatal("the answer must be recorded in the caller's session (Compile derives SecretInputs from it)")
	}
}

func TestRequiredSecretCannotBeLeftBlank(t *testing.T) {
	field := secretField(false, true)
	reader := bufio.NewReader(bytes.NewBufferString("\n\n\n"))
	if _, _, err := askSecret(reader, IO{Out: &bytes.Buffer{}}, newSession(t, field), field, "Secret"); err == nil {
		t.Fatal("a required secret left blank three times must fail")
	}
}

func TestGeneratedSecretsAreRandomAndLongEnough(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		value, err := generateSecret()
		if err != nil || len(value) != 64 {
			t.Fatalf("value/err = %q / %v", value, err)
		}
		seen[value] = true
	}
	if len(seen) != 20 {
		t.Fatal("generated secrets must not repeat")
	}
}

func TestSecretsAreStoredUnderRequirementIDsThatTheLauncherVerifies(t *testing.T) {
	root := t.TempDir()
	if _, _, err := runCustom(t, root, "\n\nsecured\n\n\nPassw0rd-ok\nPassw0rd-ok\n\n"); err != nil {
		t.Fatal(err)
	}
	store := secrets.Store{PlatformRoot: root}
	for _, id := range []string{"gateway.bootstrap.password", "gateway.jwtSecret"} {
		if ok, err := store.Exists(id); err != nil || !ok {
			t.Fatalf("%s must be verifiable by the launcher: %v / %v", id, ok, err)
		}
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
