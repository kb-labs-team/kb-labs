//go:build darwin

package proc

import "os/exec"

func startWithRunLimits(cfg Config, _ string, cmd *exec.Cmd) (string, func(), error) {
	if cfg.MemoryBytes == 0 && cfg.GrantedCPUs == 0 {
		return "", func() {}, cmd.Start()
	}
	return limitsAdvisory("macOS has no per-tree hard caps"), func() {}, cmd.Start()
}
