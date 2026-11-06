//go:build linux

package proc

import (
	"fmt"
	"os"
	"strings"
)

func testProcessStopped(pid int) (stopped, present bool, err error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false, false, err
	}
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 || end+2 >= len(data) {
		return false, true, fmt.Errorf("malformed /proc/%d/stat", pid)
	}
	state := data[end+2]
	return state == 'T' || state == 't', state != 'Z' && state != 'X', nil
}
