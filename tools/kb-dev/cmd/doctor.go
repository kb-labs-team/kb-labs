package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/kb-labs/dev/internal/docker"
	"github.com/kb-labs/dev/internal/environ"
	"github.com/kb-labs/dev/internal/manager"
	"github.com/kb-labs/dev/internal/process"
	"github.com/spf13/cobra"
)

var doctorCmd = &cobra.Command{
	Use:   "doctor",
	Short: "Check environment health and diagnose issues",
	Args:  cobra.NoArgs,
	RunE:  runDoctor,
}

func init() {
	rootCmd.AddCommand(doctorCmd)
}

func runDoctor(_ *cobra.Command, _ []string) error {
	result := &manager.DoctorResult{OK: true}

	var gatewayPort int // discovered from config; 0 means "use default"

	// 1. Config.
	discovered, err := FindConfig()
	cfgPath := discovered.ConfigPath
	if err != nil {
		result.Checks = append(result.Checks, manager.DoctorCheck{
			ID: "config", OK: false, Detail: err.Error(),
		})
		result.OK = false
	} else {
		cfg, err := loadConfig(cfgPath)
		if err != nil {
			result.Checks = append(result.Checks, manager.DoctorCheck{
				ID: "config", OK: false, Detail: err.Error(), Path: cfgPath,
			})
			result.OK = false
		} else {
			result.Checks = append(result.Checks, manager.DoctorCheck{
				ID:     "config",
				OK:     true,
				Detail: fmt.Sprintf("%d services, %d groups", len(cfg.Services), len(cfg.Groups)),
				Path:   cfgPath,
			})

			// Read gateway port for later adapter-status probe.
			if gw, ok := cfg.Services["gateway"]; ok && gw.Port > 0 {
				gatewayPort = gw.Port
			}

			// 5. Port conflicts.
			for id, svc := range cfg.Services {
				if svc.Port == 0 {
					continue
				}
				pids := process.GetListenerPIDs(svc.Port)
				if len(pids) > 0 {
					result.Checks = append(result.Checks, manager.DoctorCheck{
						ID:     fmt.Sprintf("port:%d", svc.Port),
						OK:     false,
						Detail: fmt.Sprintf("occupied (PID %d), needed by %s", pids[0], id),
					})
					result.OK = false
					if result.Hint == "" {
						result.Hint = fmt.Sprintf("Port %d occupied. Fix: kb-dev stop %s --force", svc.Port, id)
					}
				} else {
					result.Checks = append(result.Checks, manager.DoctorCheck{
						ID: fmt.Sprintf("port:%d", svc.Port), OK: true, Detail: "free",
					})
				}
			}
		}
	}

	// 2. Docker.
	if docker.Available() {
		v := docker.Version()
		result.Checks = append(result.Checks, manager.DoctorCheck{
			ID: "docker", OK: true, Detail: "Docker " + v,
		})
	} else {
		result.Checks = append(result.Checks, manager.DoctorCheck{
			ID: "docker", OK: false, Detail: "Docker not available",
		})
		result.OK = false
	}

	// 3. Node.
	env := environ.Resolve()
	if env.Node != "" {
		nodeVersion := getVersion(env.Node, "--version")
		result.Checks = append(result.Checks, manager.DoctorCheck{
			ID: "node", OK: true, Detail: nodeVersion, Path: env.Node,
		})
	} else {
		result.Checks = append(result.Checks, manager.DoctorCheck{
			ID: "node", OK: false, Detail: "node not found on PATH",
		})
		result.OK = false
	}

	// 4. pnpm.
	if env.Pnpm != "" {
		pnpmVersion := getVersion(env.Pnpm, "--version")
		result.Checks = append(result.Checks, manager.DoctorCheck{
			ID: "pnpm", OK: true, Detail: pnpmVersion, Path: env.Pnpm,
		})
	} else {
		result.Checks = append(result.Checks, manager.DoctorCheck{
			ID: "pnpm", OK: false, Detail: "pnpm not found on PATH",
		})
		result.OK = false
	}

	// 6. Adapter status (optional — skipped if gateway not running).
	adapterStatuses, gatewaySkip := fetchAdapterStatuses(gatewayPort)

	// 7. Auth readiness (optional — only when the gateway answers). Read from
	// the gateway itself: it alone knows whether an admin exists.
	var authSkip string
	if gatewaySkip == "" {
		authSkip = addAuthChecks(result, gatewayPort)
	}

	if jsonMode {
		type jsonResult struct {
			*manager.DoctorResult
			Adapters     []adapterStatus `json:"adapters,omitempty"`
			AdaptersSkip string          `json:"adaptersSkip,omitempty"`
			AuthSkip     string          `json:"authSkip,omitempty"`
		}
		return JSONOut(&jsonResult{
			DoctorResult: result,
			Adapters:     adapterStatuses,
			AdaptersSkip: gatewaySkip,
			AuthSkip:     authSkip,
		})
	}

	out := newOutput()
	fmt.Println()
	fmt.Println(out.label.Render("Environment Check"))
	fmt.Println()

	for _, check := range result.Checks {
		icon := out.StatusIcon("alive")
		if !check.OK {
			icon = out.StatusIcon("failed")
		} else if check.Warn {
			icon = out.StatusIcon("degraded")
		}
		detail := check.Detail
		if check.Path != "" {
			detail += " " + out.dim.Render("("+check.Path+")")
		}
		fmt.Printf("  %s %s  %s\n", icon, Pad(check.ID, 15), detail)
	}

	// Print adapter status table.
	fmt.Println()
	fmt.Println(out.label.Render("Adapter Status"))
	fmt.Println()
	if gatewaySkip != "" {
		fmt.Printf("  %s %s\n", out.StatusIcon("dead"), out.dim.Render(gatewaySkip))
	} else {
		for _, s := range adapterStatuses {
			icon := out.StatusIcon("alive")
			modeStr := out.alive.Render(s.Mode)
			if s.Mode == "inmemory" {
				icon = out.StatusIcon("degraded")
				modeStr = out.degraded.Render(s.Mode)
			} else if s.Mode == "noop" {
				icon = out.StatusIcon("dead")
				modeStr = out.dead.Render(s.Mode)
			}
			reason := ""
			if s.Reason != "" {
				reason = out.dim.Render("(" + s.Reason + ")")
			}
			fmt.Printf("  %s %s  %s  %s  %s\n",
				icon,
				Pad(s.Slot, 20),
				Pad(modeStr, 20),
				Pad(s.Implementation, 30),
				reason,
			)
		}
	}

	if authSkip != "" {
		fmt.Printf("  %s %s\n", out.StatusIcon("dead"), out.dim.Render(authSkip))
	}

	fmt.Println()
	if result.Hint != "" {
		out.Warn(result.Hint)
	}

	if !result.OK {
		return errSilent
	}
	return nil
}

// adapterStatus mirrors the AdapterSlotStatus JSON shape from the gateway.
type adapterStatus struct {
	Slot           string `json:"slot"`
	Mode           string `json:"mode"`
	Implementation string `json:"implementation"`
	Reason         string `json:"reason,omitempty"`
	RecordedAt     string `json:"recordedAt"`
}

// fetchAdapterStatuses makes a GET request to /health/adapters on the gateway.
// gatewayPort is read from the config (0 means use default 4000).
// Returns (statuses, "") on success, or (nil, skipReason) when the gateway
// is not reachable.
func fetchAdapterStatuses(gatewayPort int) ([]adapterStatus, string) {
	port := 4000
	if gatewayPort > 0 {
		port = gatewayPort
	}

	url := fmt.Sprintf("http://localhost:%d/health/adapters", port)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "gateway not running — skipped"
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "gateway not running — skipped"
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Sprintf("gateway returned HTTP %d — skipped", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "failed to read gateway response"
	}

	var statuses []adapterStatus
	if err := json.Unmarshal(body, &statuses); err != nil {
		return nil, "failed to parse gateway response"
	}

	return statuses, ""
}

func getVersion(binary, flag string) string {
	out, err := exec.Command(binary, flag).Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}
