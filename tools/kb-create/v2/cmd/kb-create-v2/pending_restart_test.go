package v2cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/versionroot"
)

// case: S-313.3
func TestPendingRestartDetectsManagedGenerationSwitchAtSamePlatformVersion(t *testing.T) {
	root := filepath.Join(t.TempDir(), "install")
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	installationID, err := versionroot.InstallationIDForPath(stage)
	if err != nil {
		t.Fatal(err)
	}
	activeReceipt := contracts.InstallReceipt{
		Schema:         contracts.ReceiptSchema,
		ID:             "same-release-receipt",
		InstallationID: installationID,
		Plan: contracts.ResolvedInstallPlan{
			Request:      contracts.InstallRequest{PlatformRoot: stage},
			ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0", Services: []contracts.Service{{ID: "gateway"}}},
			PlanHash:     "same-release-plan",
		},
	}
	if err := receipt.Write(stage, activeReceipt); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.ActivateInitial(stage, "1.0.0", "same-release-plan"); err != nil {
		t.Fatal(err)
	}
	oldRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	stage, err = layout.StageManagedGeneration()
	if err != nil {
		t.Fatal(err)
	}
	newRoot, err := layout.ActivateManagedGeneration(stage, oldRoot, oldRoot)
	if err != nil {
		t.Fatal(err)
	}
	newReceipt, err := receipt.Read(newRoot)
	if err != nil {
		t.Fatal(err)
	}

	pending := pendingRestart(newReceipt, host.Status{
		State: host.StateRunning, ReceiptID: activeReceipt.ID, PlatformVersion: "1.0.0",
		TreeRoot: oldRoot, ServiceIDs: []string{"gateway"},
	}, root)
	if pending == nil {
		t.Fatal("same-release managed generation switch did not report pending restart")
	}
	if pending.InstalledVersion != "1.0.0" || pending.RunningGeneration != filepath.Base(oldRoot) ||
		pending.InstalledGeneration != filepath.Base(newRoot) || pending.Command == "" {
		t.Fatalf("pending restart after managed activation = %#v", pending)
	}
	message := renderPendingRestart(pending)
	if !strings.Contains(message, pending.InstalledGeneration) || !strings.Contains(message, pending.RunningGeneration) ||
		!strings.Contains(message, pending.Command) {
		t.Fatalf("human pending restart = %q", message)
	}

	if stillCurrent := pendingRestart(newReceipt, host.Status{
		State: host.StateRunning, ReceiptID: activeReceipt.ID, PlatformVersion: "1.0.0",
		TreeRoot: newRoot, ServiceIDs: []string{"gateway"},
	}, root); stillCurrent != nil {
		t.Fatalf("running host on active generation still reports pending restart: %#v", stillCurrent)
	}
}

// case: S-313.3
func TestStatusReportsPendingRestartAfterManagedGenerationCommit(t *testing.T) {
	inst := newInstallation(t)
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start host: %d %s", code, raw)
	}
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	runningRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageManagedGeneration()
	if err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(stage, ".kb", "marketplace.lock")
	if err := os.WriteFile(lock, []byte("managed candidate\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	installedRoot, err := layout.ActivateManagedGeneration(stage, runningRoot, runningRoot)
	if err != nil {
		t.Fatal(err)
	}

	_, code, raw := inst.run("status", "--json")
	if code != 0 {
		t.Fatalf("status after managed generation commit: %d %s", code, raw)
	}
	var status map[string]any
	if err := json.Unmarshal([]byte(raw), &status); err != nil {
		t.Fatalf("decode status: %v: %s", err, raw)
	}
	if payload, ok := status["data"].(map[string]any); ok {
		status = payload
	}
	pending, ok := status["pendingRestart"].(map[string]any)
	command, _ := pending["command"].(string)
	if !ok || pending["installedGeneration"] != filepath.Base(installedRoot) ||
		pending["runningGeneration"] != filepath.Base(runningRoot) || !strings.Contains(command, "restart") {
		t.Fatalf("status pending restart = %#v; expected active and running generations plus restart command; status=%#v", status["pendingRestart"], status)
	}
	if status["running"] != true || status["reachable"] != true {
		t.Fatalf("old physical root stopped or became unhealthy after active switch: %#v", status)
	}

	if _, code, raw := inst.run("restart", "--json"); code != 0 {
		t.Fatalf("restart into managed generation: %d %s", code, raw)
	}
	_, code, raw = inst.run("status", "--json")
	if code != 0 {
		t.Fatalf("status after restart: %d %s", code, raw)
	}
	if err := json.Unmarshal([]byte(raw), &status); err != nil {
		t.Fatalf("decode status after restart: %v: %s", err, raw)
	}
	if payload, ok := status["data"].(map[string]any); ok {
		status = payload
	}
	if status["running"] != true || status["reachable"] != true || status["pendingRestart"] != nil {
		t.Fatalf("status after restarting into active generation = %#v", status)
	}
	runner, err := host.NewRecordedRunner(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	runningStatus, err := runner.Status(context.Background())
	if err != nil || filepath.Clean(runningStatus.TreeRoot) != filepath.Clean(installedRoot) {
		t.Fatalf("restarted host root = %q, err=%v; want active %q", runningStatus.TreeRoot, err, installedRoot)
	}
}
