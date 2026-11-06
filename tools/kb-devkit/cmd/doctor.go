package cmd

import (
	"context"
	"errors"
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"
	"os"
	"path/filepath"
	"strings"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/toolchain"
	"github.com/spf13/cobra"
)

var doctorCmd = &cobra.Command{
	Use:   "doctor",
	Short: "Environment diagnostics",
	Long:  `Checks that the local environment is healthy: node, pnpm, submodules, devkit.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		checks := runDoctorChecks()

		if jsonMode {
			ok := true
			for _, c := range checks {
				if !c.OK {
					ok = false
					break
				}
			}
			hint := ""
			for _, c := range checks {
				if !c.OK && c.Fix != "" {
					hint = c.Fix
					break
				}
			}
			if !ok {
				return commandFailure("kb-devkit doctor")
			}
			return JSONOut(map[string]any{
				"ok":     ok,
				"checks": checks,
				"hint":   hint,
			})
		}

		o := newOutput()
		clikitcommand.Printf("\n%s\n\n", o.label.Render("Environment Diagnostics"))

		allOK := true
		for _, c := range checks {
			icon := o.StatusIcon("healthy")
			detail := c.Detail
			if !c.OK {
				icon = o.StatusIcon("error")
				detail = o.errStyle.Render(c.Detail)
				allOK = false
			}
			clikitcommand.Printf("  %s %-30s %s\n", icon, c.Name, detail)
			if !c.OK && c.Fix != "" {
				clikitcommand.Printf("       %s\n", o.dim.Render("fix: "+c.Fix))
			}
		}

		clikitcommand.Println()
		if allOK {
			o.OK("Environment is healthy")
		} else {
			o.Err("Environment has issues — see above")
		}
		return nil
	},
}

func init() {
	rootCmd.AddCommand(doctorCmd)
}

type doctorCheck struct {
	Name       string     `json:"name"`
	OK         bool       `json:"ok"`
	Detail     string     `json:"detail"`
	Fix        string     `json:"fix,omitempty"`
	Diagnostic *diag.Diag `json:"diagnostic,omitempty"`
}

func runDoctorChecks() []doctorCheck {
	var results []doctorCheck

	// Node.js version.
	results = append(results, checkCommand("node", "--version", "node.js"))

	// pnpm version.
	results = append(results, checkCommand("pnpm", "--version", "pnpm"))

	// git.
	results = append(results, checkCommand("git", "--version", "git"))

	// devkit.yaml exists.
	cwd, _ := os.Getwd()
	cfgOK := false
	cfgDetail := "not found"
	for _, name := range []string{"devkit.yaml", "devkit.yml"} {
		if _, err := os.Stat(filepath.Join(cwd, name)); err == nil {
			cfgOK = true
			cfgDetail = name
			break
		}
	}
	results = append(results, doctorCheck{
		Name:   "devkit.yaml",
		OK:     cfgOK,
		Detail: cfgDetail,
		Fix:    "create devkit.yaml in workspace root",
	})

	// pnpm-workspace.yaml.
	wsOK := false
	wsDetail := "not found"
	for _, name := range []string{"pnpm-workspace.yaml", "pnpm-workspace.yml"} {
		if _, err := os.Stat(filepath.Join(cwd, name)); err == nil {
			wsOK = true
			wsDetail = name
			break
		}
	}
	results = append(results, doctorCheck{
		Name:   "pnpm-workspace.yaml",
		OK:     wsOK,
		Detail: wsDetail,
		Fix:    "create pnpm-workspace.yaml with packages: [...]",
	})

	return results
}

func checkCommand(name, arg, label string) doctorCheck {
	executable := name
	args := []string{arg}
	if label == "pnpm" {
		node, script, err := toolchain.PnpmExecutable()
		if err != nil {
			return doctorToolFailure(label, err)
		}
		executable = node
		args = append([]string{script}, args...)
	}
	result, err := toolchain.Run(context.Background(), toolchain.Invocation{Tool: label, Executable: executable, Args: args, Operation: toolchain.OperationVersionProbe})
	if err != nil {
		var diagnostic *diag.Diag
		if errors.As(err, &diagnostic) {
			return doctorToolFailure(label, diagnostic)
		}
		return doctorCheck{
			Name:   label,
			OK:     false,
			Detail: "not found",
			Fix:    fmt.Sprintf("install %s", name),
		}
	}
	version := strings.TrimSpace(result.Stdout)
	return doctorCheck{
		Name:   label,
		OK:     true,
		Detail: version,
	}
}

func doctorToolFailure(label string, err error) doctorCheck {
	var diagnostic *diag.Diag
	if errors.As(err, &diagnostic) {
		return doctorCheck{Name: label, OK: false, Detail: diagnostic.Message, Fix: diagnostic.Hint, Diagnostic: diagnostic}
	}
	return doctorCheck{Name: label, OK: false, Detail: err.Error(), Fix: err.Error()}
}
