package contracts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"

	clikitresult "github.com/kb-labs/clikit/result"
)

const machineResultDir = "../../../../core/platform/contracts/ux-result"

type machineResult struct {
	OK    *bool           `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error json.RawMessage `json:"error"`
	Meta  json.RawMessage `json:"meta"`
}

func machineResultFixtures(t *testing.T, kind string) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(machineResultDir, "fixtures", kind, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no %s machine-result fixtures found (err=%v)", kind, err)
	}
	sort.Strings(files)
	return files
}

func validateMachineResult(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for field := range fields {
		if field != "ok" && field != "data" && field != "error" && field != "meta" {
			return fmt.Errorf("unknown machine-result field %q", field)
		}
	}
	var result machineResult
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return err
	}
	if result.OK == nil {
		return fmt.Errorf("machine result is missing ok")
	}
	if *result.OK {
		if len(result.Data) == 0 || len(result.Error) != 0 {
			return fmt.Errorf("success result must contain data and omit error")
		}
		if len(result.Meta) != 0 && !isJSONObject(result.Meta) {
			return fmt.Errorf("meta must be an object")
		}
		return nil
	}
	if len(result.Error) == 0 || len(result.Data) != 0 {
		return fmt.Errorf("failure result must contain error and omit data")
	}
	return clikitresult.ValidateMachineResult(data)
}

func isJSONObject(data []byte) bool {
	var value map[string]json.RawMessage
	return json.Unmarshal(data, &value) == nil && value != nil
}

// case: S-203.1, S-203.2
func TestMachineResultSchemaAndSharedFixtures(t *testing.T) {
	// The fixture tests and clikit result validator mirror the schema's
	// closed success/failure branches and its reference to ErrorEnvelope.
	var schema struct {
		OneOf []struct {
			Ref string `json:"$ref"`
		} `json:"oneOf"`
		Defs map[string]json.RawMessage `json:"$defs"`
	}
	schemaBytes, err := os.ReadFile(filepath.Join(machineResultDir, "machine-result.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(schemaBytes, &schema); err != nil {
		t.Fatalf("decode machine-result schema: %v", err)
	}
	if len(schema.OneOf) != 2 || schema.OneOf[0].Ref != "#/$defs/success" || schema.OneOf[1].Ref != "#/$defs/failure" {
		t.Fatalf("schema does not define the success and failure branches: %+v", schema.OneOf)
	}
	if len(schema.Defs["success"]) == 0 || len(schema.Defs["failure"]) == 0 {
		t.Fatal("schema is missing a success or failure definition")
	}

	for _, file := range machineResultFixtures(t, "valid") {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if err := validateMachineResult(data); err != nil {
			t.Errorf("valid fixture %s rejected: %v", file, err)
		}
	}
	for _, file := range machineResultFixtures(t, "invalid") {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if err := validateMachineResult(data); err == nil {
			t.Errorf("invalid fixture %s accepted", file)
		}
	}
}
