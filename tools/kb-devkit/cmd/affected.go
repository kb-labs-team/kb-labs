package cmd

import (
	"encoding/json"
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"
	"os"

	"github.com/kb-labs/devkit/internal/engine"
	"github.com/spf13/cobra"
)

var affectedCmd = &cobra.Command{
	Use:   "affected",
	Short: "List packages affected by the configured diff",
	Long:  "Resolves the workspace dependency graph without running any task.\nThis is intended for fast CI discovery; use `run --affected` to execute checks.",
	RunE: func(cmd *cobra.Command, args []string) error {
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

		if jsonMode {
			packages := make([]string, 0, len(selection.Packages))
			internalToolPackages := make([]string, 0)
			for _, pkg := range selection.Packages {
				packages = append(packages, pkg.Name)
				if pkg.ReleaseLane == "internal-tool" {
					internalToolPackages = append(internalToolPackages, pkg.Name)
				}
			}
			return JSONOut(map[string]any{"packages": packages, "internalToolPackages": internalToolPackages, "selectionReason": selection.Reason})
		}

		if len(selection.Packages) == 0 {
			newOutput().OK("No affected packages")
			return nil
		}
		for _, pkg := range selection.Packages {
			clikitcommand.Println(pkg.Name)
		}
		return nil
	},
}

func init() {
	affectedCmd.Flags().StringVar(&affectedChangedFilesPath, "changed-files-file", "", "read changed paths from a JSON array file")
	rootCmd.AddCommand(affectedCmd)
}

var affectedChangedFilesPath string
