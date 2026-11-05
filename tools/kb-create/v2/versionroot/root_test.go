package versionroot

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
	"time"
)

func initialLayout(t *testing.T, root, version string) (Layout, string) {
	t.Helper()
	layout, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	writeReceipt(t, stage, version, "receipt-"+version)
	active, err := layout.ActivateInitial(stage, version, "plan-"+version)
	if err != nil {
		t.Fatal(err)
	}
	active, err = layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	return layout, active
}

func TestExistingPlatformRootHasOnlyNotInstalledOrValidatedStates(t *testing.T) {
	for _, target := range []string{"missing", "empty", "foreign", "installed"} {
		t.Run(target, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "install")
			switch target {
			case "empty":
				if err := os.MkdirAll(root, 0o700); err != nil {
					t.Fatal(err)
				}
			case "foreign":
				if err := os.MkdirAll(root, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "foreign.txt"), []byte("owned by user"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "installed":
				initialLayout(t, root, "1.0.0")
			}
			layout, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			resolved, err := layout.ExistingPlatformRoot()
			if target == "missing" || target == "empty" {
				if !errors.Is(err, ErrPlatformNotInstalled) || resolved != "" {
					t.Fatalf("not-installed resolution = %q, %v", resolved, err)
				}
				return
			}
			if target == "foreign" {
				if err == nil || resolved != "" {
					t.Fatalf("foreign target resolution = %q, %v", resolved, err)
				}
				return
			}
			if err != nil || resolved != layout.PlatformRoot() {
				t.Fatalf("installed resolution = %q, %v; want %q", resolved, err, layout.PlatformRoot())
			}
		})
	}
}

func TestForPlatformPathResolvesInstallContainerFromEveryActiveRootSpelling(t *testing.T) {
	root := filepath.Join(t.TempDir(), "install")
	layout, active := initialLayout(t, root, "1.0.0")
	for _, spelling := range []string{root, layout.PlatformRoot(), active} {
		resolved, err := ForPlatformPath(spelling)
		if err != nil || resolved.InstallRoot() != layout.InstallRoot() {
			t.Fatalf("ForPlatformPath(%q) = %q, %v; want install root %q", spelling, resolved.InstallRoot(), err, layout.InstallRoot())
		}
		if err := resolved.Validate(); err != nil {
			t.Fatalf("validated path %q failed layout validation: %v", spelling, err)
		}
	}
}

// case: S-024.7
func TestRollbackSnapshotSurvivesVersionRootPruning(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	layout, v1 := initialLayout(t, root, "1.0.0")
	snapshot, err := receipt.CreateSnapshot(v1, layout.SnapshotsDir(), time.Unix(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := layout.RecordHealthy(); err != nil {
		t.Fatal(err)
	}
	v2 := stageVersion(t, layout, "2.0.0")
	if _, err := layout.Activate(v2, "2.0.0", "plan-2", ""); err != nil {
		t.Fatal(err)
	}
	if err := layout.RecordHealthy(); err != nil {
		t.Fatal(err)
	}
	if err := layout.Retain(""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(v1); !os.IsNotExist(err) {
		t.Fatalf("old version root was not pruned: %v", err)
	}
	if got, err := receipt.ReadSnapshot(layout.SnapshotsDir(), snapshot.ID); err != nil || got.ID != snapshot.ID {
		t.Fatalf("snapshot after old-root prune = %#v, %v", got, err)
	}
}

// case: S-023.10, S-024.6
func TestPlatformDataSurvivesUpdateAndRollback(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	layout, v1 := initialLayout(t, root, "1.0.0")
	if err := layout.RecordHealthy(); err != nil {
		t.Fatal(err)
	}
	projection := contracts.PlatformDataRootPath()
	dataRoot, err := layout.SharedRuntimePath(projection.PlatformPath)
	if err != nil {
		t.Fatal(err)
	}
	write := func(name, value string) string {
		t.Helper()
		path := filepath.Join(dataRoot, name)
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	beforeUpdate := write("before-update", "written before staging")
	v2 := stageVersion(t, layout, "2.0.0")
	duringStage := write("during-stage", "written after staging and before switch")
	v2Active, err := layout.Activate(v2, "2.0.0", "plan-2", "")
	if err != nil {
		t.Fatal(err)
	}
	afterSwitch := write("after-switch", "written after switch")
	if active, err := layout.Active(); err != nil || active == v1 {
		t.Fatalf("active version after update = %q, %v; want updated root", active, err)
	}
	restored, err := layout.RestorePrevious()
	if err != nil || restored != v1 {
		t.Fatalf("restored root = %q, %v; want %q", restored, err, v1)
	}
	if active, err := layout.Active(); err != nil || active != v1 {
		t.Fatalf("active root after rollback = %q, %v; want %q", active, err, v1)
	}
	for path, want := range map[string]string{
		beforeUpdate: "written before staging",
		duringStage:  "written after staging and before switch",
		afterSwitch:  "written after switch",
	} {
		if got, err := os.ReadFile(path); err != nil || string(got) != want {
			t.Errorf("platform data %q = %q, %v; want %q", path, got, err, want)
		}
	}
	projectedData := filepath.Join(v2Active, filepath.FromSlash(projection.PlatformPath))
	info, err := os.Lstat(projectedData)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("version root platform data projection = %#v, %v; want shared-state symlink", info, err)
	}
}

func writeReceipt(t *testing.T, root, version, id string) {
	t.Helper()
	installationID, err := InstallationIDForPath(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := receipt.Write(root, contracts.InstallReceipt{ID: id, InstallationID: installationID,
		Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{PlatformRoot: root},
			ServiceGraph: contracts.ServiceGraph{PlatformVersion: version}, PlanHash: "plan-" + version}}); err != nil {
		t.Fatal(err)
	}
}

func TestInitialLayoutAndRepeatedActivationRetainLastHealthyRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	layout, v1 := initialLayout(t, root, "1.0.0")
	if err := layout.RecordHealthy(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(v1, "marker"), []byte("v1"), 0o600); err != nil {
		t.Fatal(err)
	}
	v2 := stageVersion(t, layout, "2.0.0")
	if _, err := layout.Activate(v2, "2.0.0", "plan-2", ""); err != nil {
		t.Fatal(err)
	}
	v2Active, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(v1, ".kb", "logs", "post-update.log"), []byte("runtime log survives pruning"), 0o600); err != nil {
		t.Fatal(err)
	}
	v3 := stageVersion(t, layout, "3.0.0")
	if _, err := layout.Activate(v3, "3.0.0", "plan-3", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(v1); err != nil {
		t.Fatalf("last healthy root was pruned: %v", err)
	}
	if _, err := os.Stat(v2Active); !os.IsNotExist(err) {
		t.Fatalf("never-started intermediate root remains: %s (%v)", v2Active, err)
	}
	if target, err := layout.Active(); err != nil || target == v1 {
		t.Fatalf("active root = %s, %v", target, err)
	}
	recovery, err := layout.RecoveryRoot()
	if err != nil || recovery != v1 {
		t.Fatalf("recovery root = %s, %v; want last healthy %s", recovery, err, v1)
	}
	retained, err := layout.Retained("")
	if err != nil || len(retained) != 2 {
		t.Fatalf("retained roots = %#v, %v; want active and last healthy", retained, err)
	}
	if err := layout.RecordHealthy(); err != nil {
		t.Fatal(err)
	}
	if err := layout.Retain(""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(v1); !os.IsNotExist(err) {
		t.Fatalf("last healthy root survived the new version's successful health check: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(layout.PlatformRoot(), ".kb", "logs", "post-update.log")); err != nil || string(data) != "runtime log survives pruning" {
		t.Fatalf("runtime log after prune = %q, %v", data, err)
	}
}

func stageVersion(t *testing.T, layout Layout, version string) string {
	t.Helper()
	stage, err := layout.Stage()
	if err != nil {
		t.Fatal(err)
	}
	writeReceipt(t, stage, version, "receipt-"+version)
	return stage
}

func TestActivationRefusalLeavesActiveRootUntouched(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	layout, active := initialLayout(t, root, "1.0.0")
	marker := filepath.Join(active, "marker")
	if err := os.WriteFile(marker, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	occupied := filepath.Join(layout.VersionsDir(), versionKey("2.0.0", "plan-2"))
	if err := os.MkdirAll(occupied, 0o700); err != nil {
		t.Fatal(err)
	}
	stage := stageVersion(t, layout, "2.0.0")
	if _, err := layout.Activate(stage, "2.0.0", "plan-2", ""); err == nil {
		t.Fatal("activation unexpectedly replaced an existing version root")
	}
	if got, err := os.ReadFile(marker); err != nil || string(got) != "original" {
		t.Fatalf("active marker = %q, %v", got, err)
	}
}

// case: S-223.6
func TestActivationRejectsEveryDeclaredSharedRuntimeProjectionInStagedTree(t *testing.T) {
	for _, shared := range contracts.SharedRuntimeProjections() {
		t.Run(shared.PlatformPath, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "platform")
			layout, active := initialLayout(t, root, "1.0.0")
			stage := stageVersion(t, layout, "2.0.0")
			conflict := filepath.Join(stage, filepath.FromSlash(shared.PlatformPath))
			if shared.Kind == "directory" {
				if err := os.MkdirAll(conflict, 0o700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.MkdirAll(filepath.Dir(conflict), 0o700); err != nil {
				t.Fatal(err)
			} else if err := os.WriteFile(conflict, []byte("unexpected shared state"), 0o600); err != nil {
				t.Fatal(err)
			}
			currentBefore, err := os.Readlink(layout.PlatformRoot())
			if err != nil {
				t.Fatal(err)
			}
			metadataBefore, err := os.ReadFile(layout.metadataPath())
			if err != nil {
				t.Fatal(err)
			}
			receiptBefore, err := os.ReadFile(receipt.Path(active))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := layout.Activate(stage, "2.0.0", "plan-2", ""); err == nil || !strings.Contains(err.Error(), shared.PlatformPath) {
				t.Fatalf("activation error = %v, want conflict at %s", err, shared.PlatformPath)
			}
			currentAfter, err := os.Readlink(layout.PlatformRoot())
			if err != nil || currentAfter != currentBefore {
				t.Fatalf("current changed from %q to %q: %v", currentBefore, currentAfter, err)
			}
			metadataAfter, err := os.ReadFile(layout.metadataPath())
			if err != nil || !bytes.Equal(metadataAfter, metadataBefore) {
				t.Fatalf("layout metadata changed before activation refusal: %v", err)
			}
			receiptAfter, err := os.ReadFile(receipt.Path(active))
			if err != nil || !bytes.Equal(receiptAfter, receiptBefore) {
				t.Fatalf("active receipt changed before activation refusal: %v", err)
			}
			if resolved, err := layout.Active(); err != nil || resolved != active {
				t.Fatalf("active root = %q, %v; want %q", resolved, err, active)
			}
			if _, err := os.Stat(stage); err != nil {
				t.Fatalf("rejected stage was unexpectedly removed: %v", err)
			}
			if err := os.RemoveAll(conflict); err != nil {
				t.Fatal(err)
			}
			if _, err := layout.Activate(stage, "2.0.0", "plan-2", ""); err != nil {
				t.Fatalf("activation after correcting staged tree: %v", err)
			}
		})
	}
}

// case: S-223.1
func TestHandoffCrashBoundariesKeepCompleteActiveAndRecoveryRoots(t *testing.T) {
	points := []HandoffPoint{HandoffMetadataWritten, HandoffTargetFinalized, HandoffLinkPrepared, HandoffLinkSwitched}
	for _, point := range points {
		t.Run(string(point), func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "platform")
			layout, v1 := initialLayout(t, root, "1.0.0")
			if err := layout.RecordHealthy(); err != nil {
				t.Fatal(err)
			}
			stage := stageVersion(t, layout, "2.0.0")
			crash := errors.New("simulated process termination")
			_, err := layout.activate(stage, "2.0.0", "plan-2", "", nil, func(current HandoffPoint) error {
				if current == point {
					return crash
				}
				return nil
			})
			if !errors.Is(err, crash) {
				t.Fatalf("activation error = %v, want injected crash", err)
			}
			if _, err := os.Stat(root); err != nil {
				t.Fatalf("stable root is absent after handoff point %s: %v", point, err)
			}
			if err := layout.Validate(); err != nil {
				t.Fatalf("active root is incomplete after handoff point %s: %v", point, err)
			}
			recovery, err := layout.RecoveryRoot()
			if err != nil || recovery != v1 {
				t.Fatalf("recovery root = %s, %v; want %s", recovery, err, v1)
			}
			if _, err := os.Stat(recovery); err != nil {
				t.Fatalf("recorded recovery root is missing: %v", err)
			}
		})
	}
}

func TestUpdateActivationFailuresAfterLinkSwitchRestorePriorVersionAndMetadata(t *testing.T) {
	points := CrashPoints()
	start := -1
	for index, point := range points {
		if point == HandoffBeforeActiveRootSync {
			start = index
			break
		}
	}
	if start < 0 || start >= len(points) {
		t.Fatalf("post-switch activation handoffs are missing from CrashPoints(): %v", points)
	}
	points = points[start:]
	for _, point := range points {
		t.Run(string(point), func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "platform")
			layout, v1 := initialLayout(t, root, "1.0.0")
			if err := layout.RecordHealthy(); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(v1, "transaction-marker"), []byte("version-one"), 0o600); err != nil {
				t.Fatal(err)
			}
			treeBefore := snapshotVersionrootTree(t, v1)
			if err := layout.writeUpdateMetadata(UpdateMetadata{SnapshotID: "prior-snapshot", LogPath: "prior.log"}); err != nil {
				t.Fatal(err)
			}
			metadataBefore, err := os.ReadFile(layout.updateMetadataPath())
			if err != nil {
				t.Fatal(err)
			}
			stage := stageVersion(t, layout, "2.0.0")
			target := filepath.Join(layout.VersionsDir(), versionKey("2.0.0", "plan-2"))
			injected := errors.New("injected post-switch activation failure")
			_, err = layout.activate(stage, "2.0.0", "plan-2", "", &UpdateMetadata{SnapshotID: "new-snapshot"}, func(current HandoffPoint) error {
				if current == point {
					return injected
				}
				return nil
			})
			if !errors.Is(err, injected) {
				t.Fatalf("activation error = %v, want injected failure", err)
			}
			active, err := layout.Active()
			if err != nil || active != v1 {
				t.Fatalf("active version = %q, %v; want %q", active, err, v1)
			}
			installed, err := receipt.Read(active)
			if err != nil || installed.ID != "receipt-1.0.0" {
				t.Fatalf("restored receipt = %#v, %v", installed, err)
			}
			marker, err := os.ReadFile(filepath.Join(v1, "transaction-marker"))
			if err != nil || string(marker) != "version-one" {
				t.Fatalf("prior version tree marker = %q, %v", marker, err)
			}
			if treeAfter := snapshotVersionrootTree(t, v1); !equalVersionrootSnapshots(treeAfter, treeBefore) {
				t.Fatalf("prior version tree changed during failed activation: before=%v after=%v", treeBefore, treeAfter)
			}
			metadataAfter, err := os.ReadFile(layout.updateMetadataPath())
			if err != nil || !bytes.Equal(metadataAfter, metadataBefore) {
				t.Fatalf("recovery metadata changed: before=%q after=%q error=%v", metadataBefore, metadataAfter, err)
			}
			if _, err := os.Lstat(target); !os.IsNotExist(err) {
				t.Fatalf("failed activation left finalized target %q: %v", target, err)
			}
		})
	}
}

func TestCrashPointsEnumeratesEveryProducedHandoff(t *testing.T) {
	layout, err := New(filepath.Join(t.TempDir(), "platform"))
	if err != nil {
		t.Fatal(err)
	}
	var observed []HandoffPoint
	record := func(point HandoffPoint) error {
		observed = append(observed, point)
		return nil
	}
	stage, err := layout.stageInitial(record)
	if err != nil {
		t.Fatal(err)
	}
	writeReceipt(t, stage, "1.0.0", "enumeration-initial")
	if _, err := layout.activateInitial(stage, "1.0.0", "enumeration-initial", record); err != nil {
		t.Fatal(err)
	}
	if err := layout.RecordHealthy(); err != nil {
		t.Fatal(err)
	}
	stage, err = layout.stage(record)
	if err != nil {
		t.Fatal(err)
	}
	writeReceipt(t, stage, "2.0.0", "enumeration-update")
	if _, err := layout.activate(stage, "2.0.0", "enumeration-update", "", &UpdateMetadata{SnapshotID: "enumeration"}, record); err != nil {
		t.Fatal(err)
	}
	if points := CrashPoints(); !reflect.DeepEqual(points, observed) {
		t.Fatalf("CrashPoints() = %v, observed handoff producers = %v", points, observed)
	}
}

func TestUpdateActiveLinkSwitchIOFailureRestoresPriorVersion(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	layout, v1 := initialLayout(t, root, "1.0.0")
	stage := stageVersion(t, layout, "2.0.0")
	_, err := layout.activate(stage, "2.0.0", "plan-2", "", nil, func(point HandoffPoint) error {
		if point == HandoffLinkPrepared {
			return os.Remove(filepath.Join(layout.InstallerStateDir(), "current-next"))
		}
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "switch active version") {
		t.Fatalf("activation error = %v, want actual active-link rename failure", err)
	}
	active, err := layout.Active()
	if err != nil || active != v1 {
		t.Fatalf("active version = %q, %v; want %q after actual link switch I/O failure", active, err, v1)
	}
	installed, err := receipt.Read(active)
	if err != nil || installed.ID != "receipt-1.0.0" {
		t.Fatalf("restored receipt = %#v, %v", installed, err)
	}
}

// case: S-223.1
func TestInitialHandoffLeavesOnlyCompleteInstallTreesAtEachBoundary(t *testing.T) {
	points := []HandoffPoint{HandoffInitialMetadataWritten, HandoffInitialTargetFinalized, HandoffInitialLinkPrepared, HandoffInitialLinkSwitched}
	for _, point := range points {
		t.Run(string(point), func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "platform")
			layout, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			stage, err := layout.StageInitial()
			if err != nil {
				t.Fatal(err)
			}
			writeReceipt(t, stage, "1.0.0", "receipt-1")
			crash := errors.New("simulated process termination")
			_, err = layout.activateInitial(stage, "1.0.0", "plan-1", func(current HandoffPoint) error {
				if current == point {
					return crash
				}
				return nil
			})
			if !errors.Is(err, crash) {
				t.Fatalf("initial activation error = %v, want injected crash", err)
			}
			if point == HandoffInitialLinkSwitched {
				if err := layout.Validate(); err != nil {
					t.Fatalf("completed initial link is incomplete: %v", err)
				}
			} else if point == HandoffInitialMetadataWritten {
				if _, err := receipt.Read(stage); err != nil {
					t.Fatalf("pre-move staged install tree is incomplete: %v", err)
				}
			} else {
				if _, err := os.Lstat(layout.PlatformRoot()); !os.IsNotExist(err) {
					t.Fatalf("pre-link current entry exists: %v", err)
				}
				entries, readErr := os.ReadDir(layout.VersionsDir())
				if readErr != nil || len(entries) == 0 {
					t.Fatalf("complete staged installation is not recoverable: %v", readErr)
				}
				found := false
				for _, entry := range entries {
					if strings.HasPrefix(entry.Name(), "1.0.0-") {
						_, readErr := receipt.Read(filepath.Join(layout.VersionsDir(), entry.Name()))
						found = readErr == nil
					}
				}
				if !found {
					t.Fatal("version directory has no complete initial receipt")
				}
			}
		})
	}
}

func TestInterruptedInitialActivationResumesFromTheInstallContainer(t *testing.T) {
	for _, point := range []HandoffPoint{HandoffInitialMetadataWritten, HandoffInitialTargetFinalized, HandoffInitialLinkPrepared} {
		t.Run(string(point), func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "install")
			layout, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			stage, err := layout.StageInitial()
			if err != nil {
				t.Fatal(err)
			}
			writeReceipt(t, stage, "1.0.0", "receipt-1")
			crash := errors.New("simulated interruption")
			_, err = layout.activateInitial(stage, "1.0.0", "plan-1", func(current HandoffPoint) error {
				if current == point {
					return crash
				}
				return nil
			})
			if !errors.Is(err, crash) {
				t.Fatalf("activation error = %v, want interruption", err)
			}
			if err := layout.ValidateInitialTarget(); err != nil {
				t.Fatalf("validate interrupted install: %v", err)
			}
			if point == HandoffInitialMetadataWritten {
				retry, err := layout.StageInitial()
				if err != nil {
					t.Fatalf("restart initial staging: %v", err)
				}
				writeReceipt(t, retry, "1.0.0", "receipt-1-retry")
				if _, err := layout.ActivateInitial(retry, "1.0.0", "plan-1-retry"); err != nil {
					t.Fatalf("complete retried install: %v", err)
				}
			}
			if err := layout.Validate(); err != nil {
				t.Fatalf("resumed current link does not resolve to a complete version: %v", err)
			}
		})
	}
}

func TestInterruptedInitialRecoveryRefusesInvalidProvenanceWithoutMutation(t *testing.T) {
	for name, corrupt := range map[string]func(*testing.T, Layout){
		"mismatched owner": func(t *testing.T, layout Layout) {
			owner, err := layout.readOwnership()
			if err != nil {
				t.Fatal(err)
			}
			owner.InstallationID = "ffeeddccbbaa99887766554433221100"
			data, err := json.Marshal(owner)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(layout.ownershipPath(), data, 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"completed ownership state": func(t *testing.T, layout Layout) {
			owner, err := layout.readOwnership()
			if err != nil {
				t.Fatal(err)
			}
			owner.InitialInstallState = "complete"
			data, err := json.Marshal(owner)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(layout.ownershipPath(), data, 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"foreign root entry": func(t *testing.T, layout Layout) {
			if err := os.WriteFile(filepath.Join(layout.Root, "foreign.txt"), []byte("user bytes\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			layout := interruptedFinalizedInitialInstall(t)
			corrupt(t, layout)
			before := snapshotLayoutTarget(t, layout.Root)
			if err := layout.ValidateInitialTarget(); err == nil {
				t.Fatal("recovery accepted a target without valid provenance and declared entries")
			}
			if after := snapshotLayoutTarget(t, layout.Root); !bytes.Equal(after, before) {
				t.Fatalf("refused recovery target changed: before=%q after=%q", before, after)
			}
		})
	}
}

func interruptedFinalizedInitialInstall(t *testing.T) Layout {
	t.Helper()
	layout, err := New(filepath.Join(t.TempDir(), "platform"))
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	writeReceipt(t, stage, "1.0.0", "receipt-1")
	crash := errors.New("simulated interruption after finalizing the staged version")
	if _, err := layout.activateInitial(stage, "1.0.0", "plan-1", func(point HandoffPoint) error {
		if point == HandoffInitialTargetFinalized {
			return crash
		}
		return nil
	}); !errors.Is(err, crash) {
		t.Fatalf("initial activation error = %v, want injected interruption", err)
	}
	return layout
}

func TestInitialTargetRefusesSymlinkedAndWrongTypedOwnedEntries(t *testing.T) {
	for name, setup := range map[string]func(*testing.T, Layout, string){
		"state symlink": func(t *testing.T, layout Layout, outside string) {
			if err := os.RemoveAll(layout.SharedStateDir()); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, layout.SharedStateDir()); err != nil {
				t.Fatal(err)
			}
		},
		"nested scenario symlink": func(t *testing.T, layout Layout, outside string) {
			target := filepath.Join(layout.SharedStateDir(), "scenarios")
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, target); err != nil {
				t.Fatal(err)
			}
		},
		"state wrong type": func(t *testing.T, layout Layout, _ string) {
			if err := os.RemoveAll(layout.SharedStateDir()); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(layout.SharedStateDir(), []byte("not a directory"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "platform")
			layout, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			if err := layout.PrepareInitialTarget(); err != nil {
				t.Fatal(err)
			}
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.Mkdir(outside, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(outside, "keep.txt"), []byte("external bytes\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			outsideBefore := snapshotLayoutTarget(t, outside)
			setup(t, layout, outside)
			before := snapshotLayoutTarget(t, root)
			if err := layout.ValidateInitialTarget(); err == nil {
				t.Fatal("symlinked or wrong-typed declared entry was accepted")
			}
			if after := snapshotLayoutTarget(t, root); !bytes.Equal(after, before) {
				t.Fatalf("refused root changed: before=%q after=%q", before, after)
			}
			if after := snapshotLayoutTarget(t, outside); !bytes.Equal(after, outsideBefore) {
				t.Fatalf("external target changed: before=%q after=%q", outsideBefore, after)
			}
		})
	}
}

func TestPackageManagerStateAllowsPnpmProjectSymlinks(t *testing.T) {
	t.Run("project target inside install root is accepted", func(t *testing.T) {
		layout, _ := initialLayout(t, filepath.Join(t.TempDir(), "platform"), "1.0.0")
		target := filepath.Join(layout.PackageManagerStateDir(), "projects", "fixture")
		if err := os.MkdirAll(target, 0o700); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(layout.PackageManagerStateDir(), "pnpm", "store", "projects", "project")
		if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		if err := layout.ValidateStructure(); err != nil {
			t.Fatalf("package-manager project symlink with an in-root target was rejected: %v", err)
		}
	})

	t.Run("project target outside install root is rejected", func(t *testing.T) {
		layout, _ := initialLayout(t, filepath.Join(t.TempDir(), "platform"), "1.0.0")
		target := filepath.Join(t.TempDir(), "project")
		if err := os.MkdirAll(target, 0o700); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(layout.PackageManagerStateDir(), "pnpm", "store", "projects", "project")
		if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		if err := layout.ValidateStructure(); err == nil || !strings.Contains(err.Error(), "package-manager symlink target escapes install root") {
			t.Fatalf("ValidateStructure error = %v, want named package-manager symlink escape diagnostic", err)
		}
	})
}

func TestInitialTargetRefusesVersionLinksThatEscapeTheContainer(t *testing.T) {
	layout, err := New(filepath.Join(t.TempDir(), "platform"))
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(t.TempDir(), "external-version-state")
	if err := os.Mkdir(external, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(external, "keep.txt")
	if err := os.WriteFile(marker, []byte("external version bytes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(stage, ".kb", "data")
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, link); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	rootBefore := snapshotLayoutTarget(t, layout.Root)
	if err := layout.ValidateInitialTarget(); err == nil {
		t.Fatal("version projection escaping the install root was accepted")
	}
	if after := snapshotLayoutTarget(t, layout.Root); !bytes.Equal(after, rootBefore) {
		t.Fatalf("refused version-link target changed: before=%q after=%q", rootBefore, after)
	}
	if after, err := os.ReadFile(marker); err != nil || string(after) != string(before) {
		t.Fatalf("external version state changed: before=%q after=%q error=%v", before, after, err)
	}
}

func TestInstalledStructureRefusesSymlinkedContainerDirectories(t *testing.T) {
	for _, name := range []string{"state", "versions"} {
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "platform")
			layout, active := initialLayout(t, root, "1.0.0")
			outside := filepath.Join(t.TempDir(), name)
			if name == "state" {
				if err := os.Rename(layout.SharedStateDir(), outside); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, layout.SharedStateDir()); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Rename(layout.VersionsDir(), outside); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, layout.VersionsDir()); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := os.Stat(active); err != nil {
				t.Fatalf("test fixture active root disappeared: %v", err)
			}
			rootBefore := snapshotLayoutTarget(t, root)
			if err := layout.Validate(); err == nil {
				t.Fatalf("Validate accepted symlinked %s container directory", name)
			}
			if after := snapshotLayoutTarget(t, root); !bytes.Equal(after, rootBefore) {
				t.Fatalf("refused symlinked %s root changed: before=%q after=%q", name, rootBefore, after)
			}
		})
	}
}

func TestInitialOwnershipRecordAloneProvesInterruptedFirstInstall(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	owner := []byte("{\"schema\":\"kb.create.installation-owner/v1\",\"installationId\":\"00112233445566778899aabbccddeeff\",\"initialInstallState\":\"in-progress\"}\n")
	if err := os.WriteFile(filepath.Join(root, "ownership.json"), owner, 0o600); err != nil {
		t.Fatal(err)
	}
	layout, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := layout.ValidateInitialTarget(); err != nil {
		t.Fatalf("single complete ownership write was not recoverable: %v", err)
	}
}

func TestInitialProvenanceWriteHasOneRecoverableBoundary(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	layout, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	crash := errors.New("simulated process termination after ownership write")
	if _, err := layout.stageInitial(func(point HandoffPoint) error {
		if point == HandoffInitialOwnershipWritten {
			return crash
		}
		return nil
	}); !errors.Is(err, crash) {
		t.Fatalf("stage error = %v, want injected termination at the ownership-write boundary", err)
	}
	if _, err := os.Lstat(layout.InstallerStateDir()); !os.IsNotExist(err) {
		t.Fatalf("provenance created a second record outside the ownership entry: %v", err)
	}
	if err := layout.ValidateInitialTarget(); err != nil {
		t.Fatalf("single ownership record did not prove the interrupted first install: %v", err)
	}
	if _, err := layout.StageInitial(); err != nil {
		t.Fatalf("retry after the ownership-write boundary failed: %v", err)
	}
}

func TestInitialTargetRefusesEmptyAndTruncatedOwnershipUnchanged(t *testing.T) {
	for name, contents := range map[string][]byte{"empty": {}, "truncated": []byte(`{"schema":"kb.create.installation-owner/v1"}`)} {
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "platform")
			if err := os.Mkdir(root, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "ownership.json"), contents, 0o600); err != nil {
				t.Fatal(err)
			}
			layout, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			before := snapshotLayoutTarget(t, root)
			if err := layout.ValidateInitialTarget(); err == nil {
				t.Fatal("unverifiable ownership record was accepted")
			}
			if after := snapshotLayoutTarget(t, root); !bytes.Equal(after, before) {
				t.Fatalf("unverifiable ownership record changed: before=%q after=%q", before, after)
			}
		})
	}
}

func TestOwnershipStagingCrashBoundaries(t *testing.T) {
	points := []OwnershipWritePoint{OwnershipBeforeStagingCreate, OwnershipAfterStagingCreate,
		OwnershipDuringStagingWrite, OwnershipAfterStagingSync, OwnershipAfterPublish, OwnershipAfterStagingCleanup}
	for _, point := range points {
		t.Run(string(point), func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "platform")
			if err := os.Mkdir(root, 0o700); err != nil {
				t.Fatal(err)
			}
			layout, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			crash := fmt.Errorf("simulated process termination at %s", point)
			previous := ownershipWriteFaultHook
			ownershipWriteFaultHook = func(actual OwnershipWritePoint, _ string) error {
				if actual == point {
					return crash
				}
				return nil
			}
			writeErr := layout.PrepareInitialTarget()
			ownershipWriteFaultHook = previous
			if !errors.Is(writeErr, crash) {
				t.Fatalf("write error = %v, want injected termination at %s", writeErr, point)
			}
			if point == OwnershipBeforeStagingCreate {
				if err := layout.ValidateInitialTarget(); err != nil {
					t.Fatalf("pre-create crash did not leave a fresh target: %v", err)
				}
				if entries, err := os.ReadDir(root); err != nil || len(entries) != 0 {
					t.Fatalf("pre-create crash left entries %v, %v", entries, err)
				}
				return
			}
			if point == OwnershipAfterStagingCreate || point == OwnershipDuringStagingWrite || point == OwnershipAfterStagingSync {
				before := snapshotLayoutTarget(t, root)
				var stagingErr *OwnershipStagingArtifactError
				if err := layout.ValidateInitialTarget(); !errors.As(err, &stagingErr) {
					t.Fatalf("unpublished staging was not diagnosed specifically: %v", err)
				}
				if !strings.Contains(stagingErr.Error(), stagingErr.Path) {
					t.Fatalf("diagnosis does not name staging path: %v", stagingErr)
				}
				if after := snapshotLayoutTarget(t, root); !bytes.Equal(after, before) {
					t.Fatalf("unpublished staging changed during diagnosis: before=%q after=%q", before, after)
				}
				return
			}
			if err := layout.ValidateInitialTarget(); err != nil {
				t.Fatalf("published canonical ownership did not recover: %v", err)
			}
			if _, err := layout.readOwnership(); err != nil {
				t.Fatalf("complete ownership record unavailable after %s: %v", point, err)
			}
			entries, err := os.ReadDir(root)
			if err != nil || len(entries) != 1 || entries[0].Name() != filepath.Base(layout.ownershipPath()) {
				t.Fatalf("ownership recovery left staging artifacts: entries=%v error=%v", entries, err)
			}
		})
	}
}

func TestInitialTargetRefusesForgedAndCompleteUnpublishedOwnershipStagingUnchanged(t *testing.T) {
	for _, name := range []string{"forged", "complete"} {
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "platform")
			if err := os.Mkdir(root, 0o700); err != nil {
				t.Fatal(err)
			}
			layout, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			owner := Ownership{Schema: OwnershipSchema, InstallationID: "00112233445566778899aabbccddeeff", InitialInstallState: "in-progress"}
			data, err := json.Marshal(owner)
			if err != nil {
				t.Fatal(err)
			}
			if name == "complete" {
				data = append(data, '\n')
			} else {
				data = []byte(`{"schema":"kb.create.installation-owner/v1","installationId":"00112233445566778899aabbccddeeff","initialInstallState":"in-progress"}`)
			}
			stage := contracts.OwnershipRecordStagingPath(root, owner.InstallationID)
			if err := os.WriteFile(stage, data, 0o600); err != nil {
				t.Fatal(err)
			}
			before := snapshotLayoutTarget(t, root)
			var stagingErr *OwnershipStagingArtifactError
			if err := layout.ValidateInitialTarget(); !errors.As(err, &stagingErr) {
				t.Fatalf("unpublished ownership staging was not refused specifically: %v", err)
			}
			if _, err := os.Lstat(layout.ownershipPath()); !os.IsNotExist(err) {
				t.Fatalf("unpublished staging created canonical ownership: %v", err)
			}
			if after := snapshotLayoutTarget(t, root); !bytes.Equal(after, before) {
				t.Fatalf("unpublished staging changed: before=%q after=%q", before, after)
			}
		})
	}
}

func TestInitialTargetCleansOnlyValidatedSameInodeOwnershipStaging(t *testing.T) {
	for _, mode := range []string{"same-inode", "different-inode", "extra-hardlink"} {
		t.Run(mode, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "platform")
			if err := os.Mkdir(root, 0o700); err != nil {
				t.Fatal(err)
			}
			layout, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			owner := Ownership{Schema: OwnershipSchema, InstallationID: "00112233445566778899aabbccddeeff", InitialInstallState: "in-progress"}
			data, err := json.Marshal(owner)
			if err != nil {
				t.Fatal(err)
			}
			data = append(data, '\n')
			if err := os.WriteFile(layout.ownershipPath(), data, 0o600); err != nil {
				t.Fatal(err)
			}
			stage := contracts.OwnershipRecordStagingPath(root, owner.InstallationID)
			if mode == "same-inode" || mode == "extra-hardlink" {
				if err := os.Link(layout.ownershipPath(), stage); err != nil {
					t.Fatal(err)
				}
				if mode == "extra-hardlink" {
					if err := os.Link(layout.ownershipPath(), filepath.Join(t.TempDir(), "extra-link")); err != nil {
						t.Fatal(err)
					}
				}
			} else if err := os.WriteFile(stage, data, 0o600); err != nil {
				t.Fatal(err)
			}
			before := snapshotLayoutTarget(t, root)
			err = layout.ValidateInitialTarget()
			if mode == "same-inode" {
				if err != nil {
					t.Fatalf("validated same-inode staging was not cleaned: %v", err)
				}
				if _, err := os.Lstat(stage); !os.IsNotExist(err) {
					t.Fatalf("same-inode staging remains: %v", err)
				}
				return
			}
			var stagingErr *OwnershipStagingArtifactError
			if !errors.As(err, &stagingErr) {
				t.Fatalf("unproven staging was not refused: %v", err)
			}
			if after := snapshotLayoutTarget(t, root); !bytes.Equal(after, before) {
				t.Fatalf("unproven staging changed: before=%q after=%q", before, after)
			}
		})
	}
}

type recordingOwnershipFile struct {
	file  ownershipFile
	steps *[]string
}

func (f recordingOwnershipFile) Write(data []byte) (int, error) {
	*f.steps = append(*f.steps, "write")
	return f.file.Write(data)
}

func (f recordingOwnershipFile) Sync() error {
	*f.steps = append(*f.steps, "sync")
	return f.file.Sync()
}

func (f recordingOwnershipFile) Close() error { return f.file.Close() }

type recordingOwnershipFilesystem struct {
	base  ownershipFileSystem
	steps []string
}

func (f *recordingOwnershipFilesystem) CreateExclusive(path string, mode fs.FileMode) (ownershipFile, error) {
	f.steps = append(f.steps, "create")
	file, err := f.base.CreateExclusive(path, mode)
	if err != nil {
		return nil, err
	}
	return recordingOwnershipFile{file: file, steps: &f.steps}, nil
}

func (f *recordingOwnershipFilesystem) Link(oldPath, newPath string) error {
	f.steps = append(f.steps, "link")
	return f.base.Link(oldPath, newPath)
}

func (f *recordingOwnershipFilesystem) SyncDirectory(path string) error {
	f.steps = append(f.steps, "dir-sync")
	return f.base.SyncDirectory(path)
}

func (f *recordingOwnershipFilesystem) Remove(path string) error {
	f.steps = append(f.steps, "unlink")
	return f.base.Remove(path)
}

func TestOwnershipPublicationSyncsInDurableOrder(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	layout, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	previous := ownershipFS
	recorder := &recordingOwnershipFilesystem{base: previous}
	ownershipFS = recorder
	t.Cleanup(func() { ownershipFS = previous })
	if err := layout.PrepareInitialTarget(); err != nil {
		t.Fatal(err)
	}
	want := []string{"create", "write", "write", "sync", "link", "dir-sync", "unlink", "dir-sync"}
	if !reflect.DeepEqual(recorder.steps, want) {
		t.Fatalf("ownership filesystem operation order = %v, want %v", recorder.steps, want)
	}
}

func withOwnershipWriteHook(t *testing.T, hook func(OwnershipWritePoint, string) error) {
	t.Helper()
	previous := ownershipWriteFaultHook
	ownershipWriteFaultHook = hook
	t.Cleanup(func() { ownershipWriteFaultHook = previous })
}

func TestConcurrentFirstOwnershipPublicationHasOneWinner(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	first, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	readyToPublish := make(chan struct{}, 2)
	releasePublish := make(chan struct{})
	withOwnershipWriteHook(t, func(point OwnershipWritePoint, _ string) error {
		if point == OwnershipBeforePublish {
			readyToPublish <- struct{}{}
			<-releasePublish
		}
		return nil
	})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for _, id := range []string{"00112233445566778899aabbccddeeff", "ffeeddccbbaa99887766554433221100"} {
		owner := Ownership{Schema: OwnershipSchema, InstallationID: id, InitialInstallState: "in-progress"}
		data, err := json.Marshal(owner)
		if err != nil {
			t.Fatal(err)
		}
		data = append(data, '\n')
		stagingPath := contracts.OwnershipRecordStagingPath(root, id)
		if err := os.WriteFile(stagingPath, data, 0o600); err != nil {
			t.Fatal(err)
		}
		workers.Add(1)
		go func(stagingPath string) {
			defer workers.Done()
			results <- first.publishOwnershipStaging(stagingPath)
		}(stagingPath)
	}
	<-readyToPublish
	<-readyToPublish
	close(releasePublish)
	workers.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, ErrOwnershipPublicationConflict) {
			conflicts++
		} else {
			t.Fatalf("concurrent publication returned unexpected error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("publication results: %d winners, %d conflicts", successes, conflicts)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 || entries[0].Name() != filepath.Base(first.ownershipPath()) {
		t.Fatalf("loser left a staging file: entries=%v error=%v", entries, err)
	}
	if _, err := first.readOwnership(); err != nil {
		t.Fatalf("winning complete record is invalid: %v", err)
	}
}

func TestConcurrentInstallDoesNotDiagnoseLiveStagingAsAbandoned(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	layout, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	enteredWrite := make(chan struct{})
	releaseWrite := make(chan struct{})
	withOwnershipWriteHook(t, func(point OwnershipWritePoint, _ string) error {
		if point == OwnershipAfterStagingCreate {
			close(enteredWrite)
			<-releaseWrite
		}
		return nil
	})
	installResult := make(chan error, 1)
	go func() { installResult <- layout.PrepareInitialTarget() }()
	<-enteredWrite
	if err := layout.ValidateInitialTarget(); !errors.Is(err, ErrOwnershipPublicationConflict) {
		t.Fatalf("active staging was not reported as an operation conflict: %v", err)
	}
	close(releaseWrite)
	if err := <-installResult; err != nil {
		t.Fatalf("first install failed after releasing the staging barrier: %v", err)
	}
}

// case: PC-001.18
func TestEveryDeclaredCrashPointCanRetryInstallOrRemoveOwnedLayout(t *testing.T) {
	for _, point := range CrashPoints() {
		t.Run(string(point)+"/retry", func(t *testing.T) {
			layout := interruptAtPoint(t, point)
			if strings.HasPrefix(string(point), "initial-") {
				if err := layout.ValidateInitialTarget(); err != nil {
					t.Fatalf("recognize interrupted initial install: %v", err)
				}
				if _, activeErr := layout.Active(); activeErr == nil {
					if err := layout.Validate(); err != nil {
						t.Fatalf("recovered initial install is invalid: %v", err)
					}
					return
				}
				stage, err := layout.StageInitial()
				if err != nil {
					t.Fatalf("restart initial staging: %v", err)
				}
				writeReceipt(t, stage, "1.0.0", "receipt-retry")
				if _, err := layout.ActivateInitial(stage, "1.0.0", "retry-plan"); err != nil {
					t.Fatalf("activate retried initial install: %v", err)
				}
				if err := layout.Validate(); err != nil {
					t.Fatalf("retried initial install is invalid: %v", err)
				}
				return
			}
			if err := layout.Validate(); err != nil {
				t.Fatalf("active installation is invalid after interrupted update %s: %v", point, err)
			}
			stage, err := layout.Stage()
			if err != nil {
				t.Fatalf("restart update staging: %v", err)
			}
			writeReceipt(t, stage, "3.0.0", "receipt-retry")
			if _, err := layout.Activate(stage, "3.0.0", "retry-plan", ""); err != nil {
				t.Fatalf("activate retried update: %v", err)
			}
			if err := layout.Validate(); err != nil {
				t.Fatalf("retried update is invalid: %v", err)
			}
		})

		t.Run(string(point)+"/uninstall", func(t *testing.T) {
			layout := interruptAtPoint(t, point)
			foreign := filepath.Join(layout.InstallRoot(), "foreign.txt")
			if err := os.WriteFile(foreign, []byte("preserve me"), 0o600); err != nil {
				t.Fatal(err)
			}
			err := layout.RemoveOwned()
			if err != nil && layout.HasOwnershipMarker() {
				t.Fatalf("uninstall rejected an owned interrupted container: %v", err)
			}
			if got, readErr := os.ReadFile(foreign); readErr != nil || string(got) != "preserve me" {
				t.Fatalf("foreign entry changed during uninstall: %q, %v", got, readErr)
			}
			for _, entry := range contracts.OwnedInstallEntries() {
				if _, statErr := os.Lstat(filepath.Join(layout.InstallRoot(), entry)); statErr == nil {
					t.Fatalf("uninstall left owned entry %q at crash point %s", entry, point)
				}
			}
		})
	}
}

func TestPreActivationUpdateHandoffsLeaveSharedStateAndRunningVersionUntouched(t *testing.T) {
	for _, point := range CrashPoints() {
		if strings.HasPrefix(string(point), "initial-") || point == HandoffLinkSwitched {
			continue
		}
		t.Run(string(point), func(t *testing.T) {
			layout, active := initialLayout(t, filepath.Join(t.TempDir(), "install"), "1.0.0")
			if err := layout.RecordHealthy(); err != nil {
				t.Fatal(err)
			}
			shared := filepath.Join(layout.SharedStateDir(), "data", "shared.db")
			if err := os.MkdirAll(filepath.Dir(shared), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(shared, []byte("live data"), 0o600); err != nil {
				t.Fatal(err)
			}
			lock := filepath.Join(active, ".kb", "marketplace.lock")
			config := filepath.Join(active, ".kb", "kb.config.jsonc")
			for path, contents := range map[string]string{lock: "old packages", config: "old config"} {
				if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			stateBefore := snapshotVersionrootTree(t, layout.SharedStateDir())
			lockBefore, err := os.ReadFile(lock)
			if err != nil {
				t.Fatal(err)
			}
			configBefore, err := os.ReadFile(config)
			if err != nil {
				t.Fatal(err)
			}
			interrupt := errors.New("simulated interrupted update")
			var stage string
			if point == HandoffUpdateStageCreated || point == HandoffUpdateReceiptSeeded {
				stage, err = layout.stage(func(current HandoffPoint) error {
					if current == point {
						return interrupt
					}
					return nil
				})
			} else {
				stage, err = layout.Stage()
				if err == nil {
					writeReceipt(t, stage, "2.0.0", "receipt-2.0.0")
					_, err = layout.activate(stage, "2.0.0", "plan-2.0.0", active, &UpdateMetadata{SnapshotID: "crash-test"}, func(current HandoffPoint) error {
						if current == point {
							return interrupt
						}
						return nil
					})
				}
			}
			if !errors.Is(err, interrupt) {
				t.Fatalf("handoff at %s returned %v, want injected interruption", point, err)
			}
			if after := snapshotVersionrootTree(t, layout.SharedStateDir()); !equalVersionrootSnapshots(stateBefore, after) {
				t.Fatalf("shared state changed at %s: before=%#v after=%#v", point, stateBefore, after)
			}
			if got, readErr := os.ReadFile(lock); readErr != nil || string(got) != string(lockBefore) {
				t.Fatalf("running version lock changed at %s: %q, %v", point, got, readErr)
			}
			if got, readErr := os.ReadFile(config); readErr != nil || string(got) != string(configBefore) {
				t.Fatalf("running version config changed at %s: %q, %v", point, got, readErr)
			}
		})
	}
}

func snapshotVersionrootTree(t *testing.T, root string) map[string]string {
	t.Helper()
	snapshot := make(map[string]string)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		value := fmt.Sprintf("mode=%v;mtime=%d;size=%d", info.Mode(), info.ModTime().UnixNano(), info.Size())
		if info.Mode().IsRegular() {
			contents, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			value += ";bytes=" + string(contents)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			value += ";link=" + target
		}
		snapshot[relative] = value
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func equalVersionrootSnapshots(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for path, value := range left {
		if right[path] != value {
			return false
		}
	}
	return true
}

func interruptAtPoint(t *testing.T, point HandoffPoint) Layout {
	t.Helper()
	root := filepath.Join(t.TempDir(), "install")
	layout, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	crash := errors.New("simulated process termination")
	if strings.HasPrefix(string(point), "initial-") && point != HandoffInitialMetadataWritten && point != HandoffInitialTargetFinalized && point != HandoffInitialLinkPrepared && point != HandoffInitialLinkSwitched {
		_, err := layout.stageInitial(func(current HandoffPoint) error {
			if current == point {
				return crash
			}
			return nil
		})
		if !errors.Is(err, crash) {
			t.Fatalf("initial staging at %s returned %v", point, err)
		}
		return layout
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	writeReceipt(t, stage, "1.0.0", "receipt-initial")
	if strings.HasPrefix(string(point), "initial-") {
		_, err = layout.activateInitial(stage, "1.0.0", "initial-plan", func(current HandoffPoint) error {
			if current == point {
				return crash
			}
			return nil
		})
		if !errors.Is(err, crash) {
			t.Fatalf("initial activation at %s returned %v", point, err)
		}
		return layout
	}
	if _, err := layout.ActivateInitial(stage, "1.0.0", "initial-plan"); err != nil {
		t.Fatal(err)
	}
	if err := layout.RecordHealthy(); err != nil {
		t.Fatal(err)
	}
	if point == HandoffUpdateStageCreated || point == HandoffUpdateReceiptSeeded {
		_, err = layout.stage(func(current HandoffPoint) error {
			if current == point {
				return crash
			}
			return nil
		})
		if !errors.Is(err, crash) {
			t.Fatalf("update staging at %s returned %v", point, err)
		}
		return layout
	}
	stage, err = layout.Stage()
	if err != nil {
		t.Fatal(err)
	}
	writeReceipt(t, stage, "2.0.0", "receipt-update")
	_, err = layout.activate(stage, "2.0.0", "update-plan", "", &UpdateMetadata{SnapshotID: "crash-test"}, func(current HandoffPoint) error {
		if current == point {
			return crash
		}
		return nil
	})
	if !errors.Is(err, crash) {
		t.Fatalf("update activation at %s returned %v", point, err)
	}
	return layout
}

func TestRemoveOwnedRemovesStableLinkAndAllVersionRoots(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	layout, _ := initialLayout(t, root, "1.0.0")
	stage := stageVersion(t, layout, "2.0.0")
	if _, err := layout.Activate(stage, "2.0.0", "plan-2", ""); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(layout.VersionsDir())
	if err != nil || len(entries) != 2 {
		t.Fatalf("fixture must have two version roots: %d, %v", len(entries), err)
	}
	if err := layout.RemoveOwned(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(root); !os.IsNotExist(err) {
		t.Fatalf("stable root remains after uninstall: %v", err)
	}
	if _, err := os.Stat(layout.VersionsDir()); !os.IsNotExist(err) {
		t.Fatalf("version roots remain after uninstall: %v", err)
	}
}

func TestUnversionedDirectoryIsNotMigratedOnActivation(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "user-file"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	layout, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := layout.Validate(); err == nil {
		t.Fatal("unversioned directory was accepted as a versioned platform root")
	}
	if got, err := os.ReadFile(filepath.Join(root, "user-file")); err != nil || string(got) != "keep" {
		t.Fatalf("legacy directory changed: %q, %v", got, err)
	}
}

func TestInitialTargetAcceptsOnlyContractDeclaredRuntimeState(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	layout, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := layout.PrepareInitialTarget(); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "state", "cache"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "state", "cache", "plan.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := layout.ValidateInitialTarget(); err != nil {
		t.Fatalf("declared resolver cache was rejected: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "user-data.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := layout.ValidateInitialTarget(); err == nil {
		t.Fatal("unrelated user data was accepted as a fresh install target")
	}
}

func TestInitialTargetRefusesUnattributedPreinstallAndDamagedOwnership(t *testing.T) {
	for name, setup := range map[string]func(*testing.T, string){
		"foreign scenario file": func(t *testing.T, root string) {
			path := filepath.Join(root, "state", "scenarios", "foreign.json")
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("foreign bytes\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"ownership and versions without current": func(t *testing.T, root string) {
			if err := os.MkdirAll(filepath.Join(root, "versions", "1.0.0"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "ownership.json"), []byte(`{"schema":"kb.create.installation-owner/v1","installationId":"00112233445566778899aabbccddeeff"}`), 0o600); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "platform")
			if err := os.MkdirAll(root, 0o700); err != nil {
				t.Fatal(err)
			}
			setup(t, root)
			layout, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			before := snapshotLayoutTarget(t, root)
			if err := layout.ValidateInitialTarget(); err == nil {
				t.Fatal("unattributed target was accepted")
			}
			if after := snapshotLayoutTarget(t, root); !bytes.Equal(after, before) {
				t.Fatalf("refused target changed: before=%q after=%q", before, after)
			}
		})
	}
}

func snapshotLayoutTarget(t *testing.T, root string) []byte {
	t.Helper()
	var snapshot bytes.Buffer
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		fmt.Fprintf(&snapshot, "%s %s\n", relative, info.Mode())
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			snapshot.Write(data)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot.Bytes()
}

func TestInstallRootContainerKeepsLifecycleWritesInsideTheChosenDirectory(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "install")
	layout, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	writeReceipt(t, stage, "1.0.0", "receipt-1")
	if _, err := layout.ActivateInitial(stage, "1.0.0", "plan-1"); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(root); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("install root = %v, %v; want a real directory", info, err)
	}
	current := filepath.Join(root, "current")
	link, err := os.Readlink(current)
	if err != nil || filepath.IsAbs(link) || !strings.HasPrefix(filepath.Clean(filepath.Join(root, link)), filepath.Join(root, "versions")+string(filepath.Separator)) {
		t.Fatalf("current link = %q, %v; want relative link into install-root versions", link, err)
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 1 || entries[0].Name() != "install" {
		t.Fatalf("parent entries = %#v, %v; lifecycle wrote outside install root", entries, err)
	}
	assertOnlyInstallRoot(t, parent)
	if err := layout.RecordHealthy(); err != nil {
		t.Fatal(err)
	}
	v1, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"2.0.0", "3.0.0"} {
		stage, err := layout.Stage()
		if err != nil {
			t.Fatal(err)
		}
		writeReceipt(t, stage, version, "receipt-"+version)
		if _, err := layout.Activate(stage, version, "plan-"+version, ""); err != nil {
			t.Fatal(err)
		}
		assertOnlyInstallRoot(t, parent)
	}
	if _, err := os.Stat(v1); err != nil {
		t.Fatalf("last healthy root disappeared before restart: %v", err)
	}
	v2 := filepath.Join(layout.VersionsDir(), versionKey("2.0.0", "plan-2.0.0"))
	if _, err := os.Stat(v2); !os.IsNotExist(err) {
		t.Fatalf("unhealthy intermediate v2 was retained: %v", err)
	}
	data := filepath.Join(layout.SharedStateDir(), "data", "after-update.db")
	if err := os.WriteFile(data, []byte("written-after-stage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := layout.RecordHealthy(); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(layout.PlatformRoot(), ".kb", "data", "after-update.db")); err != nil || string(got) != "written-after-stage" {
		t.Fatalf("post-update data after restart = %q, %v", got, err)
	}
	if _, err := os.Stat(v1); !os.IsNotExist(err) {
		t.Fatalf("old healthy root survived successful v3 restart: %v", err)
	}
	assertOnlyInstallRoot(t, parent)
	if err := layout.RemoveOwned(); err != nil {
		t.Fatal(err)
	}
	entries, err = os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatalf("parent after uninstall = %#v, %v; owned root remained", entries, err)
	}
}

func assertOnlyInstallRoot(t *testing.T, parent string) {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 1 || entries[0].Name() != "install" {
		t.Fatalf("parent entries = %#v, %v; expected only install root", entries, err)
	}
}

func TestUnsupportedOperatingSystemIsCataloguedBeforeStaging(t *testing.T) {
	err := supportedOS("windows")
	var diagnostic *diag.Diag
	if !errors.As(err, &diagnostic) || diagnostic.Code != contracts.CodeUnsupportedPlatform {
		t.Fatalf("unsupported operating-system error = %#v", err)
	}
	if diagnostic.Message != "windows/"+runtime.GOARCH+" is not a supported platform." || !strings.Contains(diagnostic.Hint, "Linux or macOS") {
		t.Fatalf("unsupported operating-system message or hint = %q / %q", diagnostic.Message, diagnostic.Hint)
	}
}

func TestVersionRootsShareMutableDataInsteadOfCopyingIt(t *testing.T) {
	root := filepath.Join(t.TempDir(), "install")
	layout, active := initialLayout(t, root, "1.0.0")
	data := filepath.Join(root, "state", "data")
	database := filepath.Join(data, "database")
	if err := os.MkdirAll(database, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(database, "after-update.db"), []byte("latest"), 0o600); err != nil {
		t.Fatal(err)
	}
	wantData, err := filepath.EvalSymlinks(data)
	if err != nil {
		t.Fatal(err)
	}
	wantDatabase, err := filepath.EvalSymlinks(database)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.Stage()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(stage, ".kb", "data")); !os.IsNotExist(err) {
		t.Fatalf("staged version has a writable shared-state route before activation: %v", err)
	}
	activeData, err := filepath.EvalSymlinks(filepath.Join(active, ".kb", "data"))
	if err != nil || filepath.Clean(activeData) != filepath.Clean(wantData) {
		t.Fatalf("active data path = %q, %v; want shared install-root data %q", activeData, err, data)
	}
	activeDatabase, err := filepath.EvalSymlinks(filepath.Join(active, ".kb", "data", "database"))
	if err != nil || filepath.Clean(activeDatabase) != filepath.Clean(wantDatabase) {
		t.Fatalf("active database path = %q, %v; want shared install-root database %q", activeDatabase, err, database)
	}
	writeReceipt(t, stage, "2.0.0", "receipt-2")
	if _, err := layout.Activate(stage, "2.0.0", "plan-2", ""); err != nil {
		t.Fatal(err)
	}
	active, err = layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	activatedData, err := filepath.EvalSymlinks(filepath.Join(active, ".kb", "data"))
	if err != nil || filepath.Clean(activatedData) != filepath.Clean(wantData) {
		t.Fatalf("activated data path = %q, %v; want shared install-root data %q", activatedData, err, data)
	}
	activatedDatabase, err := filepath.EvalSymlinks(filepath.Join(active, ".kb", "data", "database"))
	if err != nil || filepath.Clean(activatedDatabase) != filepath.Clean(wantDatabase) {
		t.Fatalf("activated database path = %q, %v; want shared install-root database %q", activatedDatabase, err, database)
	}
	if err := layout.RecordHealthy(); err != nil {
		t.Fatal(err)
	}
	stage, err = layout.Stage()
	if err != nil {
		t.Fatal(err)
	}
	writeReceipt(t, stage, "3.0.0", "receipt-3")
	if _, err := layout.Activate(stage, "3.0.0", "plan-3", ""); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(layout.SharedStateDir(), "data", "database", "after-update.db")); err != nil || string(got) != "latest" {
		t.Fatalf("database data after update = %q, %v", got, err)
	}
	if _, err := layout.RestorePrevious(); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(layout.PlatformRoot(), ".kb", "data", "database", "after-update.db")); err != nil || string(got) != "latest" {
		t.Fatalf("database data after rollback = %q, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(active, ".kb", "marketplace.lock")); !os.IsNotExist(err) {
		t.Fatalf("empty marketplace lock was expected in this catalog fixture, got %v", err)
	}
	if err := os.RemoveAll(stage); err != nil {
		t.Fatal(err)
	}
}

func TestUninstallPreservesForeignInstallRootEntriesAndSibling(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "install")
	layout, _ := initialLayout(t, root, "1.0.0")
	foreignSibling := filepath.Join(parent, "unrelated")
	if err := os.Mkdir(foreignSibling, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(foreignSibling, "keep"), []byte("sibling"), 0o600); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(root, "keep.txt")
	if err := os.WriteFile(foreign, []byte("user"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := layout.RemoveOwned(); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(foreign); err != nil || string(got) != "user" {
		t.Fatalf("foreign install-root entry = %q, %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(foreignSibling, "keep")); err != nil || string(got) != "sibling" {
		t.Fatalf("foreign sibling = %q, %v", got, err)
	}
}
