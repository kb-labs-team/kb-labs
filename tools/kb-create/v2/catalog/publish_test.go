package catalog

import (
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

func TestSealAndVerifyImmutableReleaseIndex(t *testing.T) {
	source, err := Seal(Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "artifact", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}}})
	if err != nil || source.Digest == "" || Verify(source) != nil {
		t.Fatalf("source/error = %#v / %v", source, err)
	}
	source.Platforms[0].Package = "@kb/tampered"
	if err := Verify(source); err == nil {
		t.Fatal("expected digest mismatch")
	}
}

func TestValidateRejectsChannelOutsideIndex(t *testing.T) {
	_, err := Seal(Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "missing"}, Platforms: []PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "artifact", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}}})
	if err == nil {
		t.Fatal("expected absent channel target")
	}
}

func TestValidateRejectsCompatibilityLabelOutsideIndex(t *testing.T) {
	_, err := Seal(Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Compatibility: &CompatibilityMatrix{
			Schema: CompatibilitySchema,
			Labels: []CompatibilityLabel{{ID: "platform@2.0.0", Kind: "platform", ArtifactID: "platform", Version: "2.0.0", Status: "prepared", ValidatedBy: []string{"stage"}}, {ID: "sdk@2.1.0", Kind: "sdk", ArtifactID: "sdk", Version: "2.1.0", Status: "prepared", ValidatedBy: []string{"stage"}}},
		},
		Platforms: []PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "artifact", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}},
	})
	if err == nil {
		t.Fatal("expected compatibility label to reference an indexed SDK")
	}
}

func TestCheckCompatibilityRequiresExplicitPlatformSDKRelation(t *testing.T) {
	source := Catalog{Compatibility: &CompatibilityMatrix{Schema: CompatibilitySchema, Labels: []CompatibilityLabel{
		{ID: "platform@2.0.0", Kind: "platform", ArtifactID: "platform", Version: "2.0.0", Requires: []CompatibilityRelation{{Label: "sdk@2.1.0"}}, Status: "prepared", ValidatedBy: []string{"stage"}},
		{ID: "sdk@2.1.0", Kind: "sdk", ArtifactID: "sdk", Version: "2.1.0", Status: "prepared", ValidatedBy: []string{"stage"}},
		{ID: "binary:kb-dev@2.0.0:linux/amd64", Kind: "binary", ArtifactID: "kb-dev", Version: "2.0.0", Requires: []CompatibilityRelation{{Label: "platform@2.0.0"}, {Label: "sdk@2.1.0"}}, Status: "prepared", ValidatedBy: []string{"stage"}},
	}}}
	if err := CheckCompatibility(source, "2.0.0", "2.1.0", "kb-dev", "linux", "amd64"); err != nil {
		t.Fatal(err)
	}
	if err := CheckCompatibility(source, "2.0.0", "2.2.0", "", "", ""); err == nil {
		t.Fatal("expected unrelated SDK to be rejected")
	}
}
