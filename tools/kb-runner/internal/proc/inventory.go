//go:build darwin || linux

package proc

import (
	"fmt"
	"sort"
	"syscall"
	"time"
)

const (
	inventorySampleCadence = 20 * time.Millisecond
	inventorySettleSamples = 6
	inventorySettleWindow  = inventorySampleCadence * (inventorySettleSamples - 1)
)

// ProcessInventoryEntry is one process-table row suitable for external
// inventory consumers. Argv is populated only when the OS returned the exact
// argument vector. Argv failures are marked Unverified only after repeated
// observations confirm the same live PID/start identity throughout the settle
// window. Other unresolved identity observations remain explicit separately.
type ProcessInventoryEntry struct {
	PID              int      `json:"pid"`
	PPID             int      `json:"ppid"`
	UID              uint32   `json:"uid"`
	Identity         string   `json:"identity"`
	Command          string   `json:"command"`
	CWD              string   `json:"cwd,omitempty"`
	CwdError         string   `json:"cwd_error,omitempty"`
	Argv             []string `json:"argv"`
	Unverified       bool     `json:"unverified"`
	ArgvError        string   `json:"argv_error,omitempty"`
	ObservationError string   `json:"observation_error"`
	SettleMS         int64    `json:"settle_ms"`
	Samples          int      `json:"samples"`
}

// ProcessInventory returns the OS process table with argv read as structured
// arguments, never reconstructed from a display command. Foreign-uid argv is
// not inspected. Same-uid argv failures are settled over six observations
// spanning 100ms; gone, reused, zombie, or newly readable PIDs resolve in this
// owner, while a still-live process with continuously unreadable argv remains
// explicit as unverified.
func ProcessInventory() ([]ProcessInventoryEntry, error) {
	processes, err := (osProcessSource{}).Snapshot("")
	if err != nil {
		return nil, fmt.Errorf("process inventory: snapshot process table: %w", err)
	}
	sort.Slice(processes, func(i, j int) bool { return processes[i].PID < processes[j].PID })
	currentUID := uint32(syscall.Getuid())
	entries := make([]ProcessInventoryEntry, 0, len(processes))
	for _, process := range processes {
		entry, include := inventoryEntryWithReaders(process, currentUID, readProcessArguments, readProcessIdentity, readProcessCWD)
		if !include {
			continue
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func inventoryEntry(process Process, currentUID uint32, readArguments func(int) ([]string, error), readIdentity func(int) (string, bool, error)) (ProcessInventoryEntry, bool) {
	return inventoryEntryWithReaders(process, currentUID, readArguments, readIdentity, func(int) (string, error) { return "", nil })
}

func inventoryEntryWithReaders(process Process, currentUID uint32, readArguments func(int) ([]string, error), readIdentity func(int) (string, bool, error), readCWD func(int) (string, error)) (ProcessInventoryEntry, bool) {
	entry := ProcessInventoryEntry{
		PID: process.PID, PPID: process.PPID, UID: process.uid, Identity: process.Identity, Command: process.Command,
		Argv: []string{}, SettleMS: inventorySettleWindow.Milliseconds(),
	}
	cwd, cwdErr := readCWD(process.PID)
	identity, alive, identityErr := readIdentity(process.PID)
	if processGone(identityErr) || (identityErr == nil && (!alive || identity != process.Identity)) {
		return ProcessInventoryEntry{}, false
	}
	if identityErr != nil {
		entry.ObservationError = fmt.Sprintf("PID/start identity could not be rechecked after cwd read: %v", identityErr)
	} else if cwdErr != nil {
		entry.CwdError = cwdErr.Error()
	} else {
		entry.CWD = cwd
	}
	if process.uid != currentUID {
		entry.ArgvError = fmt.Sprintf("argv not inspected: process uid %d differs from caller uid %d", process.uid, currentUID)
		return entry, true
	}
	stableUnreadableSamples := 0
	var lastArgumentErr error
	var lastIdentityErr error
	for sample := 0; sample < inventorySettleSamples; sample++ {
		if sample > 0 {
			time.Sleep(inventorySampleCadence)
		}
		entry.Samples++
		argv, argumentErr := readArguments(process.PID)
		identity, alive, identityErr := readIdentity(process.PID)
		if processGone(identityErr) || (identityErr == nil && !alive) {
			return ProcessInventoryEntry{}, false
		}
		if identityErr != nil {
			stableUnreadableSamples = 0
			lastIdentityErr = identityErr
			if argumentErr != nil {
				lastArgumentErr = argumentErr
			}
			continue
		}
		if identity != process.Identity {
			return ProcessInventoryEntry{}, false
		}
		lastIdentityErr = nil
		if argumentErr == nil {
			entry.Argv = argv
			return entry, true
		}
		lastArgumentErr = argumentErr
		stableUnreadableSamples++
	}
	if stableUnreadableSamples == entry.Samples {
		entry.Unverified = true
		entry.ArgvError = lastArgumentErr.Error()
		return entry, true
	}
	if lastIdentityErr != nil {
		entry.ObservationError = fmt.Sprintf("PID/start identity was not observable across the %d ms settle window: %v", entry.SettleMS, lastIdentityErr)
	} else {
		entry.ObservationError = fmt.Sprintf("PID/start identity and argv did not settle across the %d ms window", entry.SettleMS)
	}
	if lastArgumentErr != nil {
		entry.ArgvError = lastArgumentErr.Error()
	}
	return entry, true
}
