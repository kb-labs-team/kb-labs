package versionroot

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

func TestManagedMarketplaceOwnerRunsInstalledHelperInCandidateAndSwitchesOnlyOnSuccess(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js is required for the installed-helper transaction test")
	}
	for _, helperExit := range []int{0, 19} {
		t.Run(map[int]string{0: "success", 19: "failure"}[helperExit], func(t *testing.T) {
			layout, active := initialLayout(t, filepath.Join(t.TempDir(), "install"), "1.0.0")
			if err := os.MkdirAll(filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app", "dist"), 0o700); err != nil {
				t.Fatal(err)
			}
			pkg := filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app", "package.json")
			if err := os.WriteFile(pkg, []byte(`{"name":"@kb-labs/marketplace-app"}`), 0o600); err != nil {
				t.Fatal(err)
			}
			helper := filepath.Join(filepath.Dir(pkg), "dist", "bin.js")
			script := `let body="";process.stdin.on("data",b=>body+=b);process.stdin.on("end",()=>{const r=JSON.parse(body);if(r.operation!=="install"||process.env.KB_PLATFORM_ROOT!==process.cwd())process.exit(31);require("node:fs").writeFileSync("mutation.marker", "staged");process.exit(` + strconv.Itoa(helperExit) + `);});`
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
					t.Fatal("failed helper unexpectedly committed its candidate")
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
