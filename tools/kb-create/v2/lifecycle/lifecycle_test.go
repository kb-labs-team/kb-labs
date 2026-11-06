package lifecycle

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
)

func TestMutateRestoresReceiptAndConfigWhenVerificationFails(t *testing.T) {
	root := t.TempDir()
	if err := receipt.Write(root, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before"}); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, ".kb", "kb.config.jsonc")
	if err := os.WriteFile(config, []byte("before"), 0o600); err != nil {
		t.Fatal(err)
	}
	packageRestored := false
	snapshots := filepath.Join(root, "snapshots")
	snapshot, err := Mutate(root, root, snapshots, time.Unix(2, 0), func() error { return os.WriteFile(config, []byte("after"), 0o600) }, func() error { return errors.New("readiness failed") }, func(contracts.ResolvedInstallPlan, contracts.ResolvedInstallPlan) error {
		packageRestored = true
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "restored snapshot "+snapshot.ID) {
		t.Fatalf("err = %v", err)
	}
	if data, _ := os.ReadFile(config); string(data) != "before" {
		t.Fatalf("config = %q", data)
	}
	if !packageRestored {
		t.Fatal("package restore was not invoked")
	}
	active, readErr := receipt.Read(root)
	if readErr != nil || active.ID != "before" {
		t.Fatalf("receipt = %#v, %v", active, readErr)
	}
}

func TestRollbackRestoresNamedSnapshot(t *testing.T) {
	root := t.TempDir()
	if err := receipt.Write(root, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before"}); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, ".kb", "kb.config.jsonc")
	if err := os.WriteFile(config, []byte("before"), 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := receipt.CreateSnapshot(root, filepath.Join(root, "snapshots"), time.Unix(3, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config, []byte("after"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Rollback(root, filepath.Join(root, "snapshots"), snapshot.ID, nil); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(config); string(data) != "before" {
		t.Fatalf("config = %q", data)
	}
}

func TestRollbackPassesSavedPlanToPackageRestore(t *testing.T) {
	root := t.TempDir()
	previous := contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "saved", Plan: contracts.ResolvedInstallPlan{ReleaseCatalog: []byte(`{"digest":"saved"}`)}}
	if err := receipt.Write(root, previous); err != nil {
		t.Fatal(err)
	}
	snapshots := filepath.Join(root, "snapshots")
	snapshot, err := receipt.CreateSnapshot(root, snapshots, time.Unix(4, 0))
	if err != nil {
		t.Fatal(err)
	}
	var restored contracts.ResolvedInstallPlan
	if _, err := Rollback(root, snapshots, snapshot.ID, func(plan, _ contracts.ResolvedInstallPlan) error { restored = plan; return nil }); err != nil {
		t.Fatal(err)
	}
	var actual, expected any
	if err := json.Unmarshal(restored.ReleaseCatalog, &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(previous.Plan.ReleaseCatalog, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("saved catalog = %s", restored.ReleaseCatalog)
	}
}

// case: S-284.20
func TestRollbackCarriesOutgoingAndSavedReleasePlans(t *testing.T) {
	root := t.TempDir()
	saved := contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "saved", Plan: contracts.ResolvedInstallPlan{PlanHash: "saved-plan"}}
	if err := receipt.Write(root, saved); err != nil {
		t.Fatal(err)
	}
	snapshots := filepath.Join(root, "snapshots")
	snapshot, err := receipt.CreateSnapshot(root, snapshots, time.Unix(5, 0))
	if err != nil {
		t.Fatal(err)
	}
	current := contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "current", Plan: contracts.ResolvedInstallPlan{PlanHash: "current-plan"}}
	if err := receipt.Write(root, current); err != nil {
		t.Fatal(err)
	}
	_, err = Rollback(root, snapshots, snapshot.ID, func(target, previous contracts.ResolvedInstallPlan) error {
		if target.PlanHash != saved.Plan.PlanHash || previous.PlanHash != current.Plan.PlanHash {
			t.Fatalf("target=%s previous=%s", target.PlanHash, previous.PlanHash)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
