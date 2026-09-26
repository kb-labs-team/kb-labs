package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"testing"

	"github.com/kb-labs/create/v2/contracts/internal/catalogen"
)

// The envelope schema, the error catalog and the shared fixtures live next to
// the TS implementation (core/platform); both sides test against the same
// files so a drift on either side fails a test.
const sharedDir = "../../../../core/platform/src/error-envelope"

type catalogFile struct {
	Codes []struct {
		Code      string        `json:"code"`
		Area      ErrorArea     `json:"area"`
		Stage     ErrorStage    `json:"stage"`
		Severity  ErrorSeverity `json:"severity"`
		Retryable bool          `json:"retryable"`
		Message   string        `json:"message"`
		Hint      string        `json:"hint"`
	} `json:"codes"`
}

func loadCatalog(t *testing.T) catalogFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(sharedDir, "errors.catalog.json"))
	if err != nil {
		t.Fatalf("read shared catalog: %v", err)
	}
	var catalog catalogFile
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatalf("decode catalog: %v", err)
	}
	return catalog
}

func fixtureFiles(t *testing.T, kind string) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(sharedDir, "fixtures", kind, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no %s fixtures found (err=%v)", kind, err)
	}
	sort.Strings(files)
	return files
}

func decodeStrict(data []byte) (*LauncherError, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var value LauncherError
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return &value, nil
}

func TestValidFixturesRoundTripThroughLauncherError(t *testing.T) {
	for _, file := range fixtureFiles(t, "valid") {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		value, err := decodeStrict(data)
		if err != nil {
			t.Fatalf("%s: strict decode: %v", file, err)
		}
		if problems := value.Validate(); len(problems) != 0 {
			t.Fatalf("%s: invalid: %v", file, problems)
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var want, got map[string]any
		if err := json.Unmarshal(data, &want); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(encoded, &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(want, got) {
			t.Fatalf("%s: round trip changed the envelope\nwant %v\ngot  %v", file, want, got)
		}
	}
}

func TestInvalidFixturesAreRejected(t *testing.T) {
	for _, file := range fixtureFiles(t, "invalid") {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		value, err := decodeStrict(data)
		if err != nil {
			continue // rejected at decode time (unknown field)
		}
		if len(value.Validate()) == 0 {
			t.Fatalf("%s: expected the envelope to be rejected", file)
		}
	}
}

func TestLauncherErrorSerialisesCompleteEnvelope(t *testing.T) {
	err := NewLauncherError(CodeInputRequired, "required input is missing", "pass --input", errors.New("no file"))
	err.Actions = []ErrorAction{{ID: "retry", Label: "Retry", Command: "kb-create apply"}}
	err.Details = map[string]string{"requirement": "openai.key"}
	data, marshalErr := json.Marshal(err)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	var got map[string]any
	if unmarshalErr := json.Unmarshal(data, &got); unmarshalErr != nil {
		t.Fatal(unmarshalErr)
	}
	for key, want := range map[string]any{"code": "KB_INSTALL_INPUT_REQUIRED", "area": "install", "stage": "resolve", "severity": "error", "retryable": false, "cause": "no file"} {
		if got[key] != want {
			t.Fatalf("%s = %v, want %v", key, got[key], want)
		}
	}
	if problems := err.Validate(); len(problems) != 0 {
		t.Fatalf("Validate: %v", problems)
	}
	// A value (not pointer) serialises identically, so embedding is safe.
	byValue, _ := json.Marshal(*err)
	if !bytes.Equal(byValue, data) {
		t.Fatalf("value and pointer encodings differ")
	}
}

func TestLauncherErrorDerivesAreaWithoutExplicitField(t *testing.T) {
	data, _ := json.Marshal(&LauncherError{Code: CodeServiceGraphMismatch, Stage: StageVerify, Message: "m", Hint: "h"})
	var got map[string]any
	_ = json.Unmarshal(data, &got)
	if got["area"] != "install" || got["severity"] != "error" {
		t.Fatalf("area/severity not derived: %v", got)
	}
	if AreaForCode("KB_ADAPTER_NOT_CONFIGURED") != AreaPlugin || AreaForCode("COMMIT_NOTHING_STAGED") != AreaProduct {
		t.Fatal("unexpected area for adapter/product codes")
	}
}

// TestGeneratedCodeTableIsFresh fails when codes_gen.go was not regenerated
// after errors.catalog.json changed (run `go generate ./contracts`).
func TestGeneratedCodeTableIsFresh(t *testing.T) {
	data, err := os.ReadFile(catalogen.CatalogPath)
	if err != nil {
		t.Fatal(err)
	}
	want, err := catalogen.Render(data)
	if err != nil {
		t.Fatal(err)
	}
	have, err := os.ReadFile("codes_gen.go")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want, have) {
		t.Fatal("codes_gen.go is stale: run `go generate ./contracts` from tools/kb-create/v2")
	}
	if len(launcherCodes) != len(loadCatalog(t).Codes) {
		t.Fatal("launcherCodes does not cover the catalog")
	}
}

func TestCatalogCodesAreUniqueAndHaveHints(t *testing.T) {
	catalog := loadCatalog(t)
	seen := map[string]bool{}
	for _, entry := range catalog.Codes {
		if seen[entry.Code] {
			t.Fatalf("duplicate catalog code %s", entry.Code)
		}
		seen[entry.Code] = true
		if entry.Hint == "" || entry.Message == "" {
			t.Fatalf("%s needs a message and a hint", entry.Code)
		}
		sample := &LauncherError{Code: entry.Code, Stage: entry.Stage, Message: entry.Message, Hint: entry.Hint}
		if problems := sample.Validate(); len(problems) != 0 {
			t.Fatalf("%s: %v", entry.Code, problems)
		}
		if AreaForCode(entry.Code) != entry.Area {
			t.Fatalf("%s: area %s does not match its code prefix", entry.Code, entry.Area)
		}
	}
}

// TestEmittedCodesAreKnown makes sure no launcher source uses a KB_INSTALL_
// literal that the code table (and therefore the catalog) does not know.
func TestEmittedCodesAreKnown(t *testing.T) {
	literal := regexp.MustCompile(`"(KB_INSTALL_[A-Z_]+)"`)
	for _, source := range []string{"../cmd/kb-create-v2/main.go", "../cmd/kb-create-release-index/main.go"} {
		data, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range literal.FindAllSubmatch(data, -1) {
			if _, ok := LookupCode(string(match[1])); !ok {
				t.Fatalf("%s uses unknown code %s; add it to the catalog and launcherCodes", source, match[1])
			}
		}
	}
	for _, code := range []string{CodeIncompatibleComponents, CodeProviderUnresolved, CodeProviderAmbiguous, CodeInputRequired, CodeConfigRequired, CodeArtifactMismatch, CodeServiceGraphMismatch} {
		if _, ok := LookupCode(code); !ok {
			t.Fatalf("%s missing from launcher table", code)
		}
	}
}
