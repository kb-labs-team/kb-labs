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
)

const ConfigFilename = "kb.config.jsonc"

// Output is the platform's generated runtime configuration. There is no
// service-manager projection: the host process is the one runtime, and it is
// described by the plan's HostSpec, not by a rendered file.
type Output struct {
	Config []byte
}

// gatewayUpstreamRoute is a single entry of the gateway's proxy routing
// table (services/gateway/contracts/src/config.ts's UpstreamConfigSchema:
// serviceId, prefix, optional rewritePrefix/websocket/description). This is
// a distinct concept from platform.adapterOptions.serviceTransport.services:
// serviceTransport supplies the URL a given service ID resolves to for RPC
// calls, while gatewayUpstreamRoute maps an inbound HTTP path prefix to
// which service ID handles it. V2 renders only the serviceTransport adapter
// *selection* (platform.adapters.serviceTransport, a manifest default); it
// never renders adapterOptions.serviceTransport.services itself — the host
// and project runtime build that map in-process from the loopback ports they
// actually bind and inject it during platform assembly (ADR-0043 B8,
// services/host/app/src/transport.ts, services/project-runtime/app/src/
// transport.ts), so no service address is ever written to kb.config.jsonc
// (ADR-0047, docs/architecture/target/07-migration.md stage 5.4). Nothing in
// the V2 plan/manifest pipeline carries per-service routing metadata today (a
// kb.service/1 manifest has no equivalent of a plugin's declared `requires`/
// `config`), so this mirrors .kb/kb.config.json's hand-authored `gateway.
// upstreams` table verbatim rather than deriving it. Without it, the
// generated config's `gateway.upstreams` defaults to `{}` (the schema's zod
// default), so the gateway boots with zero configured upstreams and /ready
// never turns healthy — it has nothing to consider "up".
type gatewayUpstreamRoute struct {
	ServiceID     string `json:"serviceId"`
	Prefix        string `json:"prefix"`
	RewritePrefix string `json:"rewritePrefix,omitempty"`
	Websocket     bool   `json:"websocket,omitempty"`
	Description   string `json:"description,omitempty"`
}

var conventionalGatewayUpstreams = map[string]gatewayUpstreamRoute{
	"rest":                 {ServiceID: "rest", Prefix: "/api/v1", Websocket: true, Description: "REST API — main platform BFF"},
	"workflow":             {ServiceID: "workflow", Prefix: "/api/exec", RewritePrefix: "", Description: "Workflow Daemon — direct access"},
	"marketplace":          {ServiceID: "marketplace", Prefix: "/api/v1/marketplace", Description: "Marketplace Service — unified entity management"},
	"widgets":              {ServiceID: "rest", Prefix: "/plugins", Description: "Plugin widget bundles — served by REST API"},
	"marketplace-registry": {ServiceID: "marketplace-registry", Prefix: "/api/v1/registry", RewritePrefix: "/api/v1", Description: "Marketplace Registry — publish, share, install kb:handle/name packages"},
	"mcp":                  {ServiceID: "mcp-daemon", Prefix: "/api/v1/mcp", Description: "MCP Daemon — plugin commands as tools for external agents"},
}

// gatewayUpstreams returns the conventional routes whose target service ID
// is actually present in this install's resolved service graph — a route
// pointing at a service this particular profile never installed would be
// silently dead weight at best.
func gatewayUpstreams(services map[string]struct{}) map[string]gatewayUpstreamRoute {
	result := map[string]gatewayUpstreamRoute{}
	for name, route := range conventionalGatewayUpstreams {
		if _, ok := services[route.ServiceID]; ok {
			result[name] = route
		}
	}
	return result
}

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
	if upstreams := gatewayUpstreams(services); len(upstreams) > 0 {
		config["gateway"] = map[string]any{"upstreams": upstreams}
	}
	merge(config, extra)
	applyHostSection(config)
	// A manifest default is only a baseline; a binding the resolver actually
	// chose for this plan must win over it on the same key.
	reapplyResolved(config, "platform", "adapters", adapters)
	reapplyResolved(config, "", "plugins", plugins)
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return Output{}, fmt.Errorf("marshal runtime config: %w", err)
	}
	return Output{Config: append(data, '\n')}, nil
}

// applyHostSection writes the host's own settings (services/host/app,
// settings.ts): the installer, not the user, decides them. The host's policy
// overrides gateway access with host.auth, so the section must agree with the
// selected access mode: "local" is a no-login loopback install (auth off);
// anything else, including no answer, is the gateway's secured default (auth
// on). An explicit host.auth from a manifest default is left alone.
func applyHostSection(config map[string]any) {
	section, _ := config["host"].(map[string]any)
	if section == nil {
		section = map[string]any{}
	}
	if _, explicit := section["auth"]; !explicit {
		auth := "on"
		if gateway, ok := config["gateway"].(map[string]any); ok {
			if access, ok := gateway["access"].(map[string]any); ok && access["mode"] == "local" {
				auth = "off"
			}
		}
		section["auth"] = auth
	}
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
	// The platform owns the generated full configuration. Projects retain their
	// own minimal platform pointer through the existing scaffold contract.
	path := filepath.Join(root, ".kb", ConfigFilename)
	if err := writeAtomic(path, output.Config, 0o600); err != nil {
		return Output{}, fmt.Errorf("replace runtime config: %w", err)
	}
	if plan.Request.ProjectRoot != "" && plan.Request.ProjectRoot != root {
		if err := writeProjectPointer(plan.Request.ProjectRoot, root); err != nil {
			return Output{}, fmt.Errorf("write project config pointer: %w", err)
		}
	}
	return output, nil
}

func writeProjectPointer(projectRoot, platformRoot string) error {
	if err := os.MkdirAll(filepath.Join(projectRoot, ".kb"), 0o750); err != nil {
		return err
	}
	path := filepath.Join(projectRoot, ".kb", ConfigFilename)
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	data, err := json.MarshalIndent(map[string]any{"platform": map[string]string{"dir": platformRoot}}, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(path, append(data, '\n'), 0o600)
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, mode); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
