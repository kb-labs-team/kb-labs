package shim

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/versionroot"
)

func installFixture(t *testing.T, root string) string {
	t.Helper()
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	cliEntry := filepath.Join(stage, "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	if err := os.MkdirAll(filepath.Dir(cliEntry), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cliEntry, []byte("process.stdout.write('KB Labs\\n')\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	id, err := versionroot.InstallationIDForPath(stage)
	if err != nil {
		t.Fatal(err)
	}
	if err := receipt.Write(stage, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "receipt", InstallationID: id,
		Plan: contracts.ResolvedInstallPlan{ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.ActivateInitial(stage, "1.0.0", "fixture-plan"); err != nil {
		t.Fatal(err)
	}
	return layout.PlatformRoot()
}

func TestShimLifecycle(t *testing.T) {
	root := t.TempDir()
	launcherDir := filepath.Join(root, "bin")
	platformRoot := filepath.Join(root, "platform")
	if err := os.MkdirAll(launcherDir, 0o750); err != nil {
		t.Fatal(err)
	}
	layout, err := versionroot.New(platformRoot)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	cliEntry := filepath.Join(stage, "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	if err := os.MkdirAll(filepath.Dir(cliEntry), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cliEntry, []byte("process.stdout.write(process.argv.slice(2).join(' '))\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(launcherDir, "kb-create")
	id, err := versionroot.InstallationIDForPath(stage)
	if err != nil {
		t.Fatal(err)
	}
	if err := receipt.Write(stage, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "receipt", InstallationID: id,
		Plan: contracts.ResolvedInstallPlan{ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.ActivateInitial(stage, "1.0.0", "fixture-plan"); err != nil {
		t.Fatal(err)
	}
	platformRoot = layout.PlatformRoot()
	if _, err := Ensure(launcher, platformRoot); err != nil || !Correct(launcher, platformRoot) {
		t.Fatalf("Ensure error = %v; path points correctly = %t", err, Correct(launcher, platformRoot))
	}
	output, err := exec.Command(Path(launcher), "first", "value").Output()
	if err != nil || string(output) != "first value" {
		t.Fatalf("shim output/error = %q / %v", output, err)
	}
	if err := Remove(launcher, platformRoot); err != nil || Correct(launcher, platformRoot) {
		t.Fatalf("Remove error = %v; shim still correct = %t", err, Correct(launcher, platformRoot))
	}
}

func TestRemoveLeavesUnownedShimPointingElsewhere(t *testing.T) {
	root := t.TempDir()
	launcherDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(launcherDir, 0o750); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(launcherDir, "kb-create")
	path := Path(launcher)
	if err := os.Symlink("/elsewhere/kb", path); err != nil {
		t.Fatal(err)
	}
	if err := Remove(launcher, filepath.Join(root, "platform")); err != nil {
		t.Fatalf("uninstall failed for a shim owned by another target: %v", err)
	}
	if got := mustReadlink(t, path); got != "/elsewhere/kb" {
		t.Fatalf("unowned shim changed to %s", got)
	}
}

func TestEnsureReplacesOnlyAnInstallerManagedShim(t *testing.T) {
	root := t.TempDir()
	launcherDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(launcherDir, 0o750); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(launcherDir, "kb-create")
	firstRoot := filepath.Join(root, "first")
	secondRoot := filepath.Join(root, "second")
	firstRoot = installFixture(t, firstRoot)
	secondRoot = installFixture(t, secondRoot)
	if _, err := Ensure(launcher, firstRoot); err != nil {
		t.Fatal(err)
	}
	result, err := Ensure(launcher, secondRoot)
	if err != nil {
		t.Fatalf("Ensure rejected a live managed owner: %v", err)
	}
	if result.Linked || result.Owner != filepath.Dir(firstRoot) || !Correct(launcher, firstRoot) {
		t.Fatalf("Ensure changed the live owner: result=%+v target=%s", result, mustReadlink(t, Path(launcher)))
	}
	if _, err := os.Stat(Target(secondRoot)); err != nil {
		t.Fatalf("Ensure did not create the second root's local kb command: %v", err)
	}
	before := mustReadlink(t, Path(launcher))
	if err := Remove(launcher, secondRoot); err != nil {
		t.Fatalf("Remove rejected a shim owned by another validated installation: %v", err)
	}
	if after := mustReadlink(t, Path(launcher)); after != before {
		t.Fatalf("Remove changed another validated installation's shim: before=%q after=%q", before, after)
	}
	if err := receipt.Delete(firstRoot); err != nil {
		t.Fatal(err)
	}
	result, err = Ensure(launcher, secondRoot)
	if err == nil || result.Linked || mustReadlink(t, Path(launcher)) != before {
		t.Fatalf("Ensure changed an unverified foreign shim: result=%+v error=%v", result, err)
	}
}

func TestEnsureRefusesToReplaceAUserOwnedLauncherPath(t *testing.T) {
	root := t.TempDir()
	launcherDir := filepath.Join(root, "bin")
	platformRoot := filepath.Join(root, "platform")
	if err := os.MkdirAll(launcherDir, 0o750); err != nil {
		t.Fatal(err)
	}
	platformRoot = installFixture(t, platformRoot)
	launcher := filepath.Join(launcherDir, "kb-create")
	path := Path(launcher)
	if err := os.WriteFile(path, []byte("user data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Ensure(launcher, platformRoot); err == nil {
		t.Fatal("Ensure replaced a user-owned launcher path")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "user data" {
		t.Fatalf("user-owned launcher path changed: %q / %v", data, err)
	}
}

func TestEnsureAndRemoveLeaveUnverifiedShimUntouched(t *testing.T) {
	root := t.TempDir()
	launcherDir := filepath.Join(root, "bin")
	launcher := filepath.Join(launcherDir, "kb-create")
	requested := installFixture(t, filepath.Join(root, "requested"))
	if err := os.MkdirAll(launcherDir, 0o750); err != nil {
		t.Fatal(err)
	}
	path := Path(launcher)
	legacyTarget := filepath.Join(root, "removed", ".kb", "v2", "bin", "kb")
	if err := os.Symlink(legacyTarget, path); err != nil {
		t.Fatal(err)
	}
	before := mustReadlink(t, path)
	if _, err := Ensure(launcher, requested); err == nil {
		t.Fatal("Ensure accepted an unverified existing shim")
	}
	if err := Remove(launcher, requested); err != nil {
		t.Fatalf("Remove rejected an unverified shim: %v", err)
	}
	if after := mustReadlink(t, path); after != before {
		t.Fatalf("unverified shim target changed: before=%q after=%q", before, after)
	}
}

func TestClassifyOwnOtherForeignAndAbsentShimTargets(t *testing.T) {
	base := t.TempDir()
	launcherDir := filepath.Join(base, "bin")
	if err := os.MkdirAll(launcherDir, 0o750); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(launcherDir, "kb-create")
	requested := installFixture(t, filepath.Join(base, "requested"))
	other := installFixture(t, filepath.Join(base, "other"))
	classify := func(target string, exists bool, want ClassificationKind) {
		t.Helper()
		path := Path(launcher)
		_ = os.Remove(path)
		if exists {
			if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, []byte("arbitrary file"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if target != "" {
			if err := os.Symlink(target, path); err != nil {
				t.Fatal(err)
			}
		}
		got, err := Classify(launcher, requested)
		if err != nil || got.Kind != want {
			t.Fatalf("Classify(%q) = %+v, %v; want %s", target, got, err, want)
		}
	}
	classify("", false, ClassificationAbsent)
	classify(Target(requested), false, ClassificationOwned)
	classify(Target(other), false, ClassificationOtherInstallation)
	classify(filepath.Join(base, "arbitrary-existing"), true, ClassificationForeign)
	classify(filepath.Join(base, "arbitrary-missing"), false, ClassificationForeign)

	removed := installFixture(t, filepath.Join(base, "removed"))
	removedTarget := Target(removed)
	layout, err := versionroot.ForPlatformPath(removed)
	if err != nil {
		t.Fatal(err)
	}
	if err := layout.RemoveOwned(); err != nil {
		t.Fatal(err)
	}
	classify(removedTarget, false, ClassificationForeign)
}

func TestEnsureAndRemoveLeaveArbitraryExistingAndMissingForeignTargetsUntouched(t *testing.T) {
	base := t.TempDir()
	launcherDir := filepath.Join(base, "bin")
	if err := os.MkdirAll(launcherDir, 0o750); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(launcherDir, "kb-create")
	requested := installFixture(t, filepath.Join(base, "requested"))
	existingTarget := filepath.Join(base, "arbitrary-file")
	if err := os.WriteFile(existingTarget, []byte("foreign target bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{existingTarget, filepath.Join(base, "missing-target")} {
		path := Path(launcher)
		if err := os.Symlink(target, path); err != nil {
			t.Fatal(err)
		}
		before := mustReadlink(t, path)
		if _, err := Ensure(launcher, requested); err == nil {
			t.Fatalf("Ensure replaced foreign target %q", target)
		}
		if err := Remove(launcher, requested); err != nil {
			t.Fatalf("Remove foreign target %q: %v", target, err)
		}
		if after := mustReadlink(t, path); after != before {
			t.Fatalf("foreign link changed: before=%q after=%q", before, after)
		}
		if target == existingTarget {
			if data, err := os.ReadFile(existingTarget); err != nil || string(data) != "foreign target bytes" {
				t.Fatalf("foreign target bytes changed: %q, %v", data, err)
			}
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
}

func TestShimOwnershipMatrix(t *testing.T) {
	for _, operation := range []string{"apply", "doctor --fix"} {
		for _, state := range []string{"absent", "own", "live-other", "dangling-other", "unmanaged"} {
			t.Run(operation+"/"+state, func(t *testing.T) {
				root := t.TempDir()
				launcherDir := filepath.Join(root, "bin")
				if err := os.MkdirAll(launcherDir, 0o750); err != nil {
					t.Fatal(err)
				}
				launcher := filepath.Join(launcherDir, "kb-create")
				owner := filepath.Join(root, "owner")
				other := filepath.Join(root, "other")
				owner = installFixture(t, owner)
				other = installFixture(t, other)
				path := Path(launcher)
				switch state {
				case "own":
					if _, err := Ensure(launcher, owner); err != nil {
						t.Fatal(err)
					}
				case "live-other":
					if _, err := Ensure(launcher, other); err != nil {
						t.Fatal(err)
					}
				case "dangling-other":
					if _, err := Ensure(launcher, other); err != nil {
						t.Fatal(err)
					}
					if err := receipt.Delete(other); err != nil {
						t.Fatal(err)
					}
				case "unmanaged":
					if err := os.WriteFile(path, []byte("user file"), 0o600); err != nil {
						t.Fatal(err)
					}
				}

				result, err := Ensure(launcher, owner)
				if state == "dangling-other" {
					if err == nil || mustReadlink(t, path) != Target(other) {
						t.Fatalf("unverified shim was replaced: result=%+v error=%v", result, err)
					}
					return
				}
				if state == "unmanaged" {
					if err == nil {
						t.Fatal("apply replaced an unmanaged user file")
					}
					data, readErr := os.ReadFile(path)
					if readErr != nil || string(data) != "user file" {
						t.Fatalf("unmanaged file changed: %q %v", data, readErr)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				wantOwner, wantLinked := filepath.Dir(owner), true
				if state == "live-other" {
					wantOwner, wantLinked = filepath.Dir(other), false
				}
				if state == "own" {
					wantLinked = true
				}
				if state == "absent" {
					wantLinked = true
				}
				if result.Owner != wantOwner || result.Linked != wantLinked || !Correct(launcher, wantOwner) {
					t.Fatalf("result=%+v, target=%s; want owner=%s linked=%t", result, mustReadlink(t, path), wantOwner, wantLinked)
				}
			})
		}
	}

	for _, state := range []string{"absent", "own", "live-other", "dangling-other", "unmanaged"} {
		t.Run("uninstall/"+state, func(t *testing.T) {
			root := t.TempDir()
			launcherDir := filepath.Join(root, "bin")
			if err := os.MkdirAll(launcherDir, 0o750); err != nil {
				t.Fatal(err)
			}
			launcher := filepath.Join(launcherDir, "kb-create")
			owner := filepath.Join(root, "owner")
			other := filepath.Join(root, "other")
			owner = installFixture(t, owner)
			other = installFixture(t, other)
			path := Path(launcher)
			switch state {
			case "own":
				if _, err := Ensure(launcher, owner); err != nil {
					t.Fatal(err)
				}
			case "live-other":
				if _, err := Ensure(launcher, other); err != nil {
					t.Fatal(err)
				}
			case "dangling-other":
				if _, err := Ensure(launcher, other); err != nil {
					t.Fatal(err)
				}
				if err := receipt.Delete(other); err != nil {
					t.Fatal(err)
				}
			case "unmanaged":
				if err := os.WriteFile(path, []byte("user file"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := Remove(launcher, owner); err != nil {
				t.Fatal(err)
			}
			switch state {
			case "own":
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					t.Fatalf("own shim remains: %v", err)
				}
			case "live-other", "dangling-other":
				if got := mustReadlink(t, path); got != Target(other) {
					t.Fatalf("other root shim changed to %s", got)
				}
			case "unmanaged":
				data, err := os.ReadFile(path)
				if err != nil || string(data) != "user file" {
					t.Fatalf("unmanaged file changed: %q %v", data, err)
				}
			case "absent":
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					t.Fatalf("unexpected shim: %v", err)
				}
			}
		})
	}
}

func TestEnsureJudgesInstallRootCurrentAndVersionRootAsOneInstallation(t *testing.T) {
	root := t.TempDir()
	launcherDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(launcherDir, 0o750); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(launcherDir, "kb-create")
	installRoot := filepath.Join(root, "install")
	platformRoot := installFixture(t, installRoot)
	layout, err := versionroot.New(installRoot)
	if err != nil {
		t.Fatal(err)
	}
	canonicalRoot := layout.InstallRoot()
	physicalRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	for _, spelling := range []string{installRoot, platformRoot, physicalRoot} {
		result, ensureErr := Ensure(launcher, spelling)
		if ensureErr != nil {
			t.Fatalf("Ensure(%q): %v", spelling, ensureErr)
		}
		if !result.Linked || result.Owner != canonicalRoot || !Correct(launcher, spelling) {
			t.Fatalf("Ensure(%q) result = %+v; want canonical owner %q", spelling, result, canonicalRoot)
		}
		if target := mustReadlink(t, Path(launcher)); target != Target(platformRoot) {
			t.Fatalf("Ensure(%q) target = %q", spelling, target)
		}
	}
	if err := Remove(launcher, canonicalRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(Path(launcher)); !os.IsNotExist(err) {
		t.Fatalf("Remove by install-root spelling left the shim: %v", err)
	}
}

func mustReadlink(t *testing.T, path string) string {
	t.Helper()
	target, err := os.Readlink(path)
	if err != nil {
		t.Fatal(err)
	}
	return target
}

// case: S-285.11
func TestShimUsesInstallationHomeUnlessExplicitlyOverridden(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", "")
	root := filepath.Join(t.TempDir(), "platform")
	active := installFixture(t, root)
	entry := filepath.Join(active, "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	if err := os.WriteFile(entry, []byte("process.stdout.write(process.env.KB_HOME || '')\n"), 0600); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(t.TempDir(), "kb-create")
	if _, err := Ensure(launcher, active); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(Path(launcher)).Output()
	if err != nil {
		t.Fatal(err)
	}
	want, err := host.DefaultKBHome(active)
	if err != nil {
		t.Fatal(err)
	}
	if string(output) != want {
		t.Fatalf("KB_HOME = %q, want %q", output, want)
	}
	if _, err := os.Stat(filepath.Join(home, ".kb")); !os.IsNotExist(err) {
		t.Fatalf("outer .kb exists: %v", err)
	}
	override := filepath.Join(home, "override")
	t.Setenv("KB_HOME", override)
	output, err = exec.Command(Path(launcher)).Output()
	if err != nil || string(output) != override {
		t.Fatalf("explicit KB_HOME = %q, error %v; want %q", output, err, override)
	}
}

// case: S-285.15
func TestEnsureUpdatesMarkedTarget(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	active := installFixture(t, root)
	launcher := filepath.Join(t.TempDir(), "kb-create")
	if _, err := Ensure(launcher, active); err != nil {
		t.Fatal(err)
	}
	target := Target(active)
	if err := os.WriteFile(target, []byte("#!/bin/sh\n# kb-create managed shim\nold\n"), 0750); err != nil {
		t.Fatal(err)
	}
	if _, err := Ensure(launcher, active); err != nil {
		t.Fatalf("update managed target: %v", err)
	}
}
