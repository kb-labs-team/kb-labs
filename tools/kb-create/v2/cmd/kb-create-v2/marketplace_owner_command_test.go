package v2cli

import (
	"context"
	"strings"
	"testing"
)

// case: S-269.12
func TestMarketplaceOwnerMutationRequiresServerBoundRoot(t *testing.T) {
	if result, failure := executeMarketplaceOwnerMutation(context.Background(), "", strings.NewReader(`{"mutation":{"operation":"install","specs":["@kb-labs/example@1.0.0"]}}`)); failure == nil || result != nil {
		t.Fatalf("missing installation root = (%v, %v); want fail closed", result, failure)
	}
}

func TestMarketplaceOwnerMutationRejectsCallerSuppliedRootsAndUnknownFields(t *testing.T) {
	request := `{"platformRoot":"/attacker/root","runningRoot":"/attacker/running","mutation":{"operation":"install","specs":["@kb-labs/example@1.0.0"]}}`
	if result, failure := executeMarketplaceOwnerMutation(context.Background(), "/not-a-managed-install", strings.NewReader(request)); failure == nil || result != nil {
		t.Fatalf("caller-supplied roots = (%v, %v); want fail closed before touching a filesystem", result, failure)
	}
}

func TestMarketplaceOwnerMutationRejectsOversizedRequest(t *testing.T) {
	request := strings.Repeat("x", maxMarketplaceOwnerRequestBytes+1)
	if result, failure := executeMarketplaceOwnerMutation(context.Background(), "/not-a-managed-install", strings.NewReader(request)); failure == nil || result != nil {
		t.Fatalf("oversized request = (%v, %v); want fail closed", result, failure)
	}
}
