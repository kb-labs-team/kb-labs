// Package resolve turns a user request plus a signed release index into the
// one immutable decision the installer is allowed to execute.
package resolve

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/kb-labs/clikit/diag"
	"maps"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"

	packageartifacts "github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/semrange"
	"github.com/kb-labs/create/v2/versionroot"
)

// Options describe the launcher doing the resolving. Zero values mean the
// running process: its OS/arch, and no launcher-version constraint check.
type Options struct {
	BinarySource         string
	Registry             string
	LauncherVersion      string
	OS, Arch             string
	ProjectRootSelection bool
	Operation            Operation
}

type Operation uint8

const (
	OperationInstall Operation = iota
	OperationUpdate
)

// Plan resolves for the running host without a launcher-version check.
func Plan(request contracts.InstallRequest, source catalog.Catalog) (contracts.ResolvedInstallPlan, error) {
	return PlanWith(request, source, Options{})
}

// PlanWith resolves a request; the schema gate and launcher-version gate run
// before any resolution work.
func PlanWith(request contracts.InstallRequest, source catalog.Catalog, options Options) (contracts.ResolvedInstallPlan, error) {
	return planWith(request, source, options, false)
}

// ValidateWith checks whether a request can be resolved against a catalog while
// allowing required operator inputs to remain unanswered. It does not produce
// an install plan; runtime callers must use PlanWith before applying anything.
func ValidateWith(request contracts.InstallRequest, source catalog.Catalog, options Options) error {
	_, err := planWith(request, source, options, true)
	return err
}

func planWith(request contracts.InstallRequest, source catalog.Catalog, options Options, allowMissingRequiredInputs bool) (contracts.ResolvedInstallPlan, error) {
	// Loaded indexes are already gated by catalog.Decode; this guards a catalog
	// handed in directly. An in-memory catalog with no schema is the current one.
	if source.Schema != "" {
		if err := catalog.CheckSchema(source.Schema); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
	}
	binarySource, err := packageartifacts.NormalizeSourceURL(options.BinarySource)
	if err != nil {
		return contracts.ResolvedInstallPlan{}, err
	}
	options.BinarySource = binarySource
	registry, err := packageartifacts.NormalizeSourceURL(options.Registry)
	if err != nil {
		return contracts.ResolvedInstallPlan{}, err
	}
	options.Registry = registry
	goos, goarch := options.OS, options.Arch
	if goos == "" {
		goos = runtime.GOOS
	}
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	request, err = request.Normalize()
	if err != nil {
		return contracts.ResolvedInstallPlan{}, err
	}
	platformVersion := request.Platform.Version
	if platformVersion == "" {
		platformVersion = source.Channels[request.Platform.Channel]
	}
	platform, ok := findPlatform(source.Platforms, platformVersion)
	if !ok {
		return contracts.ResolvedInstallPlan{}, incompatible("platform", "platform", platformVersion, "platform "+platformVersion, "is not present in the release index")
	}
	sdkVersion := request.SDK.Version
	if sdkVersion == "" {
		targetPlatform := platform.Version
		if request.SDK.Channel != "" {
			if channelPlatform, ok := source.Channels[request.SDK.Channel]; ok {
				targetPlatform = channelPlatform
			}
		}
		if matrixSDK := catalog.PlatformSDKVersion(source, targetPlatform); matrixSDK != "" {
			sdkVersion = matrixSDK
		} else if request.SDK.Channel != "" {
			sdkVersion = source.Channels[request.SDK.Channel]
		}
	}
	if request.Policy == contracts.PolicyCompatible && platform.SDKRange != "" && sdkVersion != "" {
		if err := compatible(platform.SDKRange, sdkVersion, "sdk", "sdk", "platform SDK", options.Operation); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
	}
	if source.Compatibility != nil {
		if err := catalog.CheckCompatibility(source, platform.Version, sdkVersion, "", "", "", request.Policy); err != nil {
			if request.Policy == contracts.PolicyStrict && sdkVersion != "" {
				failure := compatibilityFailure(compatibilityIdentity{kind: "sdk", id: "sdk", selectedVersion: sdkVersion, requiredRange: platform.SDKRange},
					fmt.Sprintf("strict policy requires an exact compatibility-matrix relation for platform %s and SDK %s; declared SDK range is %s", platform.Version, sdkVersion, platform.SDKRange),
					"Use an exact platform/SDK pair from the release matrix or choose --policy compatible.",
					map[string]string{"policy": string(request.Policy)})
				return contracts.ResolvedInstallPlan{}, failure
			}
			return contracts.ResolvedInstallPlan{}, compatibilityFailure(
				compatibilityIdentity{kind: "release set", id: "release set", selectedVersion: sdkVersion, requiredRange: platform.SDKRange}, err.Error(),
				"Choose compatible versions or pass an explicit supported provider.", nil)
		}
	}
	if err := catalog.CheckLauncher(platform, options.LauncherVersion); err != nil {
		return contracts.ResolvedInstallPlan{}, err
	}
	graph, ok := platform.Profiles[request.ServiceProfile]
	if !ok {
		return contracts.ResolvedInstallPlan{}, incompatible("service profile", request.ServiceProfile, platform.Version, "service profile "+request.ServiceProfile, "is not supplied by platform "+platform.Version)
	}
	graph.PlatformVersion, graph.Profile = platform.Version, request.ServiceProfile
	artifacts := []contracts.Artifact{{ID: platform.ID, Kind: "platform", Package: platform.Package, Version: platform.Version, SHA256: platform.SHA256, Tarball: platform.Tarball, SizeBytes: platform.SizeBytes, Config: platform.Config}}
	for _, member := range platform.Members {
		item := artifact(member, "platform-member")
		item.Registry = registryKind(source, member.Package)
		artifacts, err = appendPlatformMember(artifacts, item)
		if err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
	}
	binaryForTarget := false
	binaryForOS := false
	for _, binary := range platform.Binaries {
		if binary.OS == goos {
			binaryForOS = true
		}
		if binary.OS == goos && binary.Arch == goarch {
			binaryForTarget = true
			if source.Compatibility != nil {
				if err := catalog.CheckCompatibility(source, platform.Version, sdkVersion, binary.ID, binary.OS, binary.Arch, request.Policy); err != nil {
					return contracts.ResolvedInstallPlan{}, incompatibleBinary(binary.ID, platform.Version, binary.OS+"/"+binary.Arch, "binary "+binary.ID, err.Error())
				}
			}
			artifacts = append(artifacts, contracts.Artifact{ID: binary.ID, Kind: "binary", Version: platform.Version, SHA256: binary.SHA256, SizeBytes: binary.SizeBytes, URL: binary.URL, Target: binary.ID})
		}
	}
	if len(platform.Binaries) > 0 && !binaryForTarget {
		if !binaryForOS {
			return contracts.ResolvedInstallPlan{}, contracts.UnsupportedPlatformDiagnostic(goos, goarch)
		}
		return contracts.ResolvedInstallPlan{}, incompatibleBinary("kb-create", platform.Version, goos+"/"+goarch, "binary "+goos+"/"+goarch, "platform "+platform.Version+" ships no binary for this OS/arch")
	}
	if graph.Profile == "client" {
		var clientBinary []contracts.Artifact
		for _, item := range artifacts {
			if item.IsBinary() && item.ID == "kb-create" {
				clientBinary = append(clientBinary, item)
			}
		}
		if len(clientBinary) != 1 {
			return contracts.ResolvedInstallPlan{}, incompatibleBinary("kb-create", platform.Version, goos+"/"+goarch, "client binary "+platform.Version, "release index must contain exactly one kb-create binary for "+goos+"/"+goarch)
		}
		var clientCLI []contracts.Artifact
		for _, member := range platform.Members {
			if member.Package == "@kb-labs/cli-bin" {
				clientCLI = append(clientCLI, artifact(member, "platform-member"))
			}
		}
		if len(clientCLI) != 1 {
			return contracts.ResolvedInstallPlan{}, incompatible("platform-member", "@kb-labs/cli-bin", platform.Version, "client CLI "+platform.Version, "release index must contain exactly one @kb-labs/cli-bin platform member")
		}
		clientArtifacts := append(clientBinary, clientCLI...)
		if err := annotateArtifactResolution(request, clientArtifacts, options.BinarySource, options.Registry); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
		plan := contracts.ResolvedInstallPlan{
			Schema: contracts.ResolvedPlanSchema, BinarySource: options.BinarySource, Registry: options.Registry, Request: request, Artifacts: clientArtifacts,
			ServiceGraph: graph, PlatformChannel: resolvedChannel(source, request.Platform, platform.Version),
			ReleaseDigest: source.Digest, ScenarioStateDigest: request.ScenarioStateDigest,
		}
		if err := contracts.ValidatePlanArtifactIdentities(plan); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
		plan.PlanHash = hash(plan)
		return plan, nil
	}
	if sdkVersion != "" {
		sdk, found := findComponentVersion(source.SDKs, sdkVersion)
		if !found {
			return contracts.ResolvedInstallPlan{}, incompatible("sdk", "sdk", sdkVersion, "SDK "+sdkVersion, "is not present in the release index")
		}
		artifacts, err = appendSelectedSDK(artifacts, artifact(sdk, "sdk"), platform.Version)
		if err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
	}
	requirements := append([]catalog.Requirement(nil), platform.Requires...)
	for _, item := range request.Plugins {
		if memberContains(platform.Members, item) {
			// Official services shipped as platform members are already selected
			// by the platform bundle and must not also resolve as plugins.
			continue
		}
		component, found := selectComponent(source.Plugins, item)
		if !found {
			return contracts.ResolvedInstallPlan{}, incompatible("plugin", item.ID, item.Version.Version, "plugin "+item.ID, "requested version is not present in the release index")
		}
		if err := compatible(component.PlatformRange, platform.Version, "plugin", component.ID, "plugin "+component.ID+" platform", options.Operation); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
		if sdkVersion != "" {
			if err := compatible(component.SDKRange, sdkVersion, "plugin", component.ID, "plugin "+component.ID+" SDK", options.Operation); err != nil {
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
			return contracts.ResolvedInstallPlan{}, resolutionDiag(contracts.CodeProviderAmbiguous, "capability "+need.Capability+" has multiple compatible adapters; specify --provider", map[string]string{"capability": need.Capability})
		}
		if !found {
			return contracts.ResolvedInstallPlan{}, resolutionDiag(contracts.CodeProviderUnresolved, "no adapter provides required capability "+need.Capability, map[string]string{"capability": need.Capability, "requiredBy": need.RequiredBy})
		}
		if err := compatible(adapter.PlatformRange, platform.Version, "adapter", adapter.ID, "adapter "+adapter.ID+" platform", options.Operation); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
		if sdkVersion != "" {
			if err := compatible(adapter.SDKRange, sdkVersion, "adapter", adapter.ID, "adapter "+adapter.ID+" SDK", options.Operation); err != nil {
				return contracts.ResolvedInstallPlan{}, err
			}
		}
		bindings = append(bindings, contracts.ProviderBinding{Capability: need.Capability, AdapterID: adapter.ID, Package: adapter.Package, Version: adapter.Version})
		artifacts, err = appendSelectedAdapter(artifacts, adapter)
		if err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
	}
	// Explicit adapters are materialized even if the selected profile does not yet
	// require them: CI and future commands may rely on an intentional binding.
	for _, item := range request.Adapters {
		adapter, found := selectComponentAdapter(source.Adapters, item)
		if !found {
			return contracts.ResolvedInstallPlan{}, incompatible("adapter", item.ID, item.Version.Version, "adapter "+item.ID, "requested version is not present in the release index")
		}
		if err := compatible(adapter.PlatformRange, platform.Version, "adapter", adapter.ID, "adapter "+adapter.ID+" platform", options.Operation); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
		if sdkVersion != "" {
			if err := compatible(adapter.SDKRange, sdkVersion, "adapter", adapter.ID, "adapter "+adapter.ID+" SDK", options.Operation); err != nil {
				return contracts.ResolvedInstallPlan{}, err
			}
		}
		artifacts, err = appendSelectedAdapter(artifacts, adapter)
		if err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
	}
	if err := contracts.ValidateArtifactIdentities(artifacts); err != nil {
		return contracts.ResolvedInstallPlan{}, err
	}
	sortArtifacts(artifacts)
	if err := annotateArtifactResolution(request, artifacts, options.BinarySource, options.Registry); err != nil {
		return contracts.ResolvedInstallPlan{}, err
	}
	provenanceByPackage := make(map[string]catalog.ArtifactProvenance, len(source.Provenance))
	for _, item := range source.Provenance {
		provenanceByPackage[item.Package+"@"+item.Version] = item
	}
	for index := range artifacts {
		if artifacts[index].IsBinary() {
			continue
		}
		key := artifacts[index].Package + "@" + artifacts[index].Version
		if item, ok := provenanceByPackage[key]; ok {
			artifacts[index].Provenance = contracts.ArtifactProvenance{
				SourceRevision: item.SourceRevision, Integrity: item.Integrity,
				DistSHA256: item.DistSHA256, ContentScope: item.ContentScope, PackageSHA256: item.PackageSHA256,
			}
		}
		packagePath := filepath.ToSlash(filepath.Join("node_modules", filepath.FromSlash(artifacts[index].Package)))
		if err := packageartifacts.ValidatePackageProvenance(artifacts[index], packagePath); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
	}
	bindings = uniqueBindings(bindings)
	patches, err := configPatches(platform, artifacts, bindings, source, request, allowMissingRequiredInputs)
	if err != nil {
		return contracts.ResolvedInstallPlan{}, err
	}
	var selectedHost *contracts.HostSpec
	if platform.Host != nil {
		host := cloneHost(*platform.Host)
		selectedHost = &host
	} else if graph.Profile != "client" {
		return contracts.ResolvedInstallPlan{}, incompatible("platform", "platform", platform.Version, "platform "+platform.Version, "declares no host to run")
	}
	if request.GatewayURL != "" {
		if selectedHost == nil {
			return contracts.ResolvedInstallPlan{}, resolutionDiag(contracts.CodeInputRequired,
				"a Gateway URL can only be declared for a platform with a host", map[string]string{"gatewayUrl": request.GatewayURL})
		}
		if err := configureGatewayAddress(request.GatewayURL, &graph, selectedHost, patches); err != nil {
			return contracts.ResolvedInstallPlan{}, err
		}
	}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, BinarySource: options.BinarySource, Registry: options.Registry, Request: request, Artifacts: artifacts, ServiceGraph: graph, PlatformChannel: resolvedChannel(source, request.Platform, platform.Version), ProviderBindings: bindings, Host: selectedHost, ConfigPatches: patches, ReleaseDigest: source.Digest, ScenarioStateDigest: request.ScenarioStateDigest}
	plan.PlanHash = hash(plan)
	return plan, nil
}

// appendSelectedSDK records the selected SDK once. A platform that bundles the
// SDK package already installs it, so the bundled record takes the selected
// role instead of a second record; a different version of a bundled package
// cannot be installed next to it.
func appendSelectedSDK(artifacts []contracts.Artifact, sdk contracts.Artifact, platformVersion string) ([]contracts.Artifact, error) {
	for index, existing := range artifacts {
		if existing.Identity() != sdk.Identity() {
			continue
		}
		if existing.Version != sdk.Version {
			return nil, incompatible("sdk", "sdk", sdk.Version, "SDK "+sdk.Version, "platform "+platformVersion+" bundles "+existing.Package+" "+existing.Version)
		}
		if existing.SHA256 != sdk.SHA256 || existing.Tarball != sdk.Tarball {
			return nil, contracts.PlanArtifactIdentityFailure(sdk.Identity())
		}
		artifacts[index].Kind = sdk.Kind
		return artifacts, nil
	}
	return append(artifacts, sdk), nil
}

func appendSelectedAdapter(artifacts []contracts.Artifact, adapter catalog.Adapter) ([]contracts.Artifact, error) {
	for index, existing := range artifacts {
		if existing.Identity() != adapter.Package {
			continue
		}
		adapterRole := existing.Kind == "adapter" || existing.Registry == "adapter"
		if !adapterRole || existing.Version != adapter.Version || existing.SHA256 != adapter.SHA256 || existing.Tarball != adapter.Tarball {
			return nil, contracts.PlanArtifactIdentityFailure(adapter.Package)
		}
		artifacts[index].Config = append([]contracts.ConfigRequirement(nil), adapter.Config...)
		return artifacts, nil
	}
	return append(artifacts, artifact(adapter.Component, "adapter")), nil
}

func appendPlatformMember(artifacts []contracts.Artifact, member contracts.Artifact) ([]contracts.Artifact, error) {
	for index, existing := range artifacts {
		if existing.Identity() != member.Identity() {
			continue
		}
		if existing.Kind != "platform" || existing.ID != member.ID || existing.Version != member.Version ||
			existing.SHA256 != member.SHA256 || existing.Tarball != member.Tarball || (existing.Registry != "" && existing.Registry != member.Registry) ||
			!reflect.DeepEqual(existing.Config, member.Config) {
			return nil, contracts.PlanArtifactIdentityFailure(member.Identity())
		}
		artifacts[index].Registry = member.Registry
		return artifacts, nil
	}
	return append(artifacts, member), nil
}

func sortArtifacts(artifacts []contracts.Artifact) {
	sort.Slice(artifacts, func(i, j int) bool {
		left, right := artifacts[i], artifacts[j]
		if left.Kind != right.Kind {
			return left.Kind < right.Kind
		}
		if left.ID != right.ID {
			return left.ID < right.ID
		}
		if left.Version != right.Version {
			return left.Version < right.Version
		}
		return left.Package < right.Package
	})
}

func configureGatewayAddress(address string, graph *contracts.ServiceGraph, host *contracts.HostSpec, patches []contracts.ConfigPatch) error {
	parsed, err := url.Parse(address)
	if err != nil {
		return resolutionDiag(contracts.CodeInputRequired, "the declared Gateway URL is invalid", map[string]string{"gatewayUrl": address})
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		return resolutionDiag(contracts.CodeInputRequired, "the declared Gateway URL must include a valid port", map[string]string{"gatewayUrl": address})
	}
	declaredService := false
	baseGatewayPort := 0
	for index := range graph.Services {
		if graph.Services[index].ID == "gateway" {
			baseGatewayPort = graph.Services[index].Port
			declaredService = true
		}
	}
	if !declaredService {
		return resolutionDiag(contracts.CodeInputRequired, "the selected service profile does not declare a Gateway service", map[string]string{"gatewayUrl": address})
	}
	if baseGatewayPort < 1 || baseGatewayPort > 65535 {
		return resolutionDiag(contracts.CodeConfigRequired, "the selected service profile does not declare a valid Gateway port", map[string]string{"field": "gatewayUrl"})
	}
	offset := port - baseGatewayPort
	ports := make(map[string]int, len(graph.Services))
	for index := range graph.Services {
		if graph.Services[index].Port == 0 {
			continue
		}
		resolvedPort := graph.Services[index].Port + offset
		if resolvedPort < 1 || resolvedPort > 65535 {
			return resolutionDiag(contracts.CodeInputRequired, "the declared Gateway port shifts a platform service outside the valid port range", map[string]string{"gatewayUrl": address, "service": graph.Services[index].ID})
		}
		graph.Services[index].Port = resolvedPort
		ports[graph.Services[index].ID] = resolvedPort
	}
	configured := false
	for index := range patches {
		if patches[index].Path != "/platform/adapterOptions" {
			continue
		}
		var config map[string]any
		if err := json.Unmarshal([]byte(patches[index].JSON), &config); err != nil {
			return resolutionDiag(contracts.CodeConfigRequired, "the declared platform adapter options are not valid JSON", map[string]string{"field": patches[index].Path})
		}
		serviceTransport, ok := config["serviceTransport"].(map[string]any)
		if !ok {
			return resolutionDiag(contracts.CodeConfigRequired, "platform adapter options do not declare serviceTransport", map[string]string{"field": patches[index].Path})
		}
		// These addresses are resolved below; the HTTP transport must not apply
		// the host's local network offset to them a second time.
		serviceTransport["offset"] = 0
		services, ok := serviceTransport["services"].(map[string]any)
		if !ok {
			return resolutionDiag(contracts.CodeConfigRequired, "serviceTransport does not declare service addresses", map[string]string{"field": patches[index].Path})
		}
		for serviceID, resolvedPort := range ports {
			settings, ok := services[serviceID].(map[string]any)
			if !ok {
				continue
			}
			currentAddress, ok := settings["url"].(string)
			if !ok {
				continue
			}
			serviceURL, err := url.Parse(currentAddress)
			if err != nil || serviceURL.Hostname() == "" {
				return resolutionDiag(contracts.CodeConfigRequired, "serviceTransport contains an invalid service URL", map[string]string{"field": patches[index].Path})
			}
			serviceURL.Host = net.JoinHostPort(serviceURL.Hostname(), strconv.Itoa(resolvedPort))
			settings["url"] = serviceURL.String()
		}
		gateway, ok := services["gateway"].(map[string]any)
		if !ok {
			gateway = make(map[string]any)
			services["gateway"] = gateway
		}
		gateway["url"] = address
		encoded, err := json.Marshal(config)
		if err != nil {
			return resolutionDiag(contracts.CodeConfigRequired, "the declared Gateway address could not be encoded", map[string]string{"field": patches[index].Path})
		}
		patches[index].JSON = string(encoded)
		configured = true
	}
	if !configured {
		return resolutionDiag(contracts.CodeConfigRequired, "the selected release must declare platform.adapterOptions to set a Gateway address", map[string]string{"field": "gatewayUrl"})
	}
	if host.Env == nil {
		host.Env = map[string]string{}
	}
	host.Env["KB_NET_OFFSET"] = strconv.Itoa(offset)
	host.HealthURL = address + "/health"
	return nil
}

func annotateArtifactResolution(request contracts.InstallRequest, artifacts []contracts.Artifact, binarySource, registry string) error {
	for index := range artifacts {
		item := &artifacts[index]
		fetchBinary, kindErr := item.IsFetchBinary()
		if kindErr != nil {
			return kindErr
		}
		if request.Source == contracts.SourceOffline {
			layout, err := versionroot.New(request.PlatformRoot)
			if err != nil {
				return err
			}
			cachePath, err := layout.SharedRuntimePath(".kb/v2/cache")
			if err != nil {
				return err
			}
			if fetchBinary {
				cachePath = filepath.Join(cachePath, "binaries", item.SHA256)
			} else {
				cachePath = filepath.Join(cachePath, "packages", item.SHA256+".tgz")
			}
			data, err := os.ReadFile(cachePath)
			if err != nil {
				failure := contracts.NewDiag(contracts.CodeOfflineArtifactMissing,
					fmt.Sprintf("Artifact %s is unavailable from the local cache at %s.", item.ID, cachePath),
					"Run without --offline to download the artifact, or restore its checksum-verified entry in the V2 cache.", err)
				failure.Meta = map[string]any{"artifact": item.ID, "cachePath": cachePath}
				return failure
			}
			if fmt.Sprintf("%x", sha256.Sum256(data)) != item.SHA256 {
				failure := contracts.NewDiag(contracts.CodeOfflineArtifactMissing,
					fmt.Sprintf("Artifact %s has a corrupt local cache entry at %s.", item.ID, cachePath),
					"Run without --offline to download the artifact, or restore its checksum-verified entry in the V2 cache.", nil)
				failure.Meta = map[string]any{"artifact": item.ID, "cachePath": cachePath}
				return failure
			}
			item.ResolvedFrom = "cache"
			continue
		}
		item.ResolvedFrom = "registry"
		if fetchBinary {
			item.ResolvedURL = item.URL
			if binarySource != "" {
				original, err := url.Parse(item.URL)
				if err != nil || original.Host == "" {
					return fmt.Errorf("binary %s has an invalid release URL", item.ID)
				}
				parts := strings.Split(strings.Trim(original.Path, "/"), "/")
				if len(parts) < 2 || parts[len(parts)-1] == "" || parts[len(parts)-2] == "" {
					return fmt.Errorf("binary %s has no release tag and asset", item.ID)
				}
				item.ResolvedURL = binarySource + "/" + url.PathEscape(parts[len(parts)-2]) + "/" + url.PathEscape(parts[len(parts)-1])
			}
		} else {
			item.ResolvedURL = item.Tarball
			if registry != "" {
				if item.Package == "" || item.Version == "" {
					return fmt.Errorf("artifact %s lacks package identity", item.ID)
				}
				name := item.Package
				if pos := strings.LastIndex(name, "/"); pos >= 0 {
					name = name[pos+1:]
				}
				item.ResolvedURL = registry + "/" + item.Package + "/-/" + name + "-" + item.Version + ".tgz"
			}
		}
	}
	return nil
}

func memberContains(members []catalog.Component, request contracts.ComponentRequest) bool {
	for _, member := range members {
		if member.ID == request.ID && (request.Version.Version == "" || request.Version.Version == member.Version) {
			return true
		}
	}
	return false
}

// cloneHost gives the plan its own copy: the plan is hashed and persisted, and
// must not change if the release index value it came from is reused.
func cloneHost(host contracts.HostSpec) contracts.HostSpec {
	host.Args = append([]string(nil), host.Args...)
	host.Env = maps.Clone(host.Env)
	if host.Recover != nil {
		recovery := *host.Recover
		recovery.Args = append([]string(nil), recovery.Args...)
		host.Recover = &recovery
	}
	return host
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
	return contracts.Artifact{ID: c.ID, Kind: kind, Package: c.Package, Version: c.Version, SHA256: c.SHA256, SizeBytes: c.SizeBytes, Tarball: c.Tarball, Config: c.Config, PlatformRange: c.PlatformRange, SDKRange: c.SDKRange}
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
		// An explicitly selected adapter constrains only the capability it
		// provides. For example, choosing a cache adapter in a scenario must
		// not prevent the platform from selecting its service transport.
		for _, candidate := range items {
			if candidate.ID == v.ID && provides(candidate, capability) {
				allowed[v.ID] = true
			}
		}
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
	defaults := make([]catalog.Adapter, 0, len(candidates))
	for _, candidate := range candidates {
		if contains(candidate.DefaultFor, capability) {
			defaults = append(defaults, candidate)
		}
	}
	if len(defaults) == 1 {
		return defaults[0], true, false
	}
	if len(defaults) > 1 {
		return catalog.Adapter{}, false, true
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
func configPatches(platform catalog.PlatformBundle, artifacts []contracts.Artifact, bindings []contracts.ProviderBinding, source catalog.Catalog, request contracts.InstallRequest, allowMissingRequiredInputs bool) ([]contracts.ConfigPatch, error) {
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
			return nil, resolutionDiag(contracts.CodeConfigRequired, "configuration requirement "+requirement.ID+" is declared with conflicting paths", map[string]string{"field": requirement.ID})
		}
		owners[requirement.ID] = requirement.Path
		secrets[requirement.ID] = requirement.Secret
		value, supplied := request.Values[requirement.ID]
		if requirement.Secret {
			if requirement.Env == "" || len(requirement.Services) == 0 {
				return nil, fmt.Errorf("secret requirement %s must declare environment variable and target services", requirement.ID)
			}
			if supplied {
				return nil, resolutionDiag(contracts.CodeInputRequired, "secret "+requirement.ID+" must be supplied through the secret store", map[string]string{"requirement": requirement.ID})
			}
			if requirement.Required && !optionalRequirement(requirement) && !contains(request.SecretInputs, requirement.ID) && !allowMissingRequiredInputs {
				return nil, resolutionDiag(contracts.CodeInputRequired, "required secret input "+requirement.ID+" is missing", map[string]string{"requirement": requirement.ID})
			}
			if requirement.Generate || contains(request.SecretInputs, requirement.ID) {
				result = append(result, contracts.ConfigPatch{Owner: "manifest:" + requirement.ID, Environment: requirement.Env, Services: append([]string(nil), requirement.Services...)})
			}
			continue
		}
		if !supplied {
			value = requirement.Default
		}
		if value == "" && requirement.Required && !optionalRequirement(requirement) && !allowMissingRequiredInputs {
			return nil, resolutionDiag(contracts.CodeConfigRequired, "required configuration "+requirement.ID+" is missing", map[string]string{"field": requirement.ID})
		}
		if value != "" {
			result = append(result, contracts.ConfigPatch{Path: requirement.Path, JSON: value, Owner: "manifest:" + requirement.ID})
		}
	}
	for id := range request.Values {
		if !known[id] {
			return nil, resolutionDiag(contracts.CodeConfigRequired, "configuration "+id+" is not declared by selected manifests", map[string]string{"field": id})
		}
	}
	if err := validateSecretInputIDs(request.SecretInputs, func(id string) bool { return known[id] && secrets[id] }); err != nil {
		return nil, err
	}
	return result, nil
}

// ValidateSecretInputIDs checks operator-provided requirement IDs against the
// selected artifact manifests. It is shared by request resolution and late
// secret sources such as --secret-env, before those sources can write state.
func ValidateSecretInputIDs(artifacts []contracts.Artifact, ids []string) error {
	declared := make(map[string]bool)
	for _, artifact := range artifacts {
		for _, requirement := range artifact.Config {
			if requirement.Secret {
				declared[requirement.ID] = true
			}
		}
	}
	return validateSecretInputIDs(ids, func(id string) bool { return declared[id] })
}

func validateSecretInputIDs(ids []string, declared func(string) bool) error {
	for _, id := range ids {
		if !declared(id) {
			return resolutionDiag(contracts.CodeSecretInputInvalid,
				"secret input "+id+" is not declared by the selected manifests", map[string]string{"requirement": id})
		}
	}
	return nil
}

func optionalRequirement(requirement catalog.ConfigRequirement) bool {
	return requirement.Optional || requirement.Severity == "warning"
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// compatible checks a declared semver range under every policy. The strict
// policy adds the exact release matrix check (catalog.CheckCompatibility); it
// does not turn a plugin's declared range into an exact string match.
func compatible(rangeValue, version, kind, id, name string, operation Operation) error {
	if rangeValue == "" {
		return nil
	}
	constraint, err := semrange.ParseRange(rangeValue)
	if err != nil {
		return fmt.Errorf("%s declares invalid compatibility range %q: %w", name, rangeValue, err)
	}
	candidate, err := semrange.ParseVersion(version)
	if err != nil {
		return fmt.Errorf("%s has invalid version %q: %w", name, version, err)
	}
	if constraint.Satisfies(candidate) {
		return nil
	}
	identity := compatibilityIdentity{kind: kind, id: id, selectedVersion: version, requiredRange: rangeValue}
	message := name + " " + version + " is incompatible: it does not satisfy declared range " + rangeValue
	hint := "Choose compatible versions or pass an explicit supported provider."
	if operation == OperationUpdate {
		return contracts.NewUpdateIncompatible(contracts.UpdateIncompatibleDetails{
			ID: id, Kind: kind, SelectedVersion: version, RequiredRange: rangeValue,
		})
	}
	return compatibilityFailure(identity, message, hint, nil)
}

func resolvedChannel(source catalog.Catalog, selector contracts.VersionSelector, version string) string {
	if selector.Channel != "" {
		return string(selector.Channel)
	}
	for _, channel := range []contracts.Channel{contracts.ChannelStable, contracts.ChannelCanary, contracts.ChannelExperimental} {
		if source.Channels[channel] == version {
			return string(channel)
		}
	}
	return ""
}
func incompatible(kind, id, selectedVersion, label, reason string) error {
	return compatibilityFailure(
		compatibilityIdentity{kind: kind, id: id, selectedVersion: selectedVersion},
		label+" is incompatible: "+reason, "Choose compatible versions or pass an explicit supported provider.", nil)
}

func incompatibleBinary(id, selectedVersion, target, label, reason string) error {
	extra := map[string]string{}
	if target != "" {
		extra["target"] = target
	}
	return compatibilityFailure(
		compatibilityIdentity{kind: "binary", id: id, selectedVersion: selectedVersion},
		label+" is incompatible: "+reason, "Choose compatible versions or pass an explicit supported provider.", extra)
}

func resolutionDiag(code, message string, details map[string]string) error {
	d := diag.New(code, message, diag.WithMeta(stringMap(details)))
	d.Hint = "Choose compatible versions or pass an explicit supported provider."
	return d
}

// compatibilityIdentity represents the canonical component identity for compatibility diagnostics.
// The identity rule per kind is:
//   - "platform":        id is "platform" (the platform bundle identity; selectedVersion is platform version)
//   - "sdk":             id is "sdk" (the SDK component identity; selectedVersion is sdk version)
//   - "binary":          id is the logical binary id (e.g. "kb-create"; target is structured <os>/<arch>)
//   - "plugin":          id is the plugin identifier
//   - "adapter":         id is the adapter identifier
//   - "platform-member": id is the package name (e.g. "@kb-labs/cli-bin")
//   - "service profile": id is the service profile name (e.g. "default")
//   - "release set":     id is "release set"
type compatibilityIdentity struct {
	kind, id, selectedVersion, requiredRange string
}

func compatibilityFailure(identity compatibilityIdentity, reason, hint string, extra map[string]string) *diag.Diag {
	if identity.kind == "" || identity.id == "" {
		panic("compatibility diagnostic requires a component kind and id")
	}
	details := map[string]string{
		"kind":            identity.kind,
		"id":              identity.id,
		"selectedVersion": identity.selectedVersion,
		"requiredRange":   identity.requiredRange,
	}
	for key, value := range extra {
		details[key] = value
	}
	d := diag.New(contracts.CodeIncompatibleComponents, reason, diag.WithMeta(stringMap(details)))
	d.Hint = hint
	return d
}

func stringMap(values map[string]string) map[string]any {
	result := make(map[string]any, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}
func hash(plan contracts.ResolvedInstallPlan) string {
	plan.PlanHash = ""
	data, _ := json.Marshal(plan)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
