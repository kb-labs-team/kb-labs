// Package resolve turns a user request plus a signed release index into the
// one immutable decision the installer is allowed to execute.
package resolve

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"runtime"
	"sort"
	"strings"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
)

// Options describe the launcher doing the resolving. Zero values mean the
// running process: its OS/arch, and no launcher-version constraint check.
type Options struct {
	LauncherVersion string
	OS, Arch        string
}

// Plan resolves for the running host without a launcher-version check.
func Plan(request contracts.InstallRequest, source catalog.Catalog) (contracts.ResolvedInstallPlan, error) {
	return PlanWith(request, source, Options{})
}

// PlanWith resolves a request; the schema gate and launcher-version gate run
// before any resolution work.
func PlanWith(request contracts.InstallRequest, source catalog.Catalog, options Options) (contracts.ResolvedInstallPlan, error) {
	// Loaded indexes are already gated by catalog.Decode; this guards a catalog
	// handed in directly. An in-memory catalog with no schema is the current one.
	if source.Schema != "" {
		if err := catalog.CheckSchema(source.Schema); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
	}
	goos, goarch := options.OS, options.Arch
	if goos == "" {
		goos = runtime.GOOS
	}
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	request, err := request.Normalize()
	if err != nil {
		return contracts.ResolvedInstallPlan{}, err
	}
	platformVersion := request.Platform.Version
	if platformVersion == "" {
		platformVersion = source.Channels[request.Platform.Channel]
	}
	platform, ok := findPlatform(source.Platforms, platformVersion)
	if !ok {
		return contracts.ResolvedInstallPlan{}, incompatible("platform", platformVersion, "is not present in the release index")
	}
	sdkVersion := request.SDK.Version
	if sdkVersion == "" {
		sdkVersion = source.Channels[request.SDK.Channel]
	}
	if source.Compatibility != nil {
		if err := catalog.CheckCompatibility(source, platform.Version, sdkVersion, "", "", ""); err != nil {
			return contracts.ResolvedInstallPlan{}, incompatible("release set", platform.Version, err.Error())
		}
	}
	if err := catalog.CheckLauncher(platform, options.LauncherVersion); err != nil {
		return contracts.ResolvedInstallPlan{}, err
	}
	graph, ok := platform.Profiles[request.ServiceProfile]
	if !ok {
		if request.ServiceProfile == "" {
			graph, ok = platform.Profiles["default"]
		}
		if !ok {
			return contracts.ResolvedInstallPlan{}, incompatible("service profile", request.ServiceProfile, "is not supplied by platform "+platform.Version)
		}
	}
	graph.PlatformVersion, graph.Profile = platform.Version, profileName(request.ServiceProfile)
	artifacts := []contracts.Artifact{{ID: platform.ID, Kind: "platform", Package: platform.Package, Version: platform.Version, SHA256: platform.SHA256, Tarball: platform.Tarball}}
	for _, member := range platform.Members {
		item := artifact(member, "platform-member")
		item.Registry = registryKind(source, member.Package)
		artifacts = append(artifacts, item)
	}
	binaryForTarget := false
	for _, binary := range platform.Binaries {
		if binary.OS == goos && binary.Arch == goarch {
			binaryForTarget = true
			if source.Compatibility != nil {
				if err := catalog.CheckCompatibility(source, platform.Version, sdkVersion, binary.ID, binary.OS, binary.Arch); err != nil {
					return contracts.ResolvedInstallPlan{}, incompatible("binary", binary.ID, err.Error())
				}
			}
			artifacts = append(artifacts, contracts.Artifact{ID: binary.ID, Kind: "binary", Version: platform.Version, SHA256: binary.SHA256, URL: binary.URL, Target: binary.ID})
		}
	}
	if len(platform.Binaries) > 0 && !binaryForTarget {
		return contracts.ResolvedInstallPlan{}, incompatible("binary", goos+"/"+goarch, "platform "+platform.Version+" ships no binary for this OS/arch")
	}
	if request.SDK.Version != "" || request.SDK.Channel != "" {
		sdk, found := findComponentVersion(source.SDKs, sdkVersion)
		if !found {
			return contracts.ResolvedInstallPlan{}, incompatible("SDK", sdkVersion, "is not present in the release index")
		}
		if err := compatible(platform.SDKRange, sdk.Version, "platform SDK"); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
		artifacts = append(artifacts, artifact(sdk, "sdk"))
	}
	requirements := append([]catalog.Requirement(nil), platform.Requires...)
	for _, item := range request.Plugins {
		component, found := selectComponent(source.Plugins, item)
		if !found {
			return contracts.ResolvedInstallPlan{}, incompatible("plugin", item.ID, "requested version is not present in the release index")
		}
		if err := compatible(component.PlatformRange, platform.Version, "plugin "+component.ID+" platform"); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
		if request.SDK.Version != "" {
			if err := compatible(component.SDKRange, request.SDK.Version, "plugin "+component.ID+" SDK"); err != nil {
				return contracts.ResolvedInstallPlan{}, err
			}
		}
		artifacts = append(artifacts, artifact(component, "plugin"))
		requirements = append(requirements, component.Requires...)
	}
	bindings := make([]contracts.ProviderBinding, 0)
	for _, need := range requirements {
		adapter, found, ambiguous := selectAdapter(source.Adapters, request.Adapters, request.ProviderPreferences[need.Capability], need.Capability)
		if ambiguous {
			return contracts.ResolvedInstallPlan{}, launcherError(contracts.CodeProviderAmbiguous, "capability "+need.Capability+" has multiple compatible adapters; specify --provider", map[string]string{"capability": need.Capability})
		}
		if !found {
			return contracts.ResolvedInstallPlan{}, launcherError(contracts.CodeProviderUnresolved, "no adapter provides required capability "+need.Capability, map[string]string{"capability": need.Capability, "requiredBy": need.RequiredBy})
		}
		if err := compatible(adapter.PlatformRange, platform.Version, "adapter "+adapter.ID+" platform"); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
		if request.SDK.Version != "" {
			if err := compatible(adapter.SDKRange, request.SDK.Version, "adapter "+adapter.ID+" SDK"); err != nil {
				return contracts.ResolvedInstallPlan{}, err
			}
		}
		bindings = append(bindings, contracts.ProviderBinding{Capability: need.Capability, AdapterID: adapter.ID, Package: adapter.Package, Version: adapter.Version})
		artifacts = append(artifacts, artifact(adapter.Component, "adapter"))
	}
	// Explicit adapters are materialized even if the selected profile does not yet
	// require them: CI and future commands may rely on an intentional binding.
	for _, item := range request.Adapters {
		adapter, found := selectComponentAdapter(source.Adapters, item)
		if !found {
			return contracts.ResolvedInstallPlan{}, incompatible("adapter", item.ID, "requested version is not present in the release index")
		}
		artifacts = append(artifacts, artifact(adapter.Component, "adapter"))
	}
	artifacts = uniqueArtifacts(artifacts)
	bindings = uniqueBindings(bindings)
	patches, err := configPatches(platform, artifacts, bindings, source, request)
	if err != nil {
		return contracts.ResolvedInstallPlan{}, err
	}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Request: request, Artifacts: artifacts, ServiceGraph: graph, ProviderBindings: bindings, ConfigPatches: patches, ReleaseDigest: source.Digest, ScenarioStateDigest: request.ScenarioStateDigest}
	plan.PlanHash = hash(plan)
	return plan, nil
}

func profileName(value string) string {
	if value == "" {
		return "default"
	}
	return value
}

// registryKind reports whether a package the platform bundles is also a
// catalog plugin or adapter; those must be registered for discovery even
// though they are installed as platform members.
func registryKind(source catalog.Catalog, pkg string) string {
	for _, p := range source.Plugins {
		if p.Package == pkg {
			return "plugin"
		}
	}
	for _, a := range source.Adapters {
		if a.Package == pkg {
			return "adapter"
		}
	}
	return ""
}

func artifact(c catalog.Component, kind string) contracts.Artifact {
	return contracts.Artifact{ID: c.ID, Kind: kind, Package: c.Package, Version: c.Version, SHA256: c.SHA256, Tarball: c.Tarball}
}
func findPlatform(items []catalog.PlatformBundle, version string) (catalog.PlatformBundle, bool) {
	for _, v := range items {
		if v.Version == version {
			return v, true
		}
	}
	return catalog.PlatformBundle{}, false
}
func selectComponent(items []catalog.Component, request contracts.ComponentRequest) (catalog.Component, bool) {
	for _, v := range items {
		if v.ID == request.ID && (request.Version.Version == "" || request.Version.Version == v.Version) {
			return v, true
		}
	}
	return catalog.Component{}, false
}
func findComponentVersion(items []catalog.Component, version string) (catalog.Component, bool) {
	for _, v := range items {
		if v.Version == version {
			return v, true
		}
	}
	return catalog.Component{}, false
}
func selectComponentAdapter(items []catalog.Adapter, request contracts.ComponentRequest) (catalog.Adapter, bool) {
	for _, v := range items {
		if v.ID == request.ID && (request.Version.Version == "" || request.Version.Version == v.Version) {
			return v, true
		}
	}
	return catalog.Adapter{}, false
}
func selectAdapter(items []catalog.Adapter, requested []contracts.ComponentRequest, preferred, capability string) (catalog.Adapter, bool, bool) {
	allowed := map[string]bool{}
	for _, v := range requested {
		allowed[v.ID] = true
	}
	candidates := make([]catalog.Adapter, 0)
	for _, v := range items {
		if provides(v, capability) && (len(allowed) == 0 || allowed[v.ID]) {
			candidates = append(candidates, v)
		}
	}
	if preferred != "" {
		for _, v := range candidates {
			if v.ID == preferred {
				return v, true, false
			}
		}
		return catalog.Adapter{}, false, false
	}
	if len(candidates) == 1 {
		return candidates[0], true, false
	}
	return catalog.Adapter{}, false, len(candidates) > 1
}
func provides(adapter catalog.Adapter, capability string) bool {
	for _, item := range adapter.Provides {
		if item == capability {
			return true
		}
	}
	return false
}
func uniqueArtifacts(values []contracts.Artifact) []contracts.Artifact {
	// Keying on Kind+ID+Version alone silently collapses two genuinely
	// different npm packages whenever they happen to compute the same
	// catalog ID (for example a service package like @kb-labs/marketplace-app,
	// whose id is its declared service id "marketplace", and an unrelated CLI
	// plugin entry like @kb-labs/marketplace-entry, whose id falls back to
	// "marketplace" once idFor strips the "-entry" suffix in
	// prepare-release-index.mjs). Package is the actual installation unit, so
	// it must be part of the uniqueness key: without it, one of the two
	// packages simply never gets installed, and its service never starts.
	seen := map[string]contracts.Artifact{}
	for _, v := range values {
		seen[v.Kind+"/"+v.ID+"@"+v.Version+"#"+v.Package] = v
	}
	result := make([]contracts.Artifact, 0, len(seen))
	for _, v := range seen {
		result = append(result, v)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Kind+result[i].ID < result[j].Kind+result[j].ID })
	return result
}
func uniqueBindings(values []contracts.ProviderBinding) []contracts.ProviderBinding {
	seen := map[string]contracts.ProviderBinding{}
	for _, v := range values {
		seen[v.Capability] = v
	}
	result := make([]contracts.ProviderBinding, 0, len(seen))
	for _, v := range seen {
		result = append(result, v)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Capability < result[j].Capability })
	return result
}
func configPatches(platform catalog.PlatformBundle, artifacts []contracts.Artifact, bindings []contracts.ProviderBinding, source catalog.Catalog, request contracts.InstallRequest) ([]contracts.ConfigPatch, error) {
	result := []contracts.ConfigPatch{{Path: "/platform/version", Value: platform.Version, Owner: "platform"}}
	for _, v := range bindings {
		result = append(result, contracts.ConfigPatch{Path: "/platform/adapters/" + v.Capability, Value: v.Package + "@" + v.Version, Owner: "adapter:" + v.AdapterID})
	}
	for _, v := range artifacts {
		if v.Kind == "plugin" {
			result = append(result, contracts.ConfigPatch{Path: "/plugins/" + v.ID, Value: v.Package + "@" + v.Version, Owner: "plugin:" + v.ID})
		}
	}
	requirements := append([]catalog.ConfigRequirement(nil), platform.Config...)
	for _, member := range platform.Members {
		requirements = append(requirements, member.Config...)
	}
	for _, artifact := range artifacts {
		for _, component := range append(append([]catalog.Component(nil), source.Plugins...), source.SDKs...) {
			if component.ID == artifact.ID && component.Version == artifact.Version {
				requirements = append(requirements, component.Config...)
			}
		}
		for _, adapter := range source.Adapters {
			if adapter.ID == artifact.ID && adapter.Version == artifact.Version {
				requirements = append(requirements, adapter.Config...)
			}
		}
	}
	known := map[string]bool{}
	secrets := map[string]bool{}
	owners := map[string]string{}
	for _, requirement := range requirements {
		if requirement.ID == "" || (!requirement.Secret && requirement.Path == "") {
			return nil, fmt.Errorf("selected manifest has invalid configuration requirement")
		}
		known[requirement.ID] = true
		if previous, exists := owners[requirement.ID]; exists && previous != requirement.Path {
			return nil, launcherError(contracts.CodeConfigRequired, "configuration requirement "+requirement.ID+" is declared with conflicting paths", map[string]string{"requirement": requirement.ID})
		}
		owners[requirement.ID] = requirement.Path
		secrets[requirement.ID] = requirement.Secret
		value, supplied := request.Values[requirement.ID]
		if requirement.Secret {
			if requirement.Env == "" || len(requirement.Services) == 0 {
				return nil, fmt.Errorf("secret requirement %s must declare environment variable and target services", requirement.ID)
			}
			if supplied {
				return nil, launcherError(contracts.CodeInputRequired, "secret "+requirement.ID+" must be supplied through the secret store", map[string]string{"requirement": requirement.ID})
			}
			if requirement.Required && !contains(request.SecretInputs, requirement.ID) {
				return nil, launcherError(contracts.CodeInputRequired, "required secret input "+requirement.ID+" is missing", map[string]string{"requirement": requirement.ID})
			}
			if contains(request.SecretInputs, requirement.ID) {
				result = append(result, contracts.ConfigPatch{Owner: "manifest:" + requirement.ID, Environment: requirement.Env, Services: append([]string(nil), requirement.Services...)})
			}
			continue
		}
		if !supplied {
			value = requirement.Default
		}
		if value == "" && requirement.Required {
			return nil, launcherError(contracts.CodeConfigRequired, "required configuration "+requirement.ID+" is missing", map[string]string{"requirement": requirement.ID})
		}
		if value != "" {
			result = append(result, contracts.ConfigPatch{Path: requirement.Path, JSON: value, Owner: "manifest:" + requirement.ID})
		}
	}
	for id := range request.Values {
		if !known[id] {
			return nil, launcherError(contracts.CodeConfigRequired, "configuration "+id+" is not declared by selected manifests", map[string]string{"requirement": id})
		}
	}
	for _, id := range request.SecretInputs {
		if !known[id] || !secrets[id] {
			return nil, launcherError(contracts.CodeInputRequired, "secret input "+id+" is not declared by selected manifests", map[string]string{"requirement": id})
		}
	}
	return result, nil
}
func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
func compatible(rangeValue, version, name string) error {
	if rangeValue == "" || rangeValue == "*" {
		return nil
	}
	if strings.TrimSpace(rangeValue) == version {
		return nil
	}
	if strings.HasPrefix(rangeValue, "^") {
		if strings.Split(strings.TrimPrefix(rangeValue, "^"), ".")[0] == strings.Split(version, ".")[0] {
			return nil
		}
	}
	return incompatible(name, version, "does not satisfy declared range "+rangeValue)
}
func incompatible(subject, value, reason string) error {
	label := subject
	if value != "" {
		label = subject + " " + value
	}
	return launcherError(contracts.CodeIncompatibleComponents, label+" is incompatible: "+reason, map[string]string{"subject": subject, "value": value})
}
func launcherError(code, message string, details map[string]string) error {
	return &contracts.LauncherError{Code: code, Stage: contracts.StageResolve, Message: message, Hint: "Choose compatible versions or pass an explicit supported provider.", Details: details}
}
func hash(plan contracts.ResolvedInstallPlan) string {
	plan.PlanHash = ""
	data, _ := json.Marshal(plan)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
