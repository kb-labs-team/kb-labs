//go:build darwin

package proc

/*
#cgo LDFLAGS: -lproc
#include <errno.h>
#include <libproc.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <stdint.h>
#include <stdlib.h>

static int kb_proc_metrics(pid_t pid, uint64_t *rss, uint64_t *cpu_ns, int *error_code) {
	struct rusage_info_v2 usage;
	errno = 0;
	if (proc_pid_rusage(pid, RUSAGE_INFO_V2, (rusage_info_t *)&usage) != 0) {
		*error_code = errno == 0 ? EIO : errno;
		return 0;
	}
	*error_code = 0;
	*rss = usage.ri_resident_size;
	*cpu_ns = usage.ri_user_time + usage.ri_system_time;
	return 1;
}

static int kb_process_has_vnode(pid_t pid, uint64_t device, uint64_t inode, int *error_code) {
	for (int capacity = 32; capacity <= (1 << 16); capacity *= 2) {
		struct proc_fdinfo *fds = calloc((size_t)capacity, sizeof(*fds));
		if (fds == NULL) { *error_code = ENOMEM; return -1; }
		errno = 0;
		int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, capacity * (int)sizeof(*fds));
		int list_error = errno;
		if (bytes <= 0) {
			free(fds);
			*error_code = list_error == 0 ? EIO : list_error;
			return -1;
		}
		int count = bytes / (int)sizeof(*fds);
		if (bytes % (int)sizeof(*fds) != 0) {
			free(fds);
			*error_code = EPROTO;
			return -1;
		}
		int matched = 0;
		int inspect_error = 0;
		for (int index = 0; index < count; index++) {
			if (fds[index].proc_fdtype != PROX_FDTYPE_VNODE) continue;
			struct vnode_fdinfo vnode;
			errno = 0;
			int got = proc_pidfdinfo(pid, fds[index].proc_fd, PROC_PIDFDVNODEINFO, &vnode, sizeof(vnode));
			if (got != sizeof(vnode)) {
				if (errno != 0) inspect_error = errno;
				continue;
			}
			if ((uint64_t)vnode.pvi.vi_stat.vst_dev == device && (uint64_t)vnode.pvi.vi_stat.vst_ino == inode) {
				matched = 1;
				break;
			}
		}
		free(fds);
		if (matched) { *error_code = 0; return 1; }
		if (bytes < capacity * (int)sizeof(*fds)) {
			*error_code = inspect_error;
			return inspect_error == 0 ? 0 : -1;
		}
	}
	*error_code = EOVERFLOW;
	return -1;
}
*/
import "C"
import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

func darwinProcessSnapshot(runID string) ([]Process, error) {
	infos, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, err
	}
	processes := make([]Process, 0, len(infos))
	for _, info := range infos {
		if info.Proc.P_pid <= 0 || info.Proc.P_stat == 5 {
			continue
		}
		started := time.Unix(info.Proc.P_starttime.Sec, int64(info.Proc.P_starttime.Usec)*1000)
		sessionID, sidErr := unix.Getsid(int(info.Proc.P_pid))
		sidError := ""
		if sidErr != nil {
			sidError = sidErr.Error()
		}
		processes = append(processes, Process{
			PID: int(info.Proc.P_pid), PPID: int(info.Eproc.Ppid), processGroupID: int(info.Eproc.Pgid),
			sessionID: sessionID, sessionIDError: sidError,
			Command:   darwinCommandName(info.Proc.P_comm[:]),
			StartedAt: started, ElapsedMS: max(int64(0), time.Since(started).Milliseconds()),
			Identity: formatStart(&info), uid: info.Eproc.Ucred.Uid,
		})
	}
	candidates := processInspectionCandidates(processes, syscall.Getpid())
	processes = applyCachedProcessMarkers(processes, candidates, runID, hostProcessMarkerCache, inspectProcessMarker)
	return applyRunTokenDescriptors(processes, runID, processHasRunTokenDescriptor)
}

func processHasRunTokenDescriptor(pid int, token fileIdentity) (bool, error) {
	var errorCode C.int
	matched := C.kb_process_has_vnode(C.pid_t(pid), C.uint64_t(token.Device), C.uint64_t(token.Inode), &errorCode)
	if matched < 0 {
		if errorCode == 0 {
			return false, fmt.Errorf("inspect process %d run-token descriptors: libproc returned no match status", pid)
		}
		return false, fmt.Errorf("inspect process %d run-token descriptors: %w", pid, syscall.Errno(errorCode))
	}
	return matched == 1, nil
}

func (osProcessSource) Metrics(tree []Process) ([]Process, error) {
	return darwinProcessMetrics(tree)
}

func darwinProcessMetrics(tree []Process) ([]Process, error) {
	out := append([]Process(nil), tree...)
	var failures []error
	for index := range out {
		out[index].RSSBytes = 0
		out[index].CPUSeconds = 0
		out[index].MetricsAvailable = false
		if out[index].Unverified {
			continue
		}
		record, err := unix.SysctlRaw("kern.proc.pid", out[index].PID)
		if err != nil {
			if processGone(err) {
				continue
			}
			failures = append(failures, fmt.Errorf("inspect process %d for metrics: %w", out[index].PID, err))
			continue
		}
		info, gone, err := decodeDarwinKinfoProc(record)
		if err != nil {
			failures = append(failures, fmt.Errorf("inspect process %d for metrics: %w", out[index].PID, err))
			continue
		}
		if gone || formatStart(info) != out[index].Identity {
			continue
		}
		var rss, cpuNS C.uint64_t
		var errorCode C.int
		if C.kb_proc_metrics(C.pid_t(out[index].PID), &rss, &cpuNS, &errorCode) == 0 {
			if err := darwinProcessMetricsError(out[index].PID, int(errorCode)); err != nil {
				failures = append(failures, err)
			}
			continue
		}
		out[index].RSSBytes = uint64(rss)
		out[index].CPUSeconds = float64(cpuNS) / 1e9
		out[index].MetricsAvailable = true
	}
	return out, errors.Join(failures...)
}

func darwinProcessMetricsError(pid, errorCode int) error {
	cause := syscall.Errno(errorCode)
	if processGone(cause) {
		return nil
	}
	if cause == 0 {
		cause = syscall.EIO
	}
	return fmt.Errorf("read resource metrics for process %d: %w", pid, cause)
}

func decodeDarwinKinfoProc(data []byte) (*unix.KinfoProc, bool, error) {
	if len(data) == 0 {
		return nil, true, nil
	}
	info := new(unix.KinfoProc)
	size := int(unsafe.Sizeof(*info))
	if len(data) != size {
		return nil, false, fmt.Errorf("kern.proc.pid returned %d bytes, want %d: %w", len(data), size, syscall.EIO)
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(info)), size), data)
	return info, false, nil
}

func darwinCommandName(comm []byte) string {
	if end := bytes.IndexByte(comm, 0); end >= 0 {
		comm = comm[:end]
	}
	return string(comm)
}

// kern.procargs2 exposes the current exec image's argv and environment. execve
// can replace the environment without changing PID or process start time, so
// the cache captures it at the first non-ancestral observation. A process
// already seen in ancestry remains owned by persisted identity history if a
// later exec removes the marker; an unrelated process first seen without a
// marker is not retroactively adopted if its later exec adds one.
func inspectProcessMarker(pid int) (string, bool, error) {
	args, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		if processGone(err) {
			return "", false, err
		}
		return "", true, err
	}
	_, position, err := parseProcargs2(args)
	if err != nil {
		return "", true, err
	}
	return processMarkerValue(args[position:]), false, nil
}

func procargs2Arguments(data []byte) ([]string, error) {
	argv, _, err := parseProcargs2(data)
	return argv, err
}

func parseProcargs2(data []byte) ([]string, int, error) {
	if len(data) < 5 {
		return nil, 0, errors.New("kern.procargs2 record is truncated before argv")
	}
	argc := int(int32(binary.NativeEndian.Uint32(data[:4])))
	if argc < 0 || argc > 1<<16 {
		return nil, 0, fmt.Errorf("kern.procargs2 record has invalid argc %d", argc)
	}
	position := 4
	execPathEnd := bytes.IndexByte(data[position:], 0)
	if execPathEnd < 0 {
		return nil, 0, errors.New("kern.procargs2 record has no exec-path terminator")
	}
	position += execPathEnd + 1
	for position < len(data) && data[position] == 0 {
		position++
	}
	argv := make([]string, 0, argc)
	for index := 0; index < argc; index++ {
		if position >= len(data) {
			return nil, 0, fmt.Errorf("kern.procargs2 record ends before argv element %d", index)
		}
		end := bytes.IndexByte(data[position:], 0)
		if end < 0 {
			return nil, 0, fmt.Errorf("kern.procargs2 argv element %d has no NUL terminator", index)
		}
		argv = append(argv, string(data[position:position+end]))
		position += end + 1
	}
	return argv, position, nil
}

func procargs2HasEnvironment(data []byte) bool {
	_, position, err := parseProcargs2(data)
	if err != nil {
		return false
	}
	for _, item := range bytes.Split(data[position:], []byte{0}) {
		if bytes.Contains(item, []byte{'='}) {
			return true
		}
	}
	return false
}
