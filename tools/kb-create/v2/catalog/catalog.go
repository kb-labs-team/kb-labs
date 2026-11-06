// Package catalog defines the small, immutable release index consumed before
// artifacts are installed. It is deliberately not a copy of every manifest:
// manifests remain the source of truth after their selected artifacts exist.
package catalog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/semrange"
)

const Schema = "kb.create.release-index/v2"

type Catalog struct {
	Schema        string                       `json:"schema"`
	Digest        string                       `json:"digest"`
	Channels      map[contracts.Channel]string `json:"channels"`
	Compatibility *CompatibilityMatrix         `json:"compatibility,omitempty"`
	Platforms     []PlatformBundle             `json:"platforms"`
	SDKs          []Component                  `json:"sdks"`
	Plugins       []Component                  `json:"plugins"`
	Adapters      []Adapter                    `json:"adapters"`
	Provenance    []ArtifactProvenance         `json:"provenance,omitempty"`
}

// ArtifactProvenance binds an immutable package version to its source revision
// and to either the compiled dist tree or complete static package tree packed
// into its registry tarball.
type ArtifactProvenance struct {
	contracts.ArtifactProvenance
	Package string `json:"package"`
	Version string `json:"version"`
}

// CompatibilityMatrix is release-owned evidence for all currently published
// platform, SDK and binary labels.
// It intentionally contains concrete versions: semver major/minor equality is
// not a compatibility guarantee for pre-stable releases.
type CompatibilityMatrix struct {
	Schema string               `json:"schema"`
	Labels []CompatibilityLabel `json:"labels"`
}

type CompatibilityLabel struct {
	ID          string                  `json:"id"`
	Kind        string                  `json:"kind"`
	ArtifactID  string                  `json:"artifactId"`
	Version     string                  `json:"version"`
	Requires    []CompatibilityRelation `json:"requires,omitempty"`
	Status      string                  `json:"status"`
	ValidatedBy []string                `json:"validatedBy"`
}

type CompatibilityRelation struct {
	Label      string `json:"label"`
	Constraint string `json:"constraint,omitempty"`
}

const CompatibilitySchema = "kb.release-compatibility/2"

// Seal normalizes a release index and records the SHA-256 digest of its
// canonical payload. Publishing calls this after manifest export; consuming
// calls Validate before resolving anything.
func Seal(source Catalog) (Catalog, error) {
	if source.Schema == "" {
		source.Schema = Schema
	}
	source.Digest = ""
	if err := Validate(source); err != nil {
		return Catalog{}, err
	}
	digest, err := digest(source)
	if err != nil {
		return Catalog{}, err
	}
	source.Digest = digest
	return source, nil
}

func Validate(source Catalog) error {
	if err := CheckSchema(source.Schema); err != nil {
		return err
	}
	if len(source.Platforms) == 0 {
		return fmt.Errorf("release index contains no platform bundles")
	}
	provenanceVersions := make(map[string]struct{}, len(source.Provenance))
	for _, provenance := range source.Provenance {
		if provenance.Package == "" || provenance.Version == "" || provenance.SourceRevision == "" || provenance.Integrity == "" || !provenance.ArtifactProvenance.HasContentDigest() {
			return fmt.Errorf("artifact provenance must declare package, version, source revision, tarball integrity and a valid scoped content digest")
		}
		key := provenance.Package + "@" + provenance.Version
		if _, exists := provenanceVersions[key]; exists {
			return fmt.Errorf("duplicate artifact provenance for %s", key)
		}
		provenanceVersions[key] = struct{}{}
	}
	if source.Compatibility != nil {
		if err := validateCompatibility(*source.Compatibility, source); err != nil {
			return err
		}
	}
	for channel, version := range source.Channels {
		if channel != contracts.ChannelStable && channel != contracts.ChannelCanary && channel != contracts.ChannelExperimental {
			return fmt.Errorf("unsupported release channel %q", channel)
		}
		if _, ok := findPlatform(source.Platforms, version); !ok {
			return fmt.Errorf("channel %q points to absent platform version %q", channel, version)
		}
	}
	seen := map[string]bool{}
	for _, platform := range source.Platforms {
		if platform.ID == "" || platform.Version == "" || platform.Package == "" || platform.SHA256 == "" || platform.Tarball == "" {
			return fmt.Errorf("platform bundle must declare ID, version, package, tarball and sha256")
		}
		key := platform.ID + "@" + platform.Version
		if seen[key] {
			return fmt.Errorf("duplicate platform bundle %q", key)
		}
		seen[key] = true
		if len(platform.Profiles) == 0 {
			return fmt.Errorf("platform bundle %q has no service profile", key)
		}
		if platform.Host == nil {
			return fmt.Errorf("platform bundle %q declares no host", key)
		}
		if err := platform.Host.Validate(); err != nil {
			return fmt.Errorf("platform bundle %q declares an invalid host: %w", key, err)
		}
		if _, err := semrange.ParseRange(platform.SDKRange); err != nil {
			return fmt.Errorf("platform %s SDK range is invalid: %w", key, err)
		}
		for _, binary := range platform.Binaries {
			if binary.ID == "" || binary.OS == "" || binary.Arch == "" || binary.URL == "" || binary.SHA256 == "" || binary.Filename == "" {
				return fmt.Errorf("platform bundle %q has incomplete binary artifact", key)
			}
		}
		for _, member := range platform.Members {
			if member.ID == "" || member.Version == "" || member.Package == "" || member.SHA256 == "" || member.Tarball == "" {
				return fmt.Errorf("platform bundle %q has incomplete member artifact", key)
			}
		}
	}
	for _, component := range append(append([]Component(nil), source.SDKs...), source.Plugins...) {
		if component.ID == "" || component.Version == "" || component.Package == "" || component.SHA256 == "" || component.Tarball == "" {
			return fmt.Errorf("component must declare ID, version, package, tarball and sha256")
		}
		if err := validateComponentRanges(component); err != nil {
			return err
		}
	}
	for _, adapter := range source.Adapters {
		if adapter.ID == "" || adapter.Version == "" || adapter.Package == "" || adapter.SHA256 == "" || adapter.Tarball == "" {
			return fmt.Errorf("adapter must declare ID, version, package, tarball and sha256")
		}
		if err := validateComponentRanges(adapter.Component); err != nil {
			return err
		}
	}
	return nil
}

// CheckCompatibility is the runtime decision boundary for the release-owned
// matrix. Package ranges remain useful for plugin/provider declarations, but
// platform, SDK and binary selection is accepted only when the candidate
// labels are explicitly related in the sealed index.
func CheckCompatibility(source Catalog, platformVersion, sdkVersion, binaryID, os, arch string, policy contracts.CompatibilityPolicy) error {
	if source.Compatibility == nil {
		return fmt.Errorf("release index has no compatibility matrix")
	}
	platformID := "platform@" + platformVersion
	platform, ok := compatibilityLabel(source.Compatibility.Labels, platformID, "platform")
	if !ok {
		return fmt.Errorf("compatibility matrix has no platform label %q", platformID)
	}
	if sdkVersion != "" {
		sdkID := "sdk@" + sdkVersion
		compatible, err := requiresCompatibleLabel(platform, sdkID, sdkVersion, policy)
		if err != nil {
			return fmt.Errorf("compatibility matrix relation for %s: %w", sdkID, err)
		}
		if _, ok := compatibilityLabel(source.Compatibility.Labels, sdkID, "sdk"); !ok || !compatible {
			return fmt.Errorf("compatibility matrix does not relate %s to %s", platformID, sdkID)
		}
	}
	if binaryID != "" {
		binary, ok := compatibilityBinaryLabel(source.Compatibility.Labels, Binary{ID: binaryID, OS: os, Arch: arch}, platformID)
		if !ok || (sdkVersion != "" && !requiresLabel(binary, "sdk@"+sdkVersion)) {
			return fmt.Errorf("compatibility matrix does not relate binary %s to the selected platform/SDK", binaryID)
		}
	}
	return nil
}

func requiresCompatibleLabel(label CompatibilityLabel, wanted, version string, policy contracts.CompatibilityPolicy) (bool, error) {
	var candidate semrange.Version
	candidateParsed := false
	for _, relation := range label.Requires {
		if relation.Label == wanted {
			return true, nil
		}
		if policy == contracts.PolicyCompatible && relation.Constraint != "" {
			rangeValue, err := semrange.ParseRange(relation.Constraint)
			if err != nil {
				return false, err
			}
			if !candidateParsed {
				candidate, err = semrange.ParseVersion(version)
				if err != nil {
					return false, err
				}
				candidateParsed = true
			}
			if rangeValue.Satisfies(candidate) {
				return true, nil
			}
		}
	}
	return false, nil
}

// PlatformSDKVersion returns the SDK version related to platformVersion in the
// compatibility matrix, or empty string if no exact relation exists.
func PlatformSDKVersion(source Catalog, platformVersion string) string {
	if source.Compatibility != nil {
		platformLabel := "platform@" + platformVersion
		for _, label := range source.Compatibility.Labels {
			if label.ID != platformLabel {
				continue
			}
			for _, relation := range label.Requires {
				if strings.HasPrefix(relation.Label, "sdk@") {
					return strings.TrimPrefix(relation.Label, "sdk@")
				}
			}
		}
	}
	return ""
}

func validateComponentRanges(component Component) error {
	if _, err := semrange.ParseRange(component.PlatformRange); err != nil {
		return fmt.Errorf("component %s platform range is invalid: %w", component.ID, err)
	}
	if _, err := semrange.ParseRange(component.SDKRange); err != nil {
		return fmt.Errorf("component %s SDK range is invalid: %w", component.ID, err)
	}
	return nil
}

func compatibilityLabel(labels []CompatibilityLabel, id, kind string) (CompatibilityLabel, bool) {
	for _, label := range labels {
		if label.ID == id && label.Kind == kind {
			return label, true
		}
	}
	return CompatibilityLabel{}, false
}

func compatibilityBinaryLabel(labels []CompatibilityLabel, binary Binary, platformID string) (CompatibilityLabel, bool) {
	for _, label := range labels {
		wantedID := fmt.Sprintf("binary:%s@%s:%s/%s", binary.ID, label.Version, binary.OS, binary.Arch)
		if label.Kind == "binary" && label.ArtifactID == binary.ID && label.ID == wantedID && requiresLabel(label, platformID) {
			return label, true
		}
	}
	return CompatibilityLabel{}, false
}

func requiresLabel(label CompatibilityLabel, wanted string) bool {
	for _, relation := range label.Requires {
		if relation.Label == wanted {
			return true
		}
	}
	return false
}

func validateCompatibility(matrix CompatibilityMatrix, source Catalog) error {
	if matrix.Schema != CompatibilitySchema {
		return fmt.Errorf("unsupported compatibility matrix schema %q", matrix.Schema)
	}
	if len(matrix.Labels) == 0 {
		return fmt.Errorf("compatibility matrix contains no labels")
	}
	known := map[string]bool{}
	for _, label := range matrix.Labels {
		if label.ID == "" || label.Kind == "" || label.ArtifactID == "" || label.Version == "" || label.Status == "" || len(label.ValidatedBy) == 0 {
			return fmt.Errorf("compatibility label must declare id, kind, artifactId, version, status and validation evidence")
		}
		if known[label.ID] {
			return fmt.Errorf("duplicate compatibility label %q", label.ID)
		}
		known[label.ID] = true
		if !compatibilityArtifactExists(source, label) {
			return fmt.Errorf("compatibility label %q references absent %s artifact %q@%s", label.ID, label.Kind, label.ArtifactID, label.Version)
		}
	}
	for _, label := range matrix.Labels {
		for _, relation := range label.Requires {
			if _, err := semrange.ParseRange(relation.Constraint); err != nil {
				return fmt.Errorf("compatibility relation %s -> %s has invalid range: %w", label.ID, relation.Label, err)
			}
		}
		for _, relation := range label.Requires {
			if !known[relation.Label] {
				return fmt.Errorf("compatibility label %q references absent label %q", label.ID, relation.Label)
			}
		}
	}
	sdkByVersion := make(map[string]Component, len(source.SDKs))
	for _, sdk := range source.SDKs {
		sdkByVersion[sdk.Version] = sdk
	}
	for _, platform := range source.Platforms {
		platformID := "platform@" + platform.Version
		platformLabel, ok := compatibilityLabel(matrix.Labels, platformID, "platform")
		if !ok {
			return fmt.Errorf("compatibility matrix has no platform label %q", platformID)
		}
		var sdks []Component
		for _, relation := range platformLabel.Requires {
			if !strings.HasPrefix(relation.Label, "sdk@") {
				continue
			}
			version := strings.TrimPrefix(relation.Label, "sdk@")
			sdk, exists := sdkByVersion[version]
			if !exists {
				return fmt.Errorf("platform %s compatibility label %q relates absent SDK version %q", platform.Version, platformID, version)
			}
			sdks = append(sdks, sdk)
		}
		if len(sdks) == 0 {
			return fmt.Errorf("platform %s compatibility label %q has no SDK relation", platform.Version, platformID)
		}
		for _, shipped := range platform.Binaries {
			binary, ok := compatibilityBinaryLabel(matrix.Labels, shipped, platformID)
			if !ok {
				return fmt.Errorf("compatibility matrix does not relate shipped binary %s to platform %s", shipped.ID, platform.Version)
			}
			for _, sdk := range sdks {
				if !requiresLabel(binary, "sdk@"+sdk.Version) {
					return fmt.Errorf("compatibility matrix does not relate shipped binary %s to SDK %s for platform %s", shipped.ID, sdk.Version, platform.Version)
				}
			}
		}
	}
	return nil
}

func compatibilityArtifactExists(source Catalog, label CompatibilityLabel) bool {
	switch label.Kind {
	case "platform":
		for _, value := range source.Platforms {
			if value.ID == label.ArtifactID && value.Version == label.Version {
				return true
			}
		}
	case "sdk":
		for _, value := range source.SDKs {
			if value.ID == label.ArtifactID && value.Version == label.Version {
				return true
			}
		}
	case "binary":
		for _, platform := range source.Platforms {
			for _, value := range platform.Binaries {
				if value.ID == label.ArtifactID {
					return true
				}
			}
		}
	}
	return false
}

func Verify(source Catalog) error {
	if source.Digest == "" {
		return &indexGateError{gate: "digest", expected: "non-empty SHA-256 digest", actual: "missing", err: fmt.Errorf("release index digest is required")}
	}
	expected := source.Digest
	source.Digest = ""
	if err := Validate(source); err != nil {
		return err
	}
	actual, err := digest(source)
	if err != nil {
		return err
	}
	if !strings.EqualFold(expected, actual) {
		return &indexGateError{gate: "digest", expected: expected, actual: actual,
			err: contracts.NewDiag(contracts.CodeReleaseIndexInvalid, "The release index digest does not match its content.", indexInvalidHint,
				fmt.Errorf("release index digest mismatch"))}
	}
	return nil
}

func digest(source Catalog) (string, error) {
	// Release tooling canonicalizes ordering, so semantically identical exports
	// produce one auditable index digest independent of filesystem ordering.
	sort.Slice(source.Platforms, func(i, j int) bool {
		return source.Platforms[i].ID+source.Platforms[i].Version < source.Platforms[j].ID+source.Platforms[j].Version
	})
	sort.Slice(source.SDKs, func(i, j int) bool {
		return source.SDKs[i].ID+source.SDKs[i].Version < source.SDKs[j].ID+source.SDKs[j].Version
	})
	sort.Slice(source.Plugins, func(i, j int) bool {
		return source.Plugins[i].ID+source.Plugins[i].Version < source.Plugins[j].ID+source.Plugins[j].Version
	})
	sort.Slice(source.Adapters, func(i, j int) bool {
		return source.Adapters[i].ID+source.Adapters[i].Version < source.Adapters[j].ID+source.Adapters[j].Version
	})
	data, err := json.Marshal(source)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func findPlatform(values []PlatformBundle, version string) (PlatformBundle, bool) {
	for _, value := range values {
		if value.Version == version {
			return value, true
		}
	}
	return PlatformBundle{}, false
}

// PlatformBundle is released atomically: core, official services, defaults and
// compatible binaries are one platform decision, not independently guessed.
type PlatformBundle struct {
	ID           string `json:"id"`
	Version      string `json:"version"`
	ReleaseNotes string `json:"releaseNotes,omitempty"`
	Package      string `json:"package"`
	SHA256       string `json:"sha256"`
	Tarball      string `json:"tarball"`
	SizeBytes    int64  `json:"sizeBytes,omitempty"`
	SDKRange     string `json:"sdkRange,omitempty"`
	// MinLauncherVersion is the oldest kb-create launcher allowed to install
	// this platform. Empty means no constraint.
	MinLauncherVersion string                            `json:"minLauncherVersion,omitempty"`
	Profiles           map[string]contracts.ServiceGraph `json:"profiles"`
	// Host is how the launcher runs this platform: the one supervised host
	// process. Every platform bundle declares it; there is no other runner.
	Host     *contracts.HostSpec `json:"host,omitempty"`
	Requires []Requirement       `json:"requires,omitempty"`
	Config   []ConfigRequirement `json:"config,omitempty"`
	Binaries []Binary            `json:"binaries,omitempty"`
	Members  []Component         `json:"members,omitempty"`
}

// Binary is release-owned tooling required by a platform bundle. URLs and
// hashes are immutable release assets, never guessed from a "latest" tag.
type Binary struct {
	ID        string `json:"id"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Filename  string `json:"filename"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
}

type Component struct {
	ID            string              `json:"id"`
	Version       string              `json:"version"`
	Package       string              `json:"package"`
	SHA256        string              `json:"sha256"`
	Tarball       string              `json:"tarball"`
	SizeBytes     int64               `json:"sizeBytes,omitempty"`
	PlatformRange string              `json:"platformRange,omitempty"`
	SDKRange      string              `json:"sdkRange,omitempty"`
	Requires      []Requirement       `json:"requires,omitempty"`
	Config        []ConfigRequirement `json:"config,omitempty"`
}

type Adapter struct {
	Component
	Provides   []string `json:"provides"`
	DefaultFor []string `json:"defaultFor,omitempty"`
}

type Requirement = contracts.Requirement

// ConfigRequirement is exported from a selected artifact manifest. It is the
// only authority allowed to map a scenario/CI answer into generated config.
type ConfigRequirement = contracts.ConfigRequirement
