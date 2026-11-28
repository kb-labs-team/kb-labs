package transport

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

// case: PC-001.20
func TestDecodeRequestAcceptsCLIPlanEnvelopeAsRequestOnly(t *testing.T) {
	root := t.TempDir()
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	input := map[string]any{
		"ok": true,
		"data": map[string]any{"plan": map[string]any{
			"request":       contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root, GatewayURL: "http://127.0.0.1:45100"},
			"artifacts":     []any{map[string]any{"package": "attacker-controlled"}},
			"configPatches": []any{map[string]any{"path": "/arbitrary/path", "json": `"unsafe"`}},
		}},
	}
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request, err := DecodeRequest(data)
	if err != nil {
		t.Fatal(err)
	}
	if request.PlatformRoot != canonicalRoot || request.GatewayURL != "http://127.0.0.1:45100" {
		t.Fatalf("request = %#v", request)
	}
	if len(request.Values) != 0 || request.MarketplaceSources != nil {
		t.Fatalf("saved plan operations leaked into request: %#v", request)
	}
}
