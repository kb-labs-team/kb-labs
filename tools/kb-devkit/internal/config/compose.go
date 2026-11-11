package config

func mergeConfigs(base, child *DevkitConfig) *DevkitConfig {
	if base == nil {
		base = &DevkitConfig{}
	}
	if child == nil {
		return base
	}

	out := *base

	if child.SchemaVersion != 0 {
		out.SchemaVersion = child.SchemaVersion
	}
	if child.Version != 0 {
		out.Version = child.Version
	}
	if child.Workspace.PackageManager != "" {
		out.Workspace.PackageManager = child.Workspace.PackageManager
	}
	if len(child.Workspace.Discovery) > 0 {
		out.Workspace.Discovery = append([]string(nil), child.Workspace.Discovery...)
	}
	if child.Workspace.MaxDepth != 0 {
		out.Workspace.MaxDepth = child.Workspace.MaxDepth
	}
	if len(child.Workspace.Include) > 0 {
		out.Workspace.Include = append([]string(nil), child.Workspace.Include...)
	}
	if len(child.Workspace.Exclude) > 0 {
		out.Workspace.Exclude = append(out.Workspace.Exclude, child.Workspace.Exclude...)
	}
	if len(child.Workspace.Categories) > 0 {
		out.Workspace.Categories = append([]NamedCategory(nil), child.Workspace.Categories...)
		out.Categories = append([]NamedCategory(nil), child.Workspace.Categories...)
	}
	if child.Run.Concurrency != 0 {
		out.Run.Concurrency = child.Run.Concurrency
	}
	if child.Run.TaskMemoryMB != 0 {
		out.Run.TaskMemoryMB = child.Run.TaskMemoryMB
	}
	if child.Affected.Strategy != "" {
		out.Affected.Strategy = child.Affected.Strategy
	}
	if child.Affected.Command != "" {
		out.Affected.Command = child.Affected.Command
	}
	if len(child.Affected.FullInputs) > 0 {
		out.Affected.FullInputs = append(out.Affected.FullInputs, child.Affected.FullInputs...)
	}
	if child.Fix.DefaultMode != "" {
		out.Fix.DefaultMode = child.Fix.DefaultMode
	}
	if child.Reporting.Verbose {
		out.Reporting.Verbose = true
	}
	if child.Checks.TimeoutMS > 0 {
		out.Checks.TimeoutMS = child.Checks.TimeoutMS
	}

	if len(child.Presets) > 0 {
		if out.Presets == nil {
			out.Presets = map[string]Preset{}
		}
		for k, v := range child.Presets {
			out.Presets[k] = v
		}
	}
	if len(child.Tasks) > 0 {
		if out.Tasks == nil {
			out.Tasks = map[string]TaskConfig{}
		}
		for k, v := range child.Tasks {
			out.Tasks[k] = v
		}
	}
	if len(child.Sync.Exclude) > 0 {
		out.Sync.Exclude = append(out.Sync.Exclude, child.Sync.Exclude...)
	}
	if len(child.Sync.Sources) > 0 {
		if out.Sync.Sources == nil {
			out.Sync.Sources = map[string]SyncSource{}
		}
		for k, v := range child.Sync.Sources {
			out.Sync.Sources[k] = v
		}
	}
	if len(child.Sync.Targets) > 0 {
		out.Sync.Targets = append(out.Sync.Targets, child.Sync.Targets...)
	}
	if len(child.Custom) > 0 {
		out.Custom = append(out.Custom, child.Custom...)
	}
	if len(child.Checks.Packages) > 0 {
		if out.Checks.Packages == nil {
			out.Checks.Packages = map[string]CheckPackConfig{}
		}
		for k, v := range child.Checks.Packages {
			out.Checks.Packages[k] = v
		}
	}
	if len(child.Scaffolding.Templates) > 0 {
		if out.Scaffolding.Templates == nil {
			out.Scaffolding.Templates = map[string]ScaffoldTemplate{}
		}
		for k, v := range child.Scaffolding.Templates {
			out.Scaffolding.Templates[k] = v
		}
	}
	return &out
}
