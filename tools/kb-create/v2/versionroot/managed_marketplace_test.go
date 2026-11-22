package versionroot

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/clikit/operationlock"
	"github.com/kb-labs/clikit/proc/child"
)

func TestManagedMarketplaceMutationExposesOnlyVerifiedAdapterInstall(t *testing.T) {
	for _, operation := range []ManagedMarketplaceOperation{"update", "uninstall", "enable", "disable"} {
		t.Run(string(operation), func(t *testing.T) {
			if err := validateManagedMarketplaceMutation(ManagedMarketplaceMutation{Operation: operation}); err == nil {
				t.Fatalf("unsupported operation %q was accepted", operation)
			}
		})
	}
	if err := validateManagedMarketplaceMutation(ManagedMarketplaceMutation{Operation: ManagedMarketplaceInstall}); err == nil {
		t.Fatal("empty adapter install was accepted")
	}
}

func TestManagedMarketplaceOwnerRunsInstalledHelperInCandidateAndSwitchesOnlyOnSuccess(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js is required for the installed-helper transaction test")
	}
	for _, helperExit := range []int{0, 19, 20} {
		t.Run(map[int]string{0: "success", 19: "failure", 20: "exit-zero-without-postcondition"}[helperExit], func(t *testing.T) {
			layout, active := initialLayout(t, filepath.Join(t.TempDir(), "install"), "1.0.0")
			if err := os.WriteFile(filepath.Join(active, "package.json"), []byte(`{"packageManager":"pnpm@11.4.0"}`), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app", "dist"), 0o700); err != nil {
				t.Fatal(err)
			}
			pkg := filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app", "package.json")
			if err := os.WriteFile(pkg, []byte(`{"name":"@kb-labs/marketplace-app","kb":{"managedGenerationMutation":1}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			helper := filepath.Join(filepath.Dir(pkg), "dist", "bin.js")
			script := `let body="";process.stdin.on("data",b=>body+=b);process.stdin.on("end",()=>{const r=JSON.parse(body);if(process.argv[2]!=="--managed-generation-mutation"||r.operation!=="install"||process.env.KB_PLATFORM_ROOT!==process.cwd())process.exit(31);const result=JSON.stringify({schema:1,operation:"install",installed:[{packageId:"@kb-labs/example",version:"1.0.0",primaryKind:"adapter"}]})+"\n";if(` + strconv.Itoa(helperExit) + `===19)process.exit(19);if(` + strconv.Itoa(helperExit) + `===20){process.stdout.write(result);return;}const fs=require("node:fs");fs.mkdirSync("node_modules/@kb-labs/example",{recursive:true});fs.writeFileSync("node_modules/@kb-labs/example/package.json",JSON.stringify({name:"@kb-labs/example",version:"1.0.0"}));fs.writeFileSync(".kb/marketplace.lock",JSON.stringify({schema:"kb.marketplace/3",plugins:{},adapters:{"@kb-labs/example":{version:"1.0.0",resolvedPath:"node_modules/@kb-labs/example"}}}));fs.writeFileSync("mutation.marker","staged");process.stdout.write(result);});`
			if err := os.WriteFile(helper, []byte(script), 0o600); err != nil {
				t.Fatal(err)
			}

			_, err := layout.RunManagedMarketplaceMutation(context.Background(), active, ManagedMarketplaceMutation{
				Operation: ManagedMarketplaceInstall,
				Specs:     []string{"@kb-labs/example@1.0.0"},
			})
			selected, activeErr := layout.Active()
			if activeErr != nil {
				t.Fatal(activeErr)
			}
			if helperExit != 0 {
				if err == nil {
					t.Fatal("helper without a verified package postcondition unexpectedly committed its candidate")
				}
				if selected != active {
					t.Fatalf("failed helper changed active generation: got %q want %q", selected, active)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if selected == active {
				t.Fatal("successful helper did not activate its candidate")
			}
			if data, readErr := os.ReadFile(filepath.Join(selected, "mutation.marker")); readErr != nil || string(data) != "staged" {
				t.Fatalf("candidate mutation = %q, %v", data, readErr)
			}
			if _, statErr := os.Stat(filepath.Join(active, "mutation.marker")); !os.IsNotExist(statErr) {
				t.Fatalf("helper mutated active generation: %v", statErr)
			}
		})
	}
}

func TestManagedMarketplaceOwnerHardKillPreservesLiveCandidate(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("managed operation locking is supported on Linux and macOS")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js is required for the subprocess lifecycle test")
	}
	if root := os.Getenv("KB_TEST_MANAGED_OWNER_ROOT"); root != "" {
		layout, err := New(root)
		if err != nil {
			os.Exit(61)
		}
		active, err := layout.Active()
		if err != nil {
			os.Exit(62)
		}
		_, err = layout.RunManagedMarketplaceMutation(context.Background(), active, ManagedMarketplaceMutation{
			Operation: ManagedMarketplaceInstall,
			Specs:     []string{"@kb-labs/example@1.0.0"},
		})
		if err != nil {
			os.Exit(63)
		}
		os.Exit(0)
	}

	layout, active := initialLayout(t, filepath.Join(t.TempDir(), "install"), "1.0.0")
	if err := os.WriteFile(filepath.Join(active, "package.json"), []byte(`{"packageManager":"pnpm@11.4.0"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app")
	if err := os.MkdirAll(filepath.Join(app, "dist"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "package.json"), []byte(`{"name":"@kb-labs/marketplace-app","kb":{"managedGenerationMutation":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	childScript := `const cp=require("node:child_process");const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(0,"utf8"));if(r.operation!=="install")process.exit(31);cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync("mutation.ready",String(process.pid));setInterval(()=>{},1000);`
	if err := os.WriteFile(filepath.Join(app, "dist", "bin.js"), []byte(childScript+"\n// --managed-generation-mutation capability\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	owner := exec.Command(os.Args[0], "-test.run=^TestManagedMarketplaceOwnerHardKillPreservesLiveCandidate$")
	owner.Env = append(os.Environ(), "KB_TEST_MANAGED_OWNER_ROOT="+layout.Root)
	owner.Stdout, owner.Stderr = nil, nil
	if err := owner.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if owner.Process != nil {
			_ = owner.Process.Kill()
		}
	}()

	var stage, groupID string
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		entries, _ := os.ReadDir(layout.VersionsDir())
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".stage-managed-") {
				candidate := filepath.Join(layout.VersionsDir(), entry.Name())
				if data, err := os.ReadFile(filepath.Join(candidate, "mutation.ready")); err == nil {
					stage, groupID = candidate, strings.TrimSpace(string(data))
					break
				}
			}
		}
		if stage != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if stage == "" || groupID == "" {
		_ = owner.Process.Kill()
		_, _ = owner.Process.Wait()
		t.Fatal("installed helper did not reach the candidate mutation stage")
	}
	ownerPID := owner.Process.Pid
	if err := owner.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_, _ = owner.Process.Wait()
	owner.Process = nil

	lease, err := operationlock.Acquire(operationlock.Path(layout.HostStateDir()), "managed-stage-recovery-test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := layout.StageManagedGeneration(); err == nil || !strings.Contains(err.Error(), "live Marketplace helper process group") {
		lease.Release()
		t.Fatalf("stage cleanup while the pnpm owner group is live = %v", err)
	}
	if _, err := os.Stat(stage); err != nil {
		lease.Release()
		t.Fatalf("live candidate was removed after owner PID %d was killed: %v", ownerPID, err)
	}
	lease.Release()
	pid, err := strconv.Atoi(groupID)
	if err != nil {
		t.Fatal(err)
	}
	if err := child.KillTree(pid); err != nil {
		t.Fatalf("kill orphaned helper process group %d: %v", pid, err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		live, err := layout.managedStageOwnerLive(stage)
		if err != nil {
			t.Fatal(err)
		}
		if !live {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if live, err := layout.managedStageOwnerLive(stage); err != nil || live {
		t.Fatalf("managed helper process group did not exit: live=%v err=%v", live, err)
	}
	lease, err = operationlock.Acquire(operationlock.Path(layout.HostStateDir()), "managed-stage-recovery-test")
	if err != nil {
		t.Fatal(err)
	}
	retry, err := layout.StageManagedGeneration()
	lease.Release()
	if err != nil {
		t.Fatal(fmt.Errorf("retry after the helper process group exited: %w", err))
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatalf("orphan candidate was not removed after its group exited: %v", err)
	}
	if err := layout.AbortManagedGeneration(retry); err != nil {
		t.Fatal(err)
	}
}
