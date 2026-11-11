//go:build linux

package host

import (
	"fmt"
	"os"
	"strconv"
)

func ProcessIdentityForPID(pid int) (string, error) {
	if pid == os.Getpid() {
		return currentProcessIdentity()
	}
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
	if err != nil {
		return "", fmt.Errorf("read process %d environment: %w", pid, err)
	}
	return processIdentityFromLinuxEnvironment(data)
}

func processIdentityFromLinuxEnvironment(data []byte) (string, error) {
	identity, err := processIdentityFromEnvironment(data)
	if err != nil {
		return "", err
	}
	if identity == "" {
		// A readable environment without the recorded token does not verify
		// either identity. Keep it undetermined; callers must never treat this
		// as permission to signal the process.
		return "", errProcessEnvironmentNotReady
	}
	return identity, nil
}
