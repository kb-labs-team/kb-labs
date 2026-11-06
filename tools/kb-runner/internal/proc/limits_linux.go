//go:build linux

package proc

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func startWithRunLimits(cfg Config, runID string, cmd *exec.Cmd) (string, func(), error) {
	noop := func() {}
	if cfg.MemoryBytes == 0 && cfg.GrantedCPUs == 0 {
		return "", noop, cmd.Start()
	}
	cgroup, err := currentCgroupPath()
	if err != nil {
		advisory := limitsAdvisory("cgroup v2: " + err.Error())
		return advisory, noop, cmd.Start()
	}
	return startWithCgroupLimits(cgroup, cfg, runID, cmd)
}

func startWithCgroupLimits(cgroup string, cfg Config, runID string, cmd *exec.Cmd) (string, func(), error) {
	noop := func() {}
	path := filepath.Join(cgroup, "kb-runner-"+runID)
	if err := os.Mkdir(path, 0o700); err != nil {
		advisory := limitsAdvisory("cgroup v2 create child: " + err.Error())
		return advisory, noop, cmd.Start()
	}
	cleanup := func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			fmt.Fprintln(os.Stderr, "proc: remove run cgroup:", err)
		}
	}
	if cfg.MemoryBytes > 0 {
		if err := os.WriteFile(filepath.Join(path, "memory.max"), []byte(strconv.FormatUint(cfg.MemoryBytes, 10)), 0o600); err != nil {
			cleanup()
			advisory := limitsAdvisory("cgroup v2 set memory.max: " + err.Error())
			return advisory, noop, cmd.Start()
		}
	}
	if cfg.GrantedCPUs > 0 {
		if err := os.WriteFile(filepath.Join(path, "cpu.max"), []byte(fmt.Sprintf("%d 100000", cfg.GrantedCPUs*100000)), 0o600); err != nil {
			cleanup()
			advisory := limitsAdvisory("cgroup v2 set cpu.max: " + err.Error())
			return advisory, noop, cmd.Start()
		}
	}
	group, err := os.Open(path)
	if err != nil {
		cleanup()
		advisory := limitsAdvisory("cgroup v2 open child: " + err.Error())
		return advisory, noop, cmd.Start()
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.UseCgroupFD, cmd.SysProcAttr.CgroupFD = true, int(group.Fd())
	startErr := cmd.Start()
	_ = group.Close()
	if startErr == nil {
		return "", cleanup, nil
	}
	cleanup()
	cmd.SysProcAttr.UseCgroupFD, cmd.SysProcAttr.CgroupFD = false, 0
	advisory := limitsAdvisory("cgroup v2 kernel refused attachment: " + startErr.Error())
	return advisory, noop, cmd.Start()
}

func currentCgroupPath() (string, error) {
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "0::") {
			rel := strings.TrimPrefix(filepath.Clean(strings.TrimPrefix(line, "0::")), string(filepath.Separator))
			return filepath.Join("/sys/fs/cgroup", rel), nil
		}
	}
	return "", fmt.Errorf("unified cgroup v2 membership not found")
}
