package journey_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/render"
	"github.com/kb-labs/create/v2/resolve"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/transport"
	"github.com/kb-labs/create/v2/verify"
	"github.com/kb-labs/create/v2/wizard"
)

// testHost is the host every fixture platform declares: the journey never runs
// it (its start is proven in the host and launcher packages), it only has to be
// a valid declaration that travels index -> plan -> receipt.
func testHost() *contracts.HostSpec {
	return &contracts.HostSpec{Command: "node_modules/.bin/kb-host", HealthURL: "http://127.0.0.1:4000/health"}
}

type offlineArtifacts struct {
	installed, removed []contracts.Artifact
	restores           int
	installErr         error
}

func (a *offlineArtifacts) Install(items []contracts.Artifact) error {
	if a.installErr != nil {
		return a.installErr
	}
	a.installed = append(a.installed, items...)
	return nil
}
func (a *offlineArtifacts) Restore() error { a.restores++; return nil }
func (a *offlineArtifacts) Uninstall(items []contracts.Artifact) error {
	a.removed = append(a.removed, items...)
	return nil
}

type journeyClock struct{ time.Time }

func (c journeyClock) Now() time.Time { return c.Time }
func TestOfflineJourneyUsesResolvedGraphAsSingleTruth(t *testing.T) {
	root := t.TempDir()
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Host: testHost(), Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{{ID: "gateway", Command: "kb-gateway", Port: 4000, Required: true}}}}, Requires: []catalog.Requirement{{Capability: "logging", RequiredBy: "platform"}}}}, Plugins: []catalog.Component{{ID: "review", Version: "1.0.0", Package: "@kb/review", SHA256: "review", PlatformRange: "^2.0.0"}}, Adapters: []catalog.Adapter{{Component: catalog.Component{ID: "pino", Version: "1.0.0", Package: "@kb/pino", SHA256: "pino", PlatformRange: "^2.0.0"}, Provides: []string{"logging"}}}}
	plan, err := resolve.Plan(contracts.InstallRequest{PlatformRoot: root, Source: contracts.SourceOffline, Plugins: []contracts.ComponentRequest{{ID: "review"}}}, source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := render.Write(plan); err != nil {
		t.Fatal(err)
	}
	if plan.Host == nil || plan.Host.Command != testHost().Command {
		t.Fatalf("the plan must carry the platform's host: %#v", plan.Host)
	}
	check, err := verify.Run(plan, time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	r := contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "r1", Plan: plan, Verification: check}
	if err := receipt.Write(root, r); err != nil {
		t.Fatal(err)
	}
	loaded, err := receipt.Read(root)
	if err != nil || loaded.Plan.PlanHash != plan.PlanHash {
		t.Fatalf("receipt %#v, %v", loaded, err)
	}
	config, err := os.ReadFile(filepath.Join(root, ".kb", "kb.config.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	if len(config) == 0 {
		t.Fatal("empty config")
	}
	findings := doctor.Diagnose([]doctor.Manifest{{ID: "review", Requirements: []doctor.Requirement{{Path: "/review/token", Secret: true, Required: true, Hint: "Set REVIEW_TOKEN"}}}}, map[string]bool{})
	if len(findings) != 1 || findings[0].Code != contracts.CodeInputRequired || findings[0].SafeFix {
		t.Fatalf("unexpected doctor findings %#v", findings)
	}
}

func TestOfflineLifecycleUsesReceiptSnapshotsForUpdateRollbackAndUninstall(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Host: testHost(), PlanHash: "first-plan", Request: contracts.InstallRequest{PlatformRoot: root}, Artifacts: []contracts.Artifact{{ID: "platform", Package: "@kb/platform", Version: "1.0.0"}}, ServiceGraph: contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Command: "gateway", Required: true}}}}
	artifacts := &offlineArtifacts{}
	deps := runtime.Dependencies{Artifacts: artifacts, Clock: journeyClock{time.Unix(10, 0)}}
	first, err := runtime.Apply(context.Background(), plan, deps)
	if err != nil {
		t.Fatal(err)
	}
	updated := plan
	updated.PlanHash, updated.Artifacts[0].Version = "second-plan", "1.1.0"
	deps.Clock = journeyClock{time.Unix(11, 0)}
	second, snapshot, err := runtime.Update(context.Background(), updated, deps)
	if err != nil || second.SnapshotID != snapshot.ID {
		t.Fatalf("update = %#v / %#v / %v", second, snapshot, err)
	}
	active, err := receipt.Read(root)
	if err != nil || active.Plan.Artifacts[0].Version != "1.1.0" || active.SnapshotID != snapshot.ID {
		t.Fatalf("updated receipt = %#v / %v", active, err)
	}
	if _, err := receipt.RestoreSnapshot(root, snapshot.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := receipt.Read(root)
	if err != nil || restored.ID != first.ID {
		t.Fatalf("restored = %#v / %v", restored, err)
	}
	if _, err := runtime.Uninstall(root, deps); err != nil {
		t.Fatal(err)
	}
	if len(artifacts.removed) != 1 || artifacts.removed[0].Version != "1.0.0" {
		t.Fatalf("removed = %#v", artifacts.removed)
	}
}

func TestOfflineUpdateFailureRestoresPreviousReceiptAndPackageState(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{
		Schema: contracts.ResolvedPlanSchema, Host: testHost(), PlanHash: "first-plan",
		Request:      contracts.InstallRequest{PlatformRoot: root},
		Artifacts:    []contracts.Artifact{{ID: "platform", Package: "@kb/platform", Version: "1.0.0"}},
		ServiceGraph: contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Command: "gateway", Required: true}}},
	}
	artifacts := &offlineArtifacts{}
	deps := runtime.Dependencies{Artifacts: artifacts, Clock: journeyClock{time.Unix(10, 0)}}
	first, err := runtime.Apply(context.Background(), plan, deps)
	if err != nil {
		t.Fatal(err)
	}
	updated := plan
	updated.PlanHash, updated.Artifacts[0].Version = "second-plan", "1.1.0"
	artifacts.installErr = errors.New("registry timeout")
	deps.Clock = journeyClock{time.Unix(11, 0)}
	if _, snapshot, updateErr := runtime.Update(context.Background(), updated, deps); updateErr == nil || snapshot.ID == "" {
		t.Fatalf("update error/snapshot = %v / %q", updateErr, snapshot.ID)
	}
	active, err := receipt.Read(root)
	if err != nil || active.ID != first.ID || active.Plan.Artifacts[0].Version != "1.0.0" {
		t.Fatalf("receipt after failed update = %#v / %v", active, err)
	}
	if artifacts.restores != 1 {
		t.Fatalf("restore count = %d, want 1", artifacts.restores)
	}
}

func TestOfflineApplyCompletesPluginAndWorkflowReadyPath(t *testing.T) {
	root := t.TempDir()
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Host: testHost(),
			Profiles: map[string]contracts.ServiceGraph{"default": {
				Services: []contracts.Service{{ID: "workflow", Command: "kb-workflow", Port: 7778, Required: true}},
			}},
		}},
		Plugins: []catalog.Component{{ID: "commit", Version: "1.0.0", Package: "@kb/commit", SHA256: "commit", PlatformRange: "^2.0.0"}},
	}
	plan, err := resolve.Plan(contracts.InstallRequest{
		PlatformRoot: root, Source: contracts.SourceOffline, ServiceProfile: "default",
		Plugins: []contracts.ComponentRequest{{ID: "commit"}},
	}, source)
	if err != nil {
		t.Fatal(err)
	}
	artifacts := &offlineArtifacts{}
	receipt, err := runtime.Apply(context.Background(), plan, runtime.Dependencies{Artifacts: artifacts})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Plan.PlanHash != plan.PlanHash {
		t.Fatalf("receipt plan hash = %q, want %q", receipt.Plan.PlanHash, plan.PlanHash)
	}
	foundPlugin := false
	for _, artifact := range artifacts.installed {
		if artifact.ID == "commit" {
			foundPlugin = true
		}
	}
	if !foundPlugin {
		t.Fatalf("installed artifacts = %#v, plugin outcome is missing", artifacts.installed)
	}
	config, err := os.ReadFile(filepath.Join(root, ".kb", render.ConfigFilename))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), "commit") {
		t.Fatalf("rendered config = %s, plugin is not projected", config)
	}
}

// TestTransportMatrixUsesOneResolvedPluginWorkflowPath proves that the three
// supported frontends differ only in request acquisition. It deliberately
// crosses real V2 package boundaries (wizard -> request, agent JSON ->
// transport, CI request -> resolver) before applying each resulting plan.
// The artifact and service doubles are the public runtime ports; package
// resolution, rendering, receipt and graph verification are never mocked.
func TestTransportMatrixUsesOneResolvedPluginWorkflowPath(t *testing.T) {
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0", contracts.ChannelCanary: "2.1.0"},
		Platforms: []catalog.PlatformBundle{
			{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform-2.0.0.tgz", SHA256: "platform-stable", Host: testHost(), Profiles: map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0", Profile: "default", Services: []contracts.Service{{ID: "workflow", Command: "kb-workflow", Port: 7778, Required: true}}}}},
			{ID: "platform", Version: "2.1.0", Package: "@kb/platform", Tarball: "https://example.test/platform-2.1.0.tgz", SHA256: "platform-canary", Host: testHost(), Profiles: map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.1.0", Profile: "default", Services: []contracts.Service{{ID: "workflow", Command: "kb-workflow", Port: 7778, Required: true}}}}},
		},
		Plugins: []catalog.Component{{ID: "user-plugin", Version: "1.0.0", Package: "@kb/user-plugin", Tarball: "https://example.test/user-plugin.tgz", SHA256: "user-plugin", PlatformRange: "^2.0.0"}},
	}
	sealed, err := catalog.Seal(source)
	if err != nil {
		t.Fatal(err)
	}
	source = sealed

	humanRoot := filepath.Join(t.TempDir(), "human")
	human, err := wizard.Request(source, humanRoot, wizard.IO{In: strings.NewReader("stable\ndefault\nuser-plugin\n\n"), Out: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	agentRoot := filepath.Join(t.TempDir(), "agent")
	agentRequest := contracts.InstallRequest{PlatformRoot: agentRoot, Platform: contracts.VersionSelector{Channel: contracts.ChannelStable}, ServiceProfile: "default", Plugins: []contracts.ComponentRequest{{ID: "user-plugin"}}, Policy: contracts.PolicyCompatible}
	agentData, err := json.Marshal(agentRequest)
	if err != nil {
		t.Fatal(err)
	}
	agentResponse := transport.Plan(agentData, source)
	if !agentResponse.OK {
		t.Fatalf("agent plan = %#v", agentResponse.Error)
	}
	ciRoot := filepath.Join(t.TempDir(), "ci")
	ci, err := (contracts.InstallRequest{PlatformRoot: ciRoot, Platform: contracts.VersionSelector{Channel: contracts.ChannelStable}, ServiceProfile: "default", Plugins: []contracts.ComponentRequest{{ID: "user-plugin"}}, Policy: contracts.PolicyCompatible}).Normalize()
	if err != nil {
		t.Fatal(err)
	}
	ciPlan, err := resolve.Plan(ci, source)
	if err != nil {
		t.Fatal(err)
	}
	humanPlan, err := resolve.Plan(human, source)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(artifactIDs(humanPlan.Artifacts), artifactIDs(agentResponse.Plan.Artifacts)) || !reflect.DeepEqual(artifactIDs(humanPlan.Artifacts), artifactIDs(ciPlan.Artifacts)) {
		t.Fatalf("transport artifact sets differ: human=%v agent=%v ci=%v", artifactIDs(humanPlan.Artifacts), artifactIDs(agentResponse.Plan.Artifacts), artifactIDs(ciPlan.Artifacts))
	}
	for _, plan := range []contracts.ResolvedInstallPlan{humanPlan, *agentResponse.Plan, ciPlan} {
		artifacts := &offlineArtifacts{}
		if _, err := runtime.Apply(context.Background(), plan, runtime.Dependencies{Artifacts: artifacts}); err != nil {
			t.Fatalf("%s apply: %v", plan.Request.PlatformRoot, err)
		}
		if !containsArtifact(artifacts.installed, "user-plugin") {
			t.Fatalf("%s did not install selected plugin: %#v", plan.Request.PlatformRoot, artifacts.installed)
		}
		if _, err := receipt.Read(plan.Request.PlatformRoot); err != nil {
			t.Fatalf("%s missing verified receipt: %v", plan.Request.PlatformRoot, err)
		}
	}
}

func artifactIDs(artifacts []contracts.Artifact) []string {
	ids := make([]string, 0, len(artifacts))
	for _, artifact := range artifacts {
		ids = append(ids, artifact.ID+"@"+artifact.Version)
	}
	return ids
}

func containsArtifact(artifacts []contracts.Artifact, id string) bool {
	for _, artifact := range artifacts {
		if artifact.ID == id {
			return true
		}
	}
	return false
}
