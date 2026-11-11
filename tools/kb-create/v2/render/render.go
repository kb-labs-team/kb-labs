// Package render materializes the resolver's exact decision. It never scans
// node_modules to infer services: rendered files are a projection of the plan.
package render

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/versionroot"
)

const ConfigFilename = "kb.config.jsonc"

// Output is the platform's generated runtime configuration. There is no
// service-manager projection: the host process is the one runtime, and it is
// described by the plan's HostSpec, not by a rendered file.
type Output struct {
	Config []byte
}

// Gateway proxy routes come from the host topology at runtime. The host adds
// routes for its internal modules and project routing starts REST/workflow
// lazily; package presence in the install graph does not imply a live service.
func Build(plan contracts.ResolvedInstallPlan) (Output, error) {
	if plan.Schema != contracts.ResolvedPlanSchema {
		return Output{}, fmt.Errorf("unsupported resolved plan schema %q", plan.Schema)
	}
	services := make(map[string]struct{}, len(plan.ServiceGraph.Services))
	for _, service := range plan.ServiceGraph.Services {
		if service.ID == "" {
			return Output{}, fmt.Errorf("service ID is required")
		}
		services[service.ID] = struct{}{}
	}
	adapters, plugins := map[string]string{}, map[string]string{}
	extra := map[string]any{}
	for _, patch := range plan.ConfigPatches {
		if patch.Environment != "" {
			// The value itself travels through the private secret store into
			// the host's environment; the plan only names the variable and the
			// services that consume it, which must exist in the graph.
			for _, serviceID := range patch.Services {
				if _, exists := services[serviceID]; !exists {
					return Output{}, fmt.Errorf("secret patch %s targets unknown service %q", patch.Owner, serviceID)
				}
			}
		}
		if len(patch.Path) > len("/platform/adapters/") && patch.Path[:len("/platform/adapters/")] == "/platform/adapters/" {
			adapters[patch.Path[len("/platform/adapters/"):]] = moduleName(patch.Value)
		}
		if len(patch.Path) > len("/plugins/") && patch.Path[:len("/plugins/")] == "/plugins/" {
			plugins[patch.Path[len("/plugins/"):]] = patch.Value
		}
		if patch.JSON != "" {
			if err := setConfigValue(extra, patch.Path, patch.JSON); err != nil {
				return Output{}, fmt.Errorf("apply config patch %s: %w", patch.Path, err)
			}
		}
	}
	// adapters/plugins are map[string]string while manifest-declared defaults
	// arrive as map[string]any: merge() only descends into map[string]any, so
	// a typed map on the target side silently degrades the deep merge into a
	// wholesale replacement and every resolved binding (cache, storage, ...)
	// was dropped whenever a manifest declared a /platform/adapters default.
	config := map[string]any{"platform": map[string]any{"version": plan.ServiceGraph.PlatformVersion, "adapters": stringMapAsAny(adapters)}, "plugins": stringMapAsAny(plugins)}
	merge(config, extra)
	if plan.Registry != "" && (plan.Request.MarketplaceSources == nil || plan.Request.MarketplaceSources.NpmURL == "") {
		if marketplace, ok := config["marketplace"].(map[string]any); ok {
			if sources, ok := marketplace["sources"].([]any); ok {
				for _, entry := range sources {
					if source, ok := entry.(map[string]any); ok && source["kind"] == "npm" {
						source["url"] = plan.Registry
					}
				}
			}
		}
	}
	if plan.Request.MarketplaceSources != nil {
		source := plan.Request.MarketplaceSources
		var sources []any
		if source.RegistryURL != "" {
			registry := map[string]any{"kind": "registry", "url": source.RegistryURL, "signingPublicKey": "${" + source.SigningPublicKeyEnv + "}"}
			if source.RegistryTokenEnv != "" {
				registry["authToken"] = "${" + source.RegistryTokenEnv + "}"
			}
			sources = append(sources, registry)
		}
		if source.NpmURL != "" {
			sources = append(sources, map[string]any{"kind": "npm", "url": source.NpmURL})
		}
		if len(sources) == 0 {
			return Output{}, fmt.Errorf("Marketplace source configuration must include a Registry or npm URL")
		}
		marketplace, _ := config["marketplace"].(map[string]any)
		if marketplace == nil {
			marketplace = map[string]any{}
			config["marketplace"] = marketplace
		}
		marketplace["sources"] = sources
	}
	// Development workspace resolution is enabled only by the checkout's
	// explicit marker. The installer must never activate that source.
	if platformConfig, ok := config["platform"].(map[string]any); ok {
		delete(platformConfig, "mode")
	}
	applyHostSection(config)
	// A manifest default is only a baseline; a binding the resolver actually
	// chose for this plan must win over it on the same key.
	reapplyResolved(config, "platform", "adapters", adapters)
	reapplyResolved(config, "", "plugins", plugins)
	platformConfig, ok := config["platform"].(map[string]any)
	if !ok {
		platformConfig = map[string]any{}
		config["platform"] = platformConfig
	}
	platformConfig["deployment"] = map[string]any{"topology": "local"}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return Output{}, fmt.Errorf("marshal runtime config: %w", err)
	}
	return Output{Config: append(data, '\n')}, nil
}

// applyHostSection writes the host's own settings (services/host/app,
// settings.ts): the installer derives auth from the selected gateway access
// mode. host.auth is a host-facing projection of that one decision, so a
// manifest default cannot override it.
func applyHostSection(config map[string]any) {
	section, _ := config["host"].(map[string]any)
	if section == nil {
		section = map[string]any{}
	}
	auth := "on"
	if gateway, ok := config["gateway"].(map[string]any); ok {
		if access, ok := gateway["access"].(map[string]any); ok && access["mode"] == "local" {
			auth = "off"
		}
	}
	section["auth"] = auth
	config["host"] = section
}

func setConfigValue(root map[string]any, pointer, raw string) error {
	if !strings.HasPrefix(pointer, "/") || pointer == "/" {
		return fmt.Errorf("not a JSON pointer")
	}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return err
	}
	parts := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	current := root
	for _, encoded := range parts[:len(parts)-1] {
		key := strings.ReplaceAll(strings.ReplaceAll(encoded, "~1", "/"), "~0", "~")
		next, exists := current[key]
		if !exists {
			child := map[string]any{}
			current[key] = child
			current = child
			continue
		}
		child, ok := next.(map[string]any)
		if !ok {
			return fmt.Errorf("crosses non-object %q", key)
		}
		current = child
	}
	key := strings.ReplaceAll(strings.ReplaceAll(parts[len(parts)-1], "~1", "/"), "~0", "~")
	current[key] = value
	return nil
}

// moduleName turns an exact package spec ("@scope/pkg@1.2.3", what the plan and
// receipt record so the install is reproducible) into the bare module name the
// runtime adapter loader resolves from node_modules ("@scope/pkg"). The loader
// derives the package root from the first two path segments of the configured
// value, so a version suffix makes it look for a package literally named
// "@scope/pkg@1.2.3" and every service dies at boot. The installed package set
// already pins the version.
func moduleName(spec string) string {
	if at := strings.LastIndex(spec, "@"); at > 0 {
		return spec[:at]
	}
	return spec
}

func stringMapAsAny(values map[string]string) map[string]any {
	result := make(map[string]any, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

// reapplyResolved writes resolved string bindings back over whatever a
// manifest default left at config[parent][key] (parent "" means top level).
func reapplyResolved(config map[string]any, parent, key string, resolved map[string]string) {
	container := config
	if parent != "" {
		next, ok := config[parent].(map[string]any)
		if !ok {
			return
		}
		container = next
	}
	target, ok := container[key].(map[string]any)
	if !ok {
		return
	}
	for name, value := range resolved {
		// The package selected by the resolver can be represented by a
		// subpath export in the sealed platform default (for example,
		// adapters-sqlite/kv). Keep that full module specifier when it points
		// at the same package; ConfigPatch.Value only carries package@version.
		if module, ok := target[name].(string); ok && strings.HasPrefix(module, value+"/") {
			continue
		}
		target[name] = value
	}
}

func merge(target, source map[string]any) {
	for key, value := range source {
		if child, ok := value.(map[string]any); ok {
			if existing, ok := target[key].(map[string]any); ok {
				merge(existing, child)
				continue
			}
		}
		target[key] = value
	}
}

// Write owns the V2 projections after cutover. Both paths are deterministic
// and atomically swapped; callers serialise full operations via V2 runtime.
func Write(plan contracts.ResolvedInstallPlan) (Output, error) {
	output, err := Build(plan)
	if err != nil {
		return Output{}, err
	}
	root := plan.Request.PlatformRoot
	if err := os.MkdirAll(filepath.Join(root, ".kb"), 0o750); err != nil {
		return Output{}, fmt.Errorf("create config root: %w", err)
	}
	// The platform owns generated configuration. Selecting a project is only a
	// registry operation; the installer never writes into the repository.
	path := filepath.Join(root, ".kb", ConfigFilename)
	if err := writeAtomic(path, output.Config, 0o600); err != nil {
		return Output{}, fmt.Errorf("replace runtime config: %w", err)
	}
	return output, nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	return versionroot.AtomicWriteFile(path, data, mode)
}
