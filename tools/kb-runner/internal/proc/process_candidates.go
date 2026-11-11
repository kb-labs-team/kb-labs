//go:build darwin || linux

package proc

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

func applyRunTokenDescriptors(processes []Process, runID string, inspect func(int, fileIdentity) (bool, error)) ([]Process, error) {
	token, exists, err := runTokenIdentity(runID)
	if err != nil {
		return processes, err
	}
	if !exists {
		return processes, nil
	}
	out := append([]Process(nil), processes...)
	currentUID := uint32(syscall.Getuid())
	for index := range out {
		if out[index].uid != currentUID {
			out[index].tokenResult = "out-of-scope"
			continue
		}
		matched, inspectErr := inspect(out[index].PID, token)
		if processGone(inspectErr) {
			out[index].tokenResult = "gone-during-token-scan"
			out[index].tokenReadError = inspectErr.Error()
			continue
		}
		if inspectErr != nil {
			out[index].tokenResult = "unreadable"
			out[index].tokenReadError = inspectErr.Error()
			continue
		}
		if matched {
			out[index].runToken = true
			out[index].tokenResult = "match"
		} else {
			out[index].tokenResult = "absent"
		}
	}
	return out, nil
}

type processMarkerResult struct {
	runID        string
	unverified   bool
	markerResult string
	markerError  string
}

type processMarkerCache struct {
	mu      sync.Mutex
	entries map[string]processMarkerResult
}

func newProcessMarkerCache() *processMarkerCache {
	return &processMarkerCache{entries: make(map[string]processMarkerResult)}
}

var hostProcessMarkerCache = newProcessMarkerCache()

func (cache *processMarkerCache) lookup(process Process, inspect func(int) (string, bool, error)) processMarkerResult {
	key := processObservationKey(process)
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if result, exists := cache.entries[key]; exists {
		return result
	}
	marker, unverified, err := inspect(process.PID)
	if processGone(err) {
		return processMarkerResult{markerResult: "gone-during-marker-read", markerError: err.Error()}
	}
	if err != nil {
		unverified = true
	}
	markerResult := "absent"
	if err != nil || unverified {
		markerResult = "unreadable"
	} else if marker != "" {
		markerResult = "other-run"
	}
	markerError := ""
	if err != nil {
		markerError = err.Error()
	}
	result := processMarkerResult{runID: marker, unverified: unverified, markerResult: markerResult, markerError: markerError}
	cache.entries[key] = result
	return result
}

func processInspectionCandidates(processes []Process, rootPID int) map[int]bool {
	candidates := make(map[int]bool)
	for _, process := range processes {
		if process.PID != rootPID {
			candidates[process.PID] = true
		}
	}
	return candidates
}

func runRecoveryCandidates(processes []Process, runStartedAt time.Time, recorded []Process) ([]Process, error) {
	if runStartedAt.IsZero() {
		return nil, fmt.Errorf("lost-run recovery requires the durable run start time")
	}
	recordedIdentities := make(map[string]struct{}, len(recorded))
	for _, process := range recorded {
		if process.PID > 0 && process.Identity != "" {
			recordedIdentities[processObservationKey(process)] = struct{}{}
		}
	}
	children := make(map[int][]Process)
	for _, process := range processes {
		if process.PPID > 0 {
			children[process.PPID] = append(children[process.PPID], process)
		}
	}
	owned := make(map[int]Process)
	queue := make([]int, 0, len(recordedIdentities))
	add := func(process Process, reason string) (bool, error) {
		if process.processState == "Z" || process.processState == "X" || processBelongsToAnotherRun(process) {
			return false, nil
		}
		if process.StartedAt.IsZero() {
			return false, fmt.Errorf("%s process %d has no process start time", reason, process.PID)
		}
		if process.StartedAt.Before(runStartedAt) {
			return false, nil
		}
		if _, exists := owned[process.PID]; exists {
			return false, nil
		}
		owned[process.PID] = process
		queue = append(queue, process.PID)
		return true, nil
	}
	for _, process := range processes {
		_, recordedIdentity := recordedIdentities[processObservationKey(process)]
		if !process.runMarker && !recordedIdentity {
			continue
		}
		reason := "run-marked"
		if recordedIdentity {
			reason = "recorded"
		}
		if _, err := add(process, reason); err != nil {
			return nil, err
		}
	}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		for _, child := range children[parent] {
			if child.processState == "Z" || child.processState == "X" || processBelongsToAnotherRun(child) {
				continue
			}
			if child.StartedAt.IsZero() {
				return nil, fmt.Errorf("descendant process %d of owned PID %d has no process start time", child.PID, parent)
			}
			if _, err := add(child, fmt.Sprintf("descendant of owned PID %d", parent)); err != nil {
				return nil, err
			}
		}
	}
	out := make([]Process, 0, len(owned))
	for _, process := range owned {
		out = append(out, process)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PID < out[j].PID })
	return out, nil
}

func applyCachedProcessMarkers(processes []Process, candidates map[int]bool, runID string, cache *processMarkerCache, inspect func(int) (string, bool, error)) []Process {
	if runID == "" {
		return processes
	}
	out := make([]Process, 0, len(processes))
	for _, process := range processes {
		if !candidates[process.PID] {
			out = append(out, process)
			continue
		}
		result := cache.lookup(process, inspect)
		process.runMarker = result.runID == runID
		switch {
		case result.markerResult == "gone-during-marker-read":
			process.markerResult = result.markerResult
		case result.unverified:
			process.markerResult = "unreadable"
		case result.runID == runID:
			process.markerResult = "match"
		case result.runID == "":
			process.markerResult = "absent"
		default:
			process.markerResult = "other-run"
		}
		process.Unverified = process.Unverified || result.unverified
		process.markerReadError = result.markerError
		out = append(out, process)
	}
	return out
}

func processMarkerValue(data []byte) string {
	for _, value := range strings.Split(string(data), "\x00") {
		name, result, found := strings.Cut(value, "=")
		if found && name == runEnv {
			return result
		}
	}
	return ""
}
