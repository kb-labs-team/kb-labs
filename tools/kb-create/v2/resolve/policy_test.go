package resolve

import (
	"encoding/json"
	"github.com/kb-labs/clikit/diag"
	"path/filepath"
	"reflect"
	stdruntime "runtime"
	"sort"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/internal/testfixtures"
)

func policyCatalog() catalog.Catalog {
	var source catalog.Catalog
	if err := json.Unmarshal(testfixtures.ReleaseIndexJSON("3.2.0", "3.0.0", stdruntime.GOOS, stdruntime.GOARCH), &source); err != nil {
		panic(err)
	}
	source.Platforms[0].SDKRange = ">=3.0.0 <4.0.0"
	source.Compatibility.Labels[0].Requires[0].Constraint = ">=3.0.0 <4.0.0"
	source.SDKs = append(source.SDKs, catalog.Component{ID: "sdk", Version: "3.2.0", Package: "@kb/sdk", Tarball: "https://example.test/sdk-3.2.0.tgz", SHA256: "sdk-3.2.0"})
	source.Compatibility.Labels = append(source.Compatibility.Labels, catalog.CompatibilityLabel{
		ID: "sdk@3.2.0", Kind: "sdk", ArtifactID: "sdk", Version: "3.2.0", Status: "prepared", ValidatedBy: []string{"test"},
	})
	source.Compatibility.Labels[2].Requires = append(source.Compatibility.Labels[2].Requires, catalog.CompatibilityRelation{Label: "sdk@3.2.0"})
	return source
}

// case: S-053.2
func TestValidJourneyReleaseIndexResolvesPolicyIncompatibility(t *testing.T) {
	index, err := catalog.LoadFile(filepath.Join("../../../../e2e/platform/fixtures/installer-cases",
		"compatibility-matrix-linux-arm64.json"))
	if err != nil {
		t.Fatalf("valid compatibility fixture did not load: %v", err)
	}
	request := contracts.InstallRequest{PlatformRoot: t.TempDir(),
		Platform: contracts.VersionSelector{Version: "3.2.0"},
		SDK:      contracts.VersionSelector{Version: "3.2.0"},
		Policy:   contracts.PolicyStrict}
	_, err = planWithFixtureProvenanceOptions(request, index, Options{OS: "linux", Arch: "arm64"})
	launcherErr, ok := err.(*diag.Diag)
	if !ok || launcherErr.Code != contracts.CodeIncompatibleComponents ||
		launcherErr.Meta["kind"] != "sdk" || launcherErr.Meta["id"] != "sdk" || launcherErr.Meta["selectedVersion"] != "3.2.0" ||
		launcherErr.Meta["requiredRange"] != ">=3.0.0 <4.0.0" ||
		launcherErr.Hint != "Use an exact platform/SDK pair from the release matrix or choose --policy compatible." {
		t.Fatalf("strict policy did not produce the indexed SDK incompatibility: %#v", err)
	}
	request.Policy = contracts.PolicyCompatible
	if _, err := planWithFixtureProvenanceOptions(request, index, Options{OS: "linux", Arch: "arm64"}); err != nil {
		t.Fatalf("compatible policy rejected the SDK admitted by the valid fixture: %v", err)
	}
}

func TestStrictRequiresExactMatrixRelationAndCompatibleUsesMatrixRange(t *testing.T) {
	request := contracts.InstallRequest{PlatformRoot: "/tmp/kb-policy", Platform: contracts.VersionSelector{Version: "3.2.0"}, SDK: contracts.VersionSelector{Version: "3.2.0"}, Policy: contracts.PolicyStrict}
	if _, err := planWithFixtureProvenance(request, policyCatalog()); err == nil {
		t.Fatal("strict policy accepted an SDK without an exact matrix relation")
	} else if launcherErr, ok := err.(*diag.Diag); !ok || launcherErr.Code != contracts.CodeIncompatibleComponents || launcherErr.Meta["kind"] != "sdk" || launcherErr.Meta["id"] != "sdk" || launcherErr.Meta["selectedVersion"] != "3.2.0" || launcherErr.Meta["requiredRange"] != ">=3.0.0 <4.0.0" || launcherErr.Hint != "Use an exact platform/SDK pair from the release matrix or choose --policy compatible." {
		t.Fatalf("strict matrix error = %#v", err)
	}
	request.Policy = contracts.PolicyCompatible
	plan, err := planWithFixtureProvenance(request, policyCatalog())
	if err != nil {
		t.Fatalf("compatible policy rejected SDK admitted by the matrix range: %v", err)
	}
	if plan.PlatformChannel != "stable" {
		t.Fatalf("platform channel = %q", plan.PlatformChannel)
	}
}

func TestCompatiblePolicyUsesPrereleaseAwareComparatorRanges(t *testing.T) {
	source := policyCatalog()
	source.Platforms[0].SDKRange = ">=3.0.0 <4.0.0 || ^5.1.0"
	source.Compatibility.Labels[0].Requires[0].Constraint = ">=3.0.0 <4.0.0 || ^5.1.0"
	source.SDKs = append(source.SDKs, catalog.Component{ID: "sdk", Version: "3.3.0-rc.2", Package: "@kb/sdk", SHA256: "sdk-rc"})
	source.Compatibility.Labels = append(source.Compatibility.Labels, catalog.CompatibilityLabel{ID: "sdk@3.3.0-rc.2", Kind: "sdk", ArtifactID: "sdk", Version: "3.3.0-rc.2", Status: "prepared", ValidatedBy: []string{"test"}})
	source.Compatibility.Labels[2].Requires = append(source.Compatibility.Labels[2].Requires, catalog.CompatibilityRelation{Label: "sdk@3.3.0-rc.2"})
	request := contracts.InstallRequest{PlatformRoot: "/tmp/kb-policy", Platform: contracts.VersionSelector{Version: "3.2.0"}, SDK: contracts.VersionSelector{Version: "3.3.0-rc.2"}, Policy: contracts.PolicyCompatible}
	if _, err := planWithFixtureProvenance(request, source); err != nil {
		t.Fatalf("compatible policy rejected a prerelease admitted by the range: %v", err)
	}
}

func TestIncompatibleComponentErrorExposesRangeAndRemediationHint(t *testing.T) {
	err := compatible("=3.2.0", "3.3.0", "adapter", "fixture-adapter", "adapter fixture-adapter platform", OperationInstall)
	launcherErr, ok := err.(*diag.Diag)
	if !ok || launcherErr.Code != contracts.CodeIncompatibleComponents {
		t.Fatalf("component error = %#v", err)
	}
	if launcherErr.Meta["kind"] != "adapter" || launcherErr.Meta["id"] != "fixture-adapter" || launcherErr.Meta["requiredRange"] != "=3.2.0" || launcherErr.Meta["selectedVersion"] != "3.3.0" {
		t.Fatalf("component error details = %#v", launcherErr.Meta)
	}
	if len(launcherErr.Meta) != 4 {
		t.Fatalf("component error has non-canonical detail aliases: %#v", launcherErr.Meta)
	}
	if launcherErr.Hint != "Choose compatible versions or pass an explicit supported provider." {
		t.Fatalf("component error hint = %q", launcherErr.Hint)
	}
}

func TestPlanWithUpdateClassifiesDeclaredRangeIncompatibilityAtResolution(t *testing.T) {
	source := policyCatalog()
	source.Platforms[0].SDKRange = "<3.0.0"
	request := contracts.InstallRequest{
		PlatformRoot: t.TempDir(),
		Platform:     contracts.VersionSelector{Version: "3.2.0"},
		SDK:          contracts.VersionSelector{Version: "3.2.0"},
		Policy:       contracts.PolicyCompatible,
	}
	_, err := PlanWith(request, source, Options{Operation: OperationUpdate})
	failure, ok := err.(*diag.Diag)
	if !ok || failure.Code != contracts.CodeUpdateIncompatible || failure.Meta["kind"] != "sdk" ||
		failure.Meta["id"] != "sdk" || failure.Meta["selectedVersion"] != "3.2.0" || failure.Meta["requiredRange"] != "<3.0.0" {
		t.Fatalf("update plan incompatibility = %#v", err)
	}
}

// case: S-053.3
func TestUpdateValidationRefusesDowngradeAndNamesInstalledPluginRange(t *testing.T) {
	active := contracts.InstallReceipt{Plan: contracts.ResolvedInstallPlan{
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "3.2.0"},
		Artifacts:    []contracts.Artifact{{ID: "fixture-compat", Kind: "plugin", Version: "1.0.0", PlatformRange: "=3.2.0"}},
	}}
	target := contracts.ResolvedInstallPlan{ServiceGraph: contracts.ServiceGraph{PlatformVersion: "3.1.0"}}
	_, err := ValidateUpdate(active, target, policyCatalog())
	if launcherErr, ok := err.(*diag.Diag); !ok || launcherErr.Code != "KB_UPDATE_DOWNGRADE_REFUSED" || launcherErr.Hint != "use `kb-create rollback`" {
		t.Fatalf("downgrade error = %#v", err)
	}
	target.ServiceGraph.PlatformVersion = "3.3.0"
	_, err = ValidateUpdate(active, target, policyCatalog())
	launcherErr, ok := err.(*diag.Diag)
	if !ok || launcherErr.Code != contracts.CodeUpdateIncompatible || launcherErr.Meta["kind"] != "plugin" || launcherErr.Meta["id"] != "fixture-compat" || launcherErr.Meta["requiredRange"] != "=3.2.0" || launcherErr.Meta["selectedVersion"] != "3.3.0" {
		t.Fatalf("component compatibility error = %#v", err)
	}
	envelope, envelopeErr := diag.ToEnvelope(launcherErr)
	if envelopeErr != nil {
		t.Fatalf("component compatibility diagnostic violates its catalog: %v", envelopeErr)
	}
	entry, ok := diag.LookupCatalog(contracts.CodeUpdateIncompatible)
	if !ok || envelope.Hint == entry.Hint {
		t.Fatalf("component compatibility hint was not rendered from the catalog: %q", envelope.Hint)
	}
	wantDetails := append([]string(nil), entry.TemplateParameters...)
	gotDetails := make([]string, 0, len(envelope.Details))
	for name := range envelope.Details {
		gotDetails = append(gotDetails, name)
	}
	sort.Strings(wantDetails)
	sort.Strings(gotDetails)
	if !reflect.DeepEqual(gotDetails, wantDetails) {
		t.Fatalf("component compatibility details = %v, catalog declares %v", gotDetails, wantDetails)
	}
}

// case: S-053.1
func TestStrictPolicyStillAcceptsDeclaredSemverRanges(t *testing.T) {
	if err := compatible("^2.0.0", "2.0.0", "plugin", "commit", "plugin commit platform", OperationInstall); err != nil {
		t.Fatalf("strict selection rejected a version its declared range admits: %v", err)
	}
}

// case: S-053.8
func TestPlanRefusesPluginOutsideChannelSelectedSDKRange(t *testing.T) {
	source := policyCatalog()
	source.Plugins = append(source.Plugins, catalog.Component{
		ID:            "fixture-sdk-incompat",
		Version:       "1.0.0",
		Package:       "@kb/fixture-sdk-incompat",
		Tarball:       "https://example.test/fixture-sdk-incompat.tgz",
		SHA256:        "fixture-sdk-incompat",
		PlatformRange: ">=3.0.0",
		SDKRange:      "<3.0.0",
	})
	request := contracts.InstallRequest{
		PlatformRoot: t.TempDir(),
		Platform:     contracts.VersionSelector{Version: "3.2.0"},
		SDK:          contracts.VersionSelector{Channel: contracts.ChannelStable},
		Plugins:      []contracts.ComponentRequest{{ID: "fixture-sdk-incompat", Version: contracts.VersionSelector{Version: "1.0.0"}}},
		Policy:       contracts.PolicyCompatible,
	}
	_, err := planWithFixtureProvenance(request, source)
	if err == nil {
		t.Fatal("expected plan to refuse plugin outside channel-selected SDK range")
	}
	diagErr, ok := err.(*diag.Diag)
	if !ok || diagErr.Code != contracts.CodeIncompatibleComponents {
		t.Fatalf("expected CodeIncompatibleComponents, got %#v", err)
	}
	channelSDK := "3.0.0"
	if diagErr.Meta["kind"] != "plugin" || diagErr.Meta["id"] != "fixture-sdk-incompat" ||
		diagErr.Meta["selectedVersion"] != channelSDK || diagErr.Meta["requiredRange"] != "<3.0.0" {
		t.Fatalf("plugin SDK range details = %#v", diagErr.Meta)
	}
	if diagErr.Hint != "Choose compatible versions or pass an explicit supported provider." {
		t.Fatalf("plugin SDK range hint = %q", diagErr.Hint)
	}
}

func TestValidateUpdateRejectsActiveReceiptWithMissingArtifactIdentity(t *testing.T) {
	active := contracts.InstallReceipt{Plan: contracts.ResolvedInstallPlan{
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "3.2.0"},
		Artifacts:    []contracts.Artifact{{Kind: "plugin", Version: "1.0.0"}},
	}}
	target := contracts.ResolvedInstallPlan{ServiceGraph: contracts.ServiceGraph{PlatformVersion: "3.3.0"}}
	_, err := ValidateUpdate(active, target, policyCatalog())
	if err == nil {
		t.Fatal("expected ValidateUpdate to reject receipt with missing artifact identity")
	}
	diagErr, ok := err.(*diag.Diag)
	if !ok || diagErr.Code != contracts.CodeArtifactIdentityInvalid {
		t.Fatalf("expected CodeArtifactIdentityInvalid, got %#v", err)
	}
}

func TestPlanMissingPlatformProducesCanonicalPlatformIdentity(t *testing.T) {
	source := policyCatalog()
	request := contracts.InstallRequest{
		PlatformRoot: t.TempDir(),
		Platform:     contracts.VersionSelector{Version: "9.9.9"},
	}
	_, err := planWithFixtureProvenance(request, source)
	if err == nil {
		t.Fatal("expected plan to refuse absent platform")
	}
	diagErr, ok := err.(*diag.Diag)
	if !ok || diagErr.Code != contracts.CodeIncompatibleComponents {
		t.Fatalf("expected CodeIncompatibleComponents, got %#v", err)
	}
	if diagErr.Meta["kind"] != "platform" || diagErr.Meta["id"] != "platform" || diagErr.Meta["selectedVersion"] != "9.9.9" {
		t.Fatalf("platform error details = %#v, want kind=platform id=platform selectedVersion=9.9.9", diagErr.Meta)
	}
}
