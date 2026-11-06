package catalog

import (
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

func TestSealAndVerifyImmutableReleaseIndex(t *testing.T) {
	source, err := Seal(compatibilitySealFixture())
	if err != nil || source.Digest == "" || Verify(source) != nil {
		t.Fatalf("source/error = %#v / %v", source, err)
	}
	source.Platforms[0].Package = "@kb/tampered"
	if err := Verify(source); err == nil {
		t.Fatal("expected digest mismatch")
	}
}

func TestValidateRejectsChannelOutsideIndex(t *testing.T) {
	source := compatibilitySealFixture()
	source.Channels[contracts.ChannelStable] = "missing"
	_, err := Seal(source)
	if err == nil {
		t.Fatal("expected absent channel target")
	}
}

func TestValidateRejectsCompatibilityLabelOutsideIndex(t *testing.T) {
	source := compatibilitySealFixture()
	source.Compatibility.Labels = append(source.Compatibility.Labels, CompatibilityLabel{
		ID: "sdk@2.1.0", Kind: "sdk", ArtifactID: "sdk", Version: "2.1.0", Status: "prepared", ValidatedBy: []string{"stage"},
	})
	_, err := Seal(source)
	if err == nil || !strings.Contains(err.Error(), `references absent sdk artifact "sdk"@2.1.0`) {
		t.Fatal("expected compatibility label to reference an indexed SDK")
	}
}

func TestCheckCompatibilityRequiresExplicitPlatformSDKRelation(t *testing.T) {
	source := Catalog{Compatibility: &CompatibilityMatrix{Schema: CompatibilitySchema, Labels: []CompatibilityLabel{
		{ID: "platform@2.0.0", Kind: "platform", ArtifactID: "platform", Version: "2.0.0", Requires: []CompatibilityRelation{{Label: "sdk@2.1.0"}}, Status: "prepared", ValidatedBy: []string{"stage"}},
		{ID: "sdk@2.1.0", Kind: "sdk", ArtifactID: "sdk", Version: "2.1.0", Status: "prepared", ValidatedBy: []string{"stage"}},
		{ID: "binary:kb-dev@2.0.0:linux/amd64", Kind: "binary", ArtifactID: "kb-dev", Version: "2.0.0", Requires: []CompatibilityRelation{{Label: "platform@2.0.0"}, {Label: "sdk@2.1.0"}}, Status: "prepared", ValidatedBy: []string{"stage"}},
	}}}
	if err := CheckCompatibility(source, "2.0.0", "2.1.0", "kb-dev", "linux", "amd64", contracts.PolicyStrict); err != nil {
		t.Fatal(err)
	}
	if err := CheckCompatibility(source, "2.0.0", "2.2.0", "", "", "", contracts.PolicyStrict); err == nil {
		t.Fatal("expected unrelated SDK to be rejected")
	}
}

func TestSealRejectsShippedBinaryWithoutCompatibilityRelation(t *testing.T) {
	_, err := Seal(Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Compatibility: &CompatibilityMatrix{Schema: CompatibilitySchema, Labels: []CompatibilityLabel{
			{ID: "platform@2.0.0", Kind: "platform", ArtifactID: "platform", Version: "2.0.0", Requires: []CompatibilityRelation{{Label: "sdk@2.0.0"}}, Status: "prepared", ValidatedBy: []string{"stage"}},
			{ID: "sdk@2.0.0", Kind: "sdk", ArtifactID: "sdk", Version: "2.0.0", Status: "prepared", ValidatedBy: []string{"stage"}},
		}},
		Platforms: []PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}},
			Binaries: []Binary{{ID: "kb-create", OS: "linux", Arch: "amd64", URL: "https://example.test/kb-create", SHA256: "binary", Filename: "kb-create"}},
		}},
		SDKs: []Component{{ID: "sdk", Version: "2.0.0", Package: "@kb/sdk", Tarball: "https://example.test/sdk.tgz", SHA256: "sdk"}},
	})
	if err == nil || !strings.Contains(err.Error(), "binary") {
		t.Fatalf("Seal error = %v, want missing shipped binary compatibility", err)
	}
}

func TestSealRejectsShippedBinaryMissingAnAdmittedSDKRelation(t *testing.T) {
	_, err := Seal(Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Compatibility: &CompatibilityMatrix{Schema: CompatibilitySchema, Labels: []CompatibilityLabel{
			{ID: "platform@2.0.0", Kind: "platform", ArtifactID: "platform", Version: "2.0.0", Requires: []CompatibilityRelation{{Label: "sdk@2.1.0"}}, Status: "prepared", ValidatedBy: []string{"stage"}},
			{ID: "sdk@2.1.0", Kind: "sdk", ArtifactID: "sdk", Version: "2.1.0", Status: "prepared", ValidatedBy: []string{"stage"}},
			{ID: "binary:kb-create@2.0.0:linux/amd64", Kind: "binary", ArtifactID: "kb-create", Version: "2.0.0",
				Requires: []CompatibilityRelation{{Label: "platform@2.0.0"}}, Status: "prepared", ValidatedBy: []string{"stage"}},
		}},
		Platforms: []PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
			SDKRange: ">=2.0.0 <3.0.0", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}},
			Binaries: []Binary{{ID: "kb-create", OS: "linux", Arch: "amd64", URL: "https://example.test/kb-create", SHA256: "binary", Filename: "kb-create"}},
		}},
		SDKs: []Component{{ID: "sdk", Version: "2.1.0", Package: "@kb/sdk", Tarball: "https://example.test/sdk.tgz", SHA256: "sdk"}},
	})
	if err == nil || !strings.Contains(err.Error(), "SDK 2.1.0") {
		t.Fatalf("Seal error = %v, want missing admitted SDK relation", err)
	}
}

func TestSealRequiresPlatformSDKRelationsAndRecords(t *testing.T) {
	tests := []struct {
		name   string
		want   string
		mutate func(*Catalog)
	}{
		{
			name: "platform label has no SDK relation",
			want: "has no SDK relation",
			mutate: func(source *Catalog) {
				source.Compatibility.Labels[0].Requires = nil
			},
		},
		{
			name: "platform label is absent",
			want: `no platform label "platform@2.0.0"`,
			mutate: func(source *Catalog) {
				labels := make([]CompatibilityLabel, 0, len(source.Compatibility.Labels))
				for _, label := range source.Compatibility.Labels {
					if label.ID == "platform@2.0.0" {
						continue
					}
					requires := label.Requires[:0]
					for _, relation := range label.Requires {
						if relation.Label != "platform@2.0.0" {
							requires = append(requires, relation)
						}
					}
					label.Requires = requires
					labels = append(labels, label)
				}
				source.Compatibility.Labels = labels
			},
		},
		{
			name: "related SDK record is absent",
			want: `references absent sdk artifact "sdk"@2.0.0`,
			mutate: func(source *Catalog) {
				source.SDKs = nil
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			source := compatibilitySealFixture()
			test.mutate(&source)
			_, err := Seal(source)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Seal error = %v, want containing %q", err, test.want)
			}
		})
	}
}

func compatibilitySealFixture() Catalog {
	platformID, sdkID := "platform@2.0.0", "sdk@2.0.0"
	return Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Compatibility: &CompatibilityMatrix{Schema: CompatibilitySchema, Labels: []CompatibilityLabel{
			{ID: platformID, Kind: "platform", ArtifactID: "platform", Version: "2.0.0", Requires: []CompatibilityRelation{{Label: sdkID}}, Status: "prepared", ValidatedBy: []string{"test"}},
			{ID: sdkID, Kind: "sdk", ArtifactID: "sdk", Version: "2.0.0", Status: "prepared", ValidatedBy: []string{"test"}},
			{ID: "binary:kb-create@2.0.0:linux/amd64", Kind: "binary", ArtifactID: "kb-create", Version: "2.0.0", Requires: []CompatibilityRelation{{Label: platformID}, {Label: sdkID}}, Status: "prepared", ValidatedBy: []string{"test"}},
		}},
		Platforms: []PlatformBundle{{SupportedTargets: []BinaryTarget{{OS: "linux", Arch: "amd64"}}, ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
			Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}},
			Binaries: []Binary{{ID: "kb-create", OS: "linux", Arch: "amd64", URL: "https://example.test/kb-create", SHA256: "binary", Filename: "kb-create"}}}},
		SDKs: []Component{{ID: "sdk", Version: "2.0.0", Package: "@kb/sdk", Tarball: "https://example.test/sdk.tgz", SHA256: "sdk"}},
	}
}

// case: S-214.9
func TestCompatibilityMatrixAcceptsIndependentPlatformSDKAndBinaryVersions(t *testing.T) {
	base := Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "4.0.0"},
		Compatibility: &CompatibilityMatrix{Schema: CompatibilitySchema, Labels: []CompatibilityLabel{
			{ID: "platform@4.0.0", Kind: "platform", ArtifactID: "platform", Version: "4.0.0", Requires: []CompatibilityRelation{{Label: "sdk@3.2.0"}}, Status: "prepared", ValidatedBy: []string{"stage"}},
			{ID: "sdk@3.2.0", Kind: "sdk", ArtifactID: "sdk", Version: "3.2.0", Status: "prepared", ValidatedBy: []string{"stage"}},
			{ID: "binary:kb-create@5.1.0:linux/amd64", Kind: "binary", ArtifactID: "kb-create", Version: "5.1.0", Requires: []CompatibilityRelation{{Label: "platform@4.0.0"}, {Label: "sdk@3.2.0"}}, Status: "prepared", ValidatedBy: []string{"stage"}},
		}},
		Platforms: []PlatformBundle{{SupportedTargets: []BinaryTarget{{OS: "linux", Arch: "amd64"}}, ID: "platform", Version: "4.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}, Binaries: []Binary{{ID: "kb-create", OS: "linux", Arch: "amd64", URL: "https://example.test/kb-create", SHA256: "binary", Filename: "kb-create"}}}},
		SDKs:      []Component{{ID: "sdk", Version: "3.2.0", Package: "@kb/sdk", Tarball: "https://example.test/sdk.tgz", SHA256: "sdk"}},
	}
	sealed, err := Seal(base)
	if err != nil {
		t.Fatalf("Seal rejected independent versions: %v", err)
	}
	if err := CheckCompatibility(sealed, "4.0.0", "3.2.0", "kb-create", "linux", "amd64", contracts.PolicyStrict); err != nil {
		t.Fatalf("CheckCompatibility rejected explicit relations: %v", err)
	}

	missingBinaryRelation := base
	missingBinaryRelation.Compatibility = &CompatibilityMatrix{Schema: CompatibilitySchema, Labels: append([]CompatibilityLabel(nil), base.Compatibility.Labels...)}
	missingBinaryRelation.Compatibility.Labels[2].Requires = []CompatibilityRelation{{Label: "platform@4.0.0"}}
	if _, err := Seal(missingBinaryRelation); err == nil || !strings.Contains(err.Error(), "SDK 3.2.0") {
		t.Fatalf("Seal error = %v, want missing binary-to-SDK relation", err)
	}
}
