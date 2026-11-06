//go:build darwin || linux

package proc

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const maxTeardownEventRows = 2
const maxTeardownEventInventorySamples = 2
const maxTeardownInventoryRowsPerSample = 2
const maxTeardownRejectedCountClasses = 8
const maxTeardownFreeTextJSONBytes = 512
const maxTeardownErrorJSONBytes = 1024
const maxTeardownPressureMetrics = 4
const maxTeardownResourceIdentities = 4

func boundedText(value string) string {
	return boundedJSONText(value, maxTeardownFreeTextJSONBytes)
}

func boundedCommand(value string) string {
	return boundedText(value)
}

func boundedError(value string) string {
	return boundedJSONText(value, maxTeardownErrorJSONBytes)
}

func boundedJSONText(value string, maxEncodedBytes int) string {
	if maxEncodedBytes < 2 {
		return ""
	}
	var bounded strings.Builder
	encodedBytes := 2 // JSON string quotes
	for len(value) > 0 {
		r, size := utf8.DecodeRuneInString(value)
		invalid := r == utf8.RuneError && size == 1
		encodedRuneBytes := utf8.RuneLen(r)
		switch r {
		case '"', '\\', '\b', '\f', '\n', '\r', '\t':
			encodedRuneBytes = 2
		case '<', '>', '&', '\u2028', '\u2029':
			encodedRuneBytes = 6
		default:
			if r < 0x20 {
				encodedRuneBytes = 6
			}
		}
		if encodedBytes+encodedRuneBytes > maxEncodedBytes {
			break
		}
		if invalid {
			bounded.WriteRune(utf8.RuneError)
		} else {
			bounded.WriteString(value[:size])
		}
		encodedBytes += encodedRuneBytes
		value = value[size:]
	}
	return bounded.String()
}

func boundProcess(process *Process) {
	process.Command = boundedText(process.Command)
	process.sessionIDError = boundedError(process.sessionIDError)
	process.markerResult = boundedText(process.markerResult)
	process.markerReadError = boundedError(process.markerReadError)
	process.tokenResult = boundedText(process.tokenResult)
	process.tokenReadError = boundedError(process.tokenReadError)
	process.OwnershipUnverifiedReason = OwnershipUnverifiedReason(boundedError(string(process.OwnershipUnverifiedReason)))
}

func boundInventoryEvidence(process *ProcessTreeInventoryEvidence) {
	process.SIDError = boundedError(process.SIDError)
	process.MarkerResult = boundedText(process.MarkerResult)
	process.MarkerError = boundedError(process.MarkerError)
	process.TokenResult = boundedText(process.TokenResult)
	process.TokenError = boundedError(process.TokenError)
	process.OwnershipUnverifiedReason = OwnershipUnverifiedReason(boundedError(string(process.OwnershipUnverifiedReason)))
	process.Membership = boundedText(process.Membership)
}

func boundedTeardownEvent(event Event) Event {
	if event.Type != EventTeardown {
		return event
	}
	var omitted int
	limit := func(length int) int {
		if length > maxTeardownEventRows {
			omitted += length - maxTeardownEventRows
			return maxTeardownEventRows
		}
		return length
	}
	event.ProcessTree = event.ProcessTree[:limit(len(event.ProcessTree))]
	event.Leaves = event.Leaves[:limit(len(event.Leaves))]
	event.Reaped = event.Reaped[:limit(len(event.Reaped))]
	event.Unverified = event.Unverified[:limit(len(event.Unverified))]
	event.Remaining = event.Remaining[:limit(len(event.Remaining))]
	event.TeardownHistory = event.TeardownHistory[:limit(len(event.TeardownHistory))]
	event.WaitingItems = event.WaitingItems[:limit(len(event.WaitingItems))]
	event.Command = boundedCommand(event.Command)
	event.Binary = boundedText(event.Binary)
	event.Tag = boundedText(event.Tag)
	event.Error = boundedError(event.Error)
	event.Reason = boundedError(event.Reason)
	event.LimitsAdvisory = boundedText(event.LimitsAdvisory)
	event.ResourceNotice = boundedText(event.ResourceNotice)
	event.GovernorDecision = boundedText(event.GovernorDecision)
	for i := range event.ProcessTree {
		boundProcess(&event.ProcessTree[i])
	}
	for i := range event.Leaves {
		boundProcess(&event.Leaves[i])
	}
	for i := range event.Reaped {
		boundProcess(&event.Reaped[i])
	}
	for i := range event.Unverified {
		boundProcess(&event.Unverified[i])
	}
	for i := range event.Remaining {
		boundProcess(&event.Remaining[i])
	}
	if len(event.TeardownInventory) > maxTeardownEventInventorySamples {
		event.TeardownInventoryOmitted += len(event.TeardownInventory) - maxTeardownEventInventorySamples
		event.TeardownInventory = event.TeardownInventory[:maxTeardownEventInventorySamples]
	}
	for i := range event.TeardownInventory {
		sample := &event.TeardownInventory[i]
		sample.SnapshotErr = boundedError(sample.SnapshotErr)
		if len(sample.Processes) > maxTeardownInventoryRowsPerSample {
			omitted += len(sample.Processes) - maxTeardownInventoryRowsPerSample
			sample.Processes = sample.Processes[:maxTeardownInventoryRowsPerSample]
		}
		if len(sample.RejectedExamples) > 1 {
			omitted += len(sample.RejectedExamples) - 1
			sample.RejectedExamples = sample.RejectedExamples[:1]
		}
		if len(sample.RejectedCounts) > maxTeardownRejectedCountClasses {
			omitted += len(sample.RejectedCounts) - maxTeardownRejectedCountClasses
			sample.RejectedCounts = sample.RejectedCounts[:maxTeardownRejectedCountClasses]
		}
		for j := range sample.Processes {
			boundInventoryEvidence(&sample.Processes[j])
		}
		for j := range sample.RejectedExamples {
			boundInventoryEvidence(&sample.RejectedExamples[j])
		}
		for j := range sample.RejectedCounts {
			count := &sample.RejectedCounts[j]
			count.Membership = boundedText(count.Membership)
			count.MarkerResult = boundedText(count.MarkerResult)
			count.TokenResult = boundedText(count.TokenResult)
			count.UIDClass = boundedText(count.UIDClass)
		}
	}
	for i := range event.WaitingItems {
		event.WaitingItems[i] = boundedText(event.WaitingItems[i])
	}
	if len(event.Resources.Remaining) > maxTeardownResourceIdentities {
		event.Resources.Omitted += len(event.Resources.Remaining) - maxTeardownResourceIdentities
		event.Resources.Remaining = event.Resources.Remaining[:maxTeardownResourceIdentities]
	}
	for i := range event.Resources.Remaining {
		item := &event.Resources.Remaining[i]
		item.Resource.Error = boundedError(item.Resource.Error)
	}
	if event.Pressure.Unavailable != nil {
		keys := make([]string, 0, len(event.Pressure.Unavailable))
		for key := range event.Pressure.Unavailable {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		bounded := make(map[string]string, min(len(keys), maxTeardownPressureMetrics))
		for _, key := range keys[:min(len(keys), maxTeardownPressureMetrics)] {
			bounded[boundedText(key)] = boundedText(event.Pressure.Unavailable[key])
		}
		omitted += len(keys) - len(bounded)
		event.Pressure.Unavailable = bounded
	}
	event.Pressure.Pressure = boundedText(event.Pressure.Pressure)
	event.Pressure.Swap = boundedText(event.Pressure.Swap)
	event.TeardownEvidenceOmitted += omitted
	return event
}

// EventSizeError means a teardown event's required, untruncated evidence cannot
// fit in the JSONL writer budget. Callers can identify the event that failed.
type EventSizeError struct {
	EventType EventType
	Bytes     int
	Limit     int
}

func (err *EventSizeError) Error() string {
	return fmt.Sprintf("proc: %s event requires %d bytes with untruncated identities; writer limit is %d bytes", err.EventType, err.Bytes, err.Limit)
}

func dropLastTeardownSample(event *Event) bool {
	if len(event.Resources.Remaining) > 0 {
		event.Resources.Remaining = event.Resources.Remaining[:len(event.Resources.Remaining)-1]
		event.Resources.Omitted++
		return true
	}
	for i := len(event.TeardownInventory) - 1; i >= 0; i-- {
		sample := &event.TeardownInventory[i]
		if len(sample.RejectedExamples) > 0 {
			sample.RejectedExamples = sample.RejectedExamples[:len(sample.RejectedExamples)-1]
			event.TeardownEvidenceOmitted++
			return true
		}
	}
	if len(event.TeardownInventory) > 0 {
		event.TeardownInventory = event.TeardownInventory[:len(event.TeardownInventory)-1]
		event.TeardownInventoryOmitted++
		return true
	}
	for _, rows := range []*[]Process{&event.Remaining, &event.Unverified, &event.Reaped, &event.Leaves, &event.ProcessTree} {
		if len(*rows) > 0 {
			*rows = (*rows)[:len(*rows)-1]
			event.TeardownEvidenceOmitted++
			return true
		}
	}
	if len(event.TeardownHistory) > 0 {
		event.TeardownHistory = event.TeardownHistory[:len(event.TeardownHistory)-1]
		event.TeardownEvidenceOmitted++
		return true
	}
	return false
}

func summarizeResourceOutcomes(resources []Resource) ResourceOutcomeSummary {
	summary := ResourceOutcomeSummary{Counts: make(map[string]int)}
	for _, resource := range resources {
		outcome := resource.Outcome
		summary.Counts[outcome]++
		if outcome != ResourcePending && outcome != ResourceFailed && outcome != ResourceRefused && outcome != "" {
			continue
		}
		if len(summary.Remaining) < maxTeardownResourceIdentities {
			summary.Remaining = append(summary.Remaining, ResourceOutcomeSummaryItem{
				Resource: resource,
				Outcome:  outcome,
			})
		} else {
			summary.Omitted++
		}
	}
	return summary
}

func resourceSummaryFromRunRecord(stateDir string, event Event) (ResourceOutcomeSummary, error) {
	rec, err := readRecordLocked(stateDir, event.RunID)
	if err != nil {
		return ResourceOutcomeSummary{}, err
	}
	return summarizeResourceOutcomes(rec.Resources), nil
}

func marshalEventWithinBudget(event Event) ([]byte, error) {
	writerLimit := MaxJSONLLineBytes - jsonlWriterSafetyMarginBytes
	for {
		data, err := json.Marshal(event)
		if err != nil {
			return nil, err
		}
		lineBytes := len(data) + 1
		if lineBytes <= writerLimit {
			return data, nil
		}
		if event.Type == EventTeardown {
			if dropLastTeardownSample(&event) {
				continue
			}
			return nil, &EventSizeError{EventType: event.Type, Bytes: lineBytes, Limit: writerLimit}
		}
		return nil, fmt.Errorf("proc: serialized %s event is %d bytes; writer limit is %d bytes", event.Type, lineBytes, writerLimit)
	}
}

func appendEvent(dir string, event Event) error {
	file, err := os.OpenFile(filepath.Join(dir, "events.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open event stream: %w", err)
	}
	unlock, err := lockFile(file)
	if err != nil {
		return errors.Join(fmt.Errorf("lock event stream: %w", err), file.Close())
	}
	if event.Type == EventTeardown {
		summary, err := resourceSummaryFromRunRecord(dir, event)
		if err != nil {
			unlockErr := unlock()
			closeErr := file.Close()
			return errors.Join(fmt.Errorf("read teardown resource outcomes for run %q: %w", event.RunID, err), unlockErr, closeErr)
		}
		event.Resources = summary
	}
	event = boundedTeardownEvent(event)
	data, marshalErr := marshalEventWithinBudget(event)
	var writeErr error
	if marshalErr == nil {
		data = append(data, '\n')
		written, err := file.Write(data)
		writeErr = err
		if writeErr == nil && written != len(data) {
			writeErr = io.ErrShortWrite
		}
	}
	unlockErr := unlock()
	closeErr := file.Close()
	return errors.Join(marshalErr, writeErr, unlockErr, closeErr)
}
