package proc

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type procStat struct {
	PID            int
	Comm           string
	State          byte
	PPID           int
	ProcessGroupID int
	SessionID      int
	StartTicks     int64
	UserTicks      int64
	SystemTicks    int64
	ResidentPages  int64
	Identity       string
}

func processStateIsLive(state byte) bool { return state != 'Z' && state != 'X' }

// parseProcStat parses Linux /proc/<pid>/stat. Comm is parenthesized but may
// itself contain parentheses, so fields begin after the final closing one.
func parseProcStat(data string) (procStat, error) {
	open := strings.IndexByte(data, '(')
	close := strings.LastIndexByte(data, ')')
	if open < 1 || close <= open || close+2 >= len(data) {
		return procStat{}, errors.New("malformed proc stat command field")
	}
	pid, err := strconv.Atoi(strings.TrimSpace(data[:open]))
	if err != nil {
		return procStat{}, fmt.Errorf("parse proc stat pid: %w", err)
	}
	fields := strings.Fields(data[close+1:])
	// fields[0] is stat field 3 (state); field 22 is index 19 here.
	if len(fields) <= 21 || len(fields[0]) != 1 {
		return procStat{}, errors.New("proc stat does not contain required fields")
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return procStat{}, fmt.Errorf("parse proc stat parent pid: %w", err)
	}
	processGroupID, err := strconv.Atoi(fields[2])
	if err != nil || processGroupID < 0 {
		return procStat{}, errors.New("parse proc stat process group: invalid value")
	}
	sessionID, err := strconv.Atoi(fields[3])
	if err != nil || sessionID < 0 {
		return procStat{}, errors.New("parse proc stat session: invalid value")
	}
	startTicks, err := strconv.ParseInt(fields[19], 10, 64)
	if err != nil || startTicks < 0 {
		return procStat{}, errors.New("parse proc stat start ticks: invalid value")
	}
	userTicks, uErr := strconv.ParseInt(fields[11], 10, 64)
	systemTicks, sErr := strconv.ParseInt(fields[12], 10, 64)
	residentPages, rErr := strconv.ParseInt(fields[21], 10, 64)
	if uErr != nil || sErr != nil || rErr != nil || residentPages < 0 {
		return procStat{}, errors.New("proc stat has invalid CPU or resident memory fields")
	}
	return procStat{PID: pid, Comm: data[open+1 : close], State: fields[0][0], PPID: ppid, ProcessGroupID: processGroupID, SessionID: sessionID, StartTicks: startTicks, UserTicks: userTicks, SystemTicks: systemTicks, ResidentPages: residentPages, Identity: strconv.FormatInt(startTicks, 10)}, nil
}

func parseProcBootTime(data string) (time.Time, error) {
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "btime" {
			seconds, err := strconv.ParseInt(fields[1], 10, 64)
			if err != nil || seconds <= 0 {
				return time.Time{}, errors.New("proc stat btime is invalid")
			}
			return time.Unix(seconds, 0), nil
		}
	}
	return time.Time{}, errors.New("proc stat has no btime")
}

func procStartTime(boot time.Time, startTicks, clockTicks int64) time.Time {
	if startTicks < 0 || clockTicks <= 0 {
		return time.Time{}
	}
	seconds := startTicks / clockTicks
	remainingTicks := startTicks % clockTicks
	nanos := remainingTicks * int64(time.Second) / clockTicks
	return boot.Add(time.Duration(seconds)*time.Second + time.Duration(nanos))
}

func processStartBoundFromTicks(boot time.Time, uptimeTicks, clockTicks int64) time.Time {
	return procStartTime(boot, uptimeTicks, clockTicks)
}
