package cmd

import (
	"encoding/json"
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"
	"os"

	"github.com/kb-labs/devkit/internal/engine"
	"github.com/kb-labs/devkit/internal/workspace"
	"github.com/spf13/cobra"
)

var affectedCmd = &cobra.Command{
	Use:   "affected",
	Short: "List packages affected by the configured diff",
	Long:  "Resolves the workspace dependency graph without running any task.\nThis is intended for fast CI discovery; use `run --affected` to execute checks.",
	RunE: func(cmd *cobra.Command, args []string) error {
		if affectedScope != "" && affectedScope != "platform" {
			return fmt.Errorf("unknown --scope %q; supported scope: platform", affectedScope)
		}
		ws, cfg, err := loadWorkspace()
		if err != nil {
			return err
		}

		var selection engine.AffectedSelection
		if affectedChangedFilesPath != "" {
			data, readErr := os.ReadFile(affectedChangedFilesPath)
			if readErr != nil {
				return fmt.Errorf("read changed-file manifest %s: %w", affectedChangedFilesPath, readErr)
			}
			var files []string
			if unmarshalErr := json.Unmarshal(data, &files); unmarshalErr != nil {
				return fmt.Errorf("parse changed-file manifest %s: %w", affectedChangedFilesPath, unmarshalErr)
			}
			selection, err = engine.AffectedPackagesFromFiles(ws, files, cfg.Affected.FullInputs)
		} else {
			selection, err = engine.AffectedPackages(ws, cfg)
		}
		if err != nil {
			return fmt.Errorf("affected: %w", err)
		}
		selected, excluded := selectionForScope(selection, affectedScope)

		if jsonMode {
			packages := make([]string, 0, len(selected.Packages))
			internalToolPackages := make([]string, 0)
			for _, pkg := range selected.Packages {
				packages = append(packages, pkg.Name)
				if pkg.ReleaseLane == "internal-tool" {
					internalToolPackages = append(internalToolPackages, pkg.Name)
				}
			}
			payload := map[string]any{"packages": packages, "internalToolPackages": internalToolPackages, "selectionReason": selected.Reason}
			if affectedScope == "platform" {
				payload["scope"] = platformScopeManifest(excluded)
			}
			return JSONOut(payload)
		}

		if len(selected.Packages) == 0 {
			newOutput().OK("No affected packages")
			return nil
		}
		for _, pkg := range selected.Packages {
			clikitcommand.Println(pkg.Name)
		}
		return nil
	},
}

func init() {
	affectedCmd.Flags().StringVar(&affectedChangedFilesPath, "changed-files-file", "", "read changed paths from a JSON array file")
	affectedCmd.Flags().StringVar(&affectedScope, "scope", "", "select a named verification scope (platform is partial)")
	rootCmd.AddCommand(affectedCmd)
}

var affectedChangedFilesPath string
var affectedScope string

type scopeManifest struct {
	Name             string   `json:"name"`
	Status           string   `json:"status"`
	ExcludedPackages []string `json:"excludedPackages"`
	ExcludedChecks   []string `json:"excludedChecks"`
	Warning          string   `json:"warning"`
}

func selectionForScope(selection engine.AffectedSelection, scope string) (engine.AffectedSelection, []string) {
	if scope == "" {
		return selection, nil
	}
	selected := make([]workspace.Package, 0, len(selection.Packages))
	excluded := make([]string, 0)
	for _, pkg := range selection.Packages {
		if pkg.ReleaseLane == "internal-tool" {
			excluded = append(excluded, pkg.Name)
			continue
		}
		selected = append(selected, pkg)
	}
	return engine.AffectedSelection{Packages: selected, Reason: selection.Reason}, excluded
}

func platformScopeManifest(excluded []string) scopeManifest {
	return scopeManifest{
		Name: "platform", Status: "partial", ExcludedPackages: excluded,
		ExcludedChecks: []string{"internal-tool build", "internal-tool test", "internal-tool package checks"},
		Warning:        "Partial platform verification: excluded internal-tool packages and checks are not verified.",
	}
}
