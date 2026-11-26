package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/devkit/internal/journey"
	"github.com/spf13/cobra"
)

var journeyPlanFile string
var journeyShardsPerMode int
var journeyEvidenceDirs []string
var journeyShardID string
var journeyShardStatus string
var journeyReportPaths []string

var journeyCmd = &cobra.Command{
	Use:   "journey",
	Short: "Plan and validate complete installer journey shards",
}

var journeyPlanCmd = &cobra.Command{
	Use:   "plan",
	Short: "Create a deterministic plan from the complete QA-resolved installer route",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		if journeyPlanFile == "" {
			return fmt.Errorf("--plan-file is required")
		}
		ws, _, err := loadWorkspace()
		if err != nil {
			return fmt.Errorf("discover workspace: %w", err)
		}
		producer := exec.Command("python3", "e2e/journey/select_from_cases.py", "--full-runnable-selection")
		producer.Dir = ws.Root
		data, err := producer.CombinedOutput()
		if err != nil {
			return fmt.Errorf("produce authoritative full route selection: %w: %s", err, strings.TrimSpace(string(data)))
		}
		var selection journey.Selection
		if err := json.Unmarshal(data, &selection); err != nil {
			return fmt.Errorf("parse authoritative full route selection: %w", err)
		}
		plan, err := journey.BuildPlan(selection, journeyShardsPerMode)
		if err != nil {
			return fmt.Errorf("journey plan: %w", err)
		}
		if err := writeJourneyJSON(journeyPlanFile, plan); err != nil {
			return err
		}
		if jsonMode {
			encoded, _ := json.Marshal(plan)
			clikitcommand.Printf("%s\n", encoded)
		} else {
			clikitcommand.Printf("Journey plan %s for %s: %d shards, %d full-route steps\n", plan.ID, plan.SourceSHA, len(plan.Shards), len(plan.FullSelection))
			clikitcommand.Printf("Plan file: %s\n", journeyPlanFile)
		}
		return nil
	},
}

var journeyResultCmd = &cobra.Command{
	Use:   "result",
	Short: "Validate shard evidence and run current QA release coverage",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		if journeyPlanFile == "" || len(journeyEvidenceDirs) == 0 {
			return fmt.Errorf("--plan-file and at least one --evidence-dir are required")
		}
		data, err := os.ReadFile(journeyPlanFile)
		if err != nil {
			return fmt.Errorf("read journey plan: %w", err)
		}
		var plan journey.Plan
		if err := json.Unmarshal(data, &plan); err != nil {
			return fmt.Errorf("parse journey plan: %w", err)
		}
		root, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("resolve workspace root: %w", err)
		}
		result, err := journey.Finalize(plan, journeyEvidenceDirs, func(mode string, reports []string) error {
			return runJourneyCoverage(context.Background(), root, mode, reports)
		})
		if err != nil {
			return err
		}
		if jsonMode {
			encoded, _ := json.Marshal(result)
			clikitcommand.Printf("%s\n", encoded)
		} else {
			clikitcommand.Printf("Installer journey result: %s (%d shards, source %s)\n", result.Status, len(result.Shards), result.SourceSHA)
		}
		return nil
	},
}

var journeyRecordCmd = &cobra.Command{
	Use:   "record",
	Short: "Write one shard result manifest into its isolated evidence directory",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		if journeyPlanFile == "" || journeyShardID == "" || len(journeyEvidenceDirs) != 1 || len(journeyReportPaths) == 0 {
			return fmt.Errorf("--plan-file, --shard-id, one --evidence-dir, and at least one --report are required")
		}
		data, err := os.ReadFile(journeyPlanFile)
		if err != nil {
			return fmt.Errorf("read journey plan: %w", err)
		}
		var plan journey.Plan
		if err := json.Unmarshal(data, &plan); err != nil {
			return fmt.Errorf("parse journey plan: %w", err)
		}
		if err := journey.RecordShardResult(plan, journeyShardID, journeyShardStatus, journeyEvidenceDirs[0], journeyReportPaths); err != nil {
			return err
		}
		clikitcommand.Printf("Recorded shard %s for plan %s\n", journeyShardID, plan.ID)
		return nil
	},
}

func init() {
	journeyPlanCmd.Flags().StringVar(&journeyPlanFile, "plan-file", "", "write the immutable shard plan to this new file")
	journeyPlanCmd.Flags().IntVar(&journeyShardsPerMode, "shards-per-mode", 4, "target shard count for each execution mode")
	journeyResultCmd.Flags().StringVar(&journeyPlanFile, "plan-file", "", "the immutable journey plan JSON")
	journeyResultCmd.Flags().StringArrayVar(&journeyEvidenceDirs, "evidence-dir", nil, "one shard's isolated evidence directory; repeat once per planned shard")
	journeyRecordCmd.Flags().StringVar(&journeyPlanFile, "plan-file", "", "the immutable journey plan JSON")
	journeyRecordCmd.Flags().StringVar(&journeyShardID, "shard-id", "", "planned shard identity")
	journeyRecordCmd.Flags().StringVar(&journeyShardStatus, "status", "passed", "shard execution status: passed or failed")
	journeyRecordCmd.Flags().StringArrayVar(&journeyEvidenceDirs, "evidence-dir", nil, "this shard's isolated evidence directory")
	journeyRecordCmd.Flags().StringArrayVar(&journeyReportPaths, "report", nil, "report path relative to the evidence directory; repeat for each report")
	journeyCmd.AddCommand(journeyPlanCmd, journeyRecordCmd, journeyResultCmd)
	rootCmd.AddCommand(journeyCmd)
}

func writeJourneyJSON(path string, value any) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve plan path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
		return fmt.Errorf("create plan directory: %w", err)
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode journey plan: %w", err)
	}
	data = append(data, '\n')
	file, err := os.OpenFile(absolute, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return fmt.Errorf("refusing to overwrite existing journey plan %s", absolute)
		}
		return fmt.Errorf("write journey plan: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return fmt.Errorf("write journey plan: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close journey plan: %w", err)
	}
	return nil
}

func runJourneyCoverage(ctx context.Context, workspaceRoot, mode string, reports []string) error {
	cli := filepath.Join(workspaceRoot, "cli", "bin", "dist", "bin.js")
	if _, err := os.Stat(cli); err != nil {
		return fmt.Errorf("QA coverage CLI is unavailable at %s: %w", cli, err)
	}
	args := []string{cli, "qa", "coverage", "show", "--level", "release", "--mode", mode, "--json", "--run", strings.Join(reports, ",")}
	command := exec.CommandContext(ctx, "node", args...)
	command.Dir = workspaceRoot
	output, err := command.CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(output))
		if len(text) > 1200 {
			text = text[len(text)-1200:]
		}
		if text == "" {
			return fmt.Errorf("qa coverage show failed for %s: %w", mode, err)
		}
		return fmt.Errorf("qa coverage show failed for %s: %w: %s", mode, err, text)
	}
	return nil
}
