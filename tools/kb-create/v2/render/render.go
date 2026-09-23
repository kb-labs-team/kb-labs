// Package render materializes the resolver's exact decision. It never scans
// node_modules to infer services: rendered files are a projection of the plan.
package render

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
	"gopkg.in/yaml.v3"
)

const ConfigFilename = "kb.config.jsonc"

type Output struct {
	Config      []byte
	Devservices DevservicesFile
}

// DevservicesFile is V2's complete, intentionally small projection format.
// It lives here rather than in the old launcher's helper package so V2 owns
// both its schema validation and its on-disk writes at cutover.
type DevservicesFile struct {
	Name     string             `yaml:"name,omitempty"`
	Services map[string]Service `yaml:"services,omitempty"`
}

type Service struct {
	Name        string            `yaml:"name,omitempty"`
	Group       string            `yaml:"group,omitempty"`
	Command     string            `yaml:"command"`
	Port        int               `yaml:"port,omitempty"`
	HealthCheck string            `yaml:"health_check,omitempty"`
	DependsOn   []string          `yaml:"depends_on,omitempty"`
	Env         map[string]string `yaml:"env,omitempty"`
}

func (file DevservicesFile) Validate() error {
	ids := make([]string, 0, len(file.Services))
	for id := range file.Services {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	ports := make(map[int]string, len(ids))
	for _, id := range ids {
		service := file.Services[id]
		if strings.TrimSpace(id) == "" {
			return fmt.Errorf("service ID is required")
		}
		if strings.TrimSpace(service.Command) == "" {
			return fmt.Errorf("service %q: command is required", id)
		}
		if service.Port == 0 {
			continue
		}
		if owner, exists := ports[service.Port]; exists {
			return fmt.Errorf("services %q and %q both claim port %d", owner, id, service.Port)
		}
		ports[service.Port] = id
	}
	return nil
}

// conventionalServiceGroups mirrors .kb/devservices.dev.yaml's hand-authored
// `groups:` block — kb-dev's config loader (tools/kb-dev/internal/config/yaml.go)
// derives its Groups map from each service's own `group` field, so a
// generated devservices.yaml with no `group` field anywhere silently drops
// every group (including "backend", one of kb-dev's own "conventional"
// group names — see config.go's GroupOrder), breaking any caller (like the
// E2E platform entrypoint) that starts services by group name instead of
// listing every service individually. Not every generated service has a
// known group yet (e.g. marketplace-registry, mcp-daemon) — that mirrors
// the same gap in the hand-authored config, not an oversight here.
var conventionalServiceGroups = map[string]string{
	"state-daemon": "infra",
	"gateway":      "backend",
	"marketplace":  "backend",
	"rest":         "backend",
	"studio":       "backend",
	"workflow":     "backend",
}

// gatewayUpstreamRoute is a single entry of the gateway's proxy routing
// table (services/gateway/contracts/src/config.ts's UpstreamConfigSchema:
// serviceId, prefix, optional rewritePrefix/websocket/description). This is
// a distinct concept from platform.adapterOptions.serviceTransport.services
// (which V2 already renders): serviceTransport supplies the URL a given
// service ID resolves to for RPC calls, while gatewayUpstreamRoute maps an
// inbound HTTP path prefix to which service ID handles it. Nothing in the
// V2 plan/manifest pipeline carries per-service routing metadata today (a
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
	"rest":     {ServiceID: "rest", Prefix: "/api/v1", Websocket: true, Description: "REST API — main platform BFF"},
	"workflow": {ServiceID: "workflow", Prefix: "/api/exec", RewritePrefix: "", Description: "Workflow Daemon — direct access"},
	// The workflow plugin's manifest (plugins/workflow/entry/src/manifest.ts)
	// declares its WS channels under basePath "/v1/ws/plugins/workflow"
	// (logs/:runId, progress/:jobId). That's a distinct upstream from
	// "workflow" above (different prefix, needs websocket:true) — without
	// it, GET /api/v1/ws/plugins/workflow/... falls through to the broader
	// "rest" prefix ("/api/v1") and the workflow daemon never sees the
	// upgrade. RewritePrefix drops "/api" to match the daemon's own path.
	"workflow-ws":          {ServiceID: "workflow", Prefix: "/api/v1/ws/plugins/workflow", RewritePrefix: "/v1/ws/plugins/workflow", Websocket: true, Description: "Workflow Daemon — WebSocket channels (logs/progress)"},
	"marketplace":          {ServiceID: "marketplace", Prefix: "/api/v1/marketplace", Description: "Marketplace Service — unified entity management"},
	"widgets":              {ServiceID: "rest", Prefix: "/plugins", Description: "Plugin widget bundles — served by REST API"},
	"marketplace-registry": {ServiceID: "marketplace-registry", Prefix: "/api/v1/registry", RewritePrefix: "/api/v1", Description: "Marketplace Registry — publish, share, install kb:handle/name packages"},
	"mcp":                  {ServiceID: "mcp-daemon", Prefix: "/api/v1/mcp", Description: "MCP Daemon — plugin commands as tools for external agents"},
}

// gatewayUpstreams returns the conventional routes whose target service ID
// is actually present in this install's resolved service graph — a route
// pointing at a service this particular profile never installed would be
// silently dead weight at best.
func gatewayUpstreams(services map[string]Service) map[string]gatewayUpstreamRoute {
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
	services := make(map[string]Service, len(plan.ServiceGraph.Services))
	for _, service := range plan.ServiceGraph.Services {
		if service.ID == "" {
			return Output{}, fmt.Errorf("service ID is required")
		}
		services[service.ID] = Service{Name: service.ID, Group: conventionalServiceGroups[service.ID], Command: RuntimeCommand(service.Command), Port: service.Port, HealthCheck: healthCheckURL(service.HealthCheck, service.Port), DependsOn: service.DependsOn, Env: map[string]string{}}
	}
	file := DevservicesFile{Name: "kb-labs", Services: services}
	if err := file.Validate(); err != nil {
		return Output{}, err
	}
	adapters, plugins := map[string]string{}, map[string]string{}
	extra := map[string]any{}
	for _, patch := range plan.ConfigPatches {
		if patch.Environment != "" {
			for _, serviceID := range patch.Services {
				service, exists := services[serviceID]
				if !exists {
					return Output{}, fmt.Errorf("secret patch %s targets unknown service %q", patch.Owner, serviceID)
				}
				if existing, exists := service.Env[patch.Environment]; exists && existing != "${"+patch.Environment+"}" {
					return Output{}, fmt.Errorf("service %q has conflicting value for secret environment %q", serviceID, patch.Environment)
				}
				service.Env[patch.Environment] = "${" + patch.Environment + "}"
				services[serviceID] = service
			}
		}
		if len(patch.Path) > len("/platform/adapters/") && patch.Path[:len("/platform/adapters/")] == "/platform/adapters/" {
			adapters[patch.Path[len("/platform/adapters/"):]] = patch.Value
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
	config := map[string]any{"platform": map[string]any{"version": plan.ServiceGraph.PlatformVersion, "adapters": adapters}, "plugins": plugins}
	if upstreams := gatewayUpstreams(services); len(upstreams) > 0 {
		config["gateway"] = map[string]any{"upstreams": upstreams}
	}
	merge(config, extra)
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return Output{}, fmt.Errorf("marshal runtime config: %w", err)
	}
	return Output{Config: append(data, '\n'), Devservices: file}, nil
}

// runtimeCommand makes package-provided service binaries resolvable from an
// installed platform. kb-dev launches services outside pnpm's shell, so a
// bare manifest command such as "rest-api-app" would otherwise be absent from
// PATH even though the package's .bin entry is installed in node_modules.
func RuntimeCommand(command string) string {
	trimmed := strings.TrimSpace(command)
	if trimmed == "" || strings.ContainsAny(trimmed, " \t\n") || strings.Contains(trimmed, "/") {
		return command
	}
	switch trimmed {
	case "node", "pnpm", "npm", "yarn", "bun", "deno", "python", "python3", "go", "docker":
		return command
	default:
		return "pnpm exec " + command
	}
}

// healthCheckURL turns a manifest's relative health-check path (e.g. "/" or
// "/api/v1/health") into the absolute localhost URL kb-dev's health checker
// expects. An already-absolute value (a full URL, or a bare host:port for a
// TCP check) passes through unchanged.
func healthCheckURL(path string, port int) string {
	if path == "" || port == 0 {
		return ""
	}
	if strings.Contains(path, "://") || !strings.HasPrefix(path, "/") {
		return path
	}
	return fmt.Sprintf("http://localhost:%d%s", port, path)
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
	devservices, err := yaml.Marshal(output.Devservices)
	if err != nil {
		return Output{}, fmt.Errorf("marshal devservices: %w", err)
	}
	if err := writeAtomic(filepath.Join(root, ".kb", "devservices.yaml"), devservices, 0o644); err != nil {
		return Output{}, fmt.Errorf("write devservices: %w", err)
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
