//go:build darwin || linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

type claudeResetMode uint8

const (
	claudeResetRelativeOrAbsolute claudeResetMode = iota
	claudeResetWeekdayOrAbsolute
)

type claudeReading struct {
	RecordedAt      time.Time `json:"recordedAt"`
	SessionPercent  float64   `json:"sessionPercent"`
	SessionResetsAt time.Time `json:"sessionResetsAt"`
	WeeklyPercent   float64   `json:"weeklyPercent"`
	WeeklyResetsAt  time.Time `json:"weeklyResetsAt"`
}

type ClaudePace struct {
	RemainingPercent float64 `json:"remainingPercent"`
	HoursLeft        float64 `json:"hoursLeft"`
	RemainingPerDay  float64 `json:"remainingPerDay"`
	Verdict          string  `json:"verdict"`
}

type claudeReadingStore struct {
	dir      string
	now      func() time.Time
	location *time.Location
}

type claudeReadingWriteError struct {
	directory string
	err       error
}

func (e claudeReadingWriteError) Error() string {
	return fmt.Sprintf("save Claude usage reading: %v", e.err)
}
func (e claudeReadingWriteError) Unwrap() error { return e.err }

func newClaudeReadingStore(state string, now func() time.Time, location *time.Location) claudeReadingStore {
	return claudeReadingStore{dir: filepath.Join(state, "limits"), now: now, location: location}
}

func (s claudeReadingStore) path() string { return filepath.Join(s.dir, "claude.recorded.json") }

func (s claudeReadingStore) Record(sessionPercent float64, sessionReset string, weeklyPercent float64, weeklyReset string) error {
	if !validPercent(sessionPercent) || !validPercent(weeklyPercent) {
		return errors.New("Claude usage percentages must be between 0 and 100")
	}
	if s.now == nil || s.location == nil {
		return errors.New("Claude reading store requires a clock and local time zone")
	}
	now := s.now().In(s.location)
	sessionResetsAt, err := parseClaudeReset(sessionReset, claudeResetRelativeOrAbsolute, now, s.location)
	if err != nil {
		return fmt.Errorf("invalid --session-resets: %w", err)
	}
	weeklyResetsAt, err := parseClaudeReset(weeklyReset, claudeResetWeekdayOrAbsolute, now, s.location)
	if err != nil {
		return fmt.Errorf("invalid --weekly-resets: %w", err)
	}
	reading := claudeReading{
		RecordedAt:      now.UTC(),
		SessionPercent:  sessionPercent,
		SessionResetsAt: sessionResetsAt.UTC(),
		WeeklyPercent:   weeklyPercent,
		WeeklyResetsAt:  weeklyResetsAt.UTC(),
	}
	data, err := json.MarshalIndent(reading, "", "  ")
	if err != nil {
		return fmt.Errorf("encode Claude usage reading: %w", err)
	}
	if err := writeAtomicFile(s.path(), data); err != nil {
		return claudeReadingWriteError{directory: s.dir, err: err}
	}
	return nil
}

func (s claudeReadingStore) Limits() ([]VendorLimit, ClaudePace, error) {
	if s.now == nil || s.location == nil {
		return nil, ClaudePace{}, errors.New("Claude reading store requires a clock and local time zone")
	}
	data, err := os.ReadFile(s.path())
	if err != nil {
		return nil, ClaudePace{}, err
	}
	var reading claudeReading
	if err := json.Unmarshal(data, &reading); err != nil {
		return nil, ClaudePace{}, fmt.Errorf("decode Claude usage reading: %w", err)
	}
	if reading.RecordedAt.IsZero() || reading.SessionResetsAt.IsZero() || reading.WeeklyResetsAt.IsZero() || !validPercent(reading.SessionPercent) || !validPercent(reading.WeeklyPercent) {
		return nil, ClaudePace{}, errors.New("stored Claude usage reading is incomplete")
	}
	now := s.now().UTC()
	recordedAt := reading.RecordedAt.UTC()
	age := now.Sub(recordedAt)
	if age < 0 {
		age = 0
	}
	ageText := age.Round(time.Second).String()
	limits := []VendorLimit{
		{
			Vendor: "claude", Window: "session", UsedPercent: reading.SessionPercent,
			ResetsAt: timePointer(reading.SessionResetsAt.UTC()), Confidence: "recorded", Source: "recorded",
			FetchedAt: recordedAt, RecordedAt: timePointer(recordedAt), Age: ageText,
			Stale: !now.Before(reading.SessionResetsAt.UTC()),
		},
		{
			Vendor: "claude", Window: "week", UsedPercent: reading.WeeklyPercent,
			ResetsAt: timePointer(reading.WeeklyResetsAt.UTC()), Confidence: "recorded", Source: "recorded",
			FetchedAt: recordedAt, RecordedAt: timePointer(recordedAt), Age: ageText,
			Stale: !now.Before(reading.WeeklyResetsAt.UTC()),
		},
	}
	pace := claudeWeeklyPace(limits[1], now)
	limits[1].Pace = &pace
	return limits, pace, nil
}

func validPercent(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 100
}

func timePointer(value time.Time) *time.Time { return &value }

type vendorLimitEvent struct {
	Kind       string    `json:"kind"`
	Vendor     string    `json:"vendor"`
	ResetAt    time.Time `json:"resetAt"`
	RecordedAt time.Time `json:"recordedAt"`
	Message    string    `json:"message"`
}

type vendorLimitStateStore struct {
	state string
	now   func() time.Time
}

func newVendorLimitStateStore(state string, now func() time.Time) vendorLimitStateStore {
	return vendorLimitStateStore{state: state, now: now}
}

func (s vendorLimitStateStore) scheduler() *schedulerStore { return newSchedulerStore(s.state) }

func (s vendorLimitStateStore) eventsPath() string {
	return filepath.Join(s.scheduler().dir, "events.jsonl")
}

func (s vendorLimitStateStore) withLock(action func() error) error {
	return s.scheduler().withLock(action)
}

func (s vendorLimitStateStore) readLatestLocked(vendor string) (vendorLimitEvent, bool, error) {
	file, err := os.Open(s.eventsPath())
	if errors.Is(err, os.ErrNotExist) {
		return vendorLimitEvent{}, false, nil
	}
	if err != nil {
		return vendorLimitEvent{}, false, fmt.Errorf("open vendor limit events: %w", err)
	}
	defer file.Close()
	var latest vendorLimitEvent
	found := false
	readErr := proc.ReadJSONL(file, func(line []byte) error {
		var event vendorLimitEvent
		if err := json.Unmarshal(line, &event); err != nil {
			return fmt.Errorf("decode vendor limit event: %w", err)
		}
		if event.Kind != "vendor_limit.recorded" || event.Vendor != vendor {
			return nil
		}
		if event.ResetAt.IsZero() || event.RecordedAt.IsZero() {
			return errors.New("vendor limit event has no reset or recorded time")
		}
		if !found || event.ResetAt.After(latest.ResetAt) {
			latest, found = event, true
		}
		return nil
	})
	if readErr != nil {
		return vendorLimitEvent{}, false, fmt.Errorf("read vendor limit events: %w", readErr)
	}
	return latest, found, nil
}

func (s vendorLimitStateStore) Record(vendor string, resetAt time.Time, message string) (bool, error) {
	if vendor == "" || resetAt.IsZero() || s.now == nil {
		return false, errors.New("vendor limit record requires a vendor, reset time, and clock")
	}
	changed := false
	err := s.withLock(func() error {
		previous, found, err := s.readLatestLocked(vendor)
		if err != nil {
			return err
		}
		if found && !resetAt.After(previous.ResetAt) {
			return nil
		}
		event := vendorLimitEvent{Kind: "vendor_limit.recorded", Vendor: vendor, ResetAt: resetAt.UTC(), RecordedAt: s.now().UTC(), Message: message}
		if err := s.scheduler().appendEvent(event); err != nil {
			return fmt.Errorf("persist vendor limit event: %w", err)
		}
		changed = true
		return nil
	})
	return changed, err
}

func (s vendorLimitStateStore) Active(vendor string) (VendorLimit, bool, error) {
	if vendor == "" || s.now == nil {
		return VendorLimit{}, false, errors.New("active vendor limit lookup requires a vendor and clock")
	}
	var latest vendorLimitEvent
	var found bool
	err := s.withLock(func() error {
		var err error
		latest, found, err = s.readLatestLocked(vendor)
		return err
	})
	if err != nil || !found || !s.now().Before(latest.ResetAt) {
		return VendorLimit{}, false, err
	}
	reset := latest.ResetAt
	return VendorLimit{
		Vendor: vendor, Window: "usage", UsedPercent: 100, Blocked: true, ResetsAt: &reset,
		Confidence: "vendor", Source: "failure-message", FetchedAt: latest.RecordedAt,
	}, true, nil
}

func limitsWithRecordedVendorState(limits []VendorLimit, store vendorLimitStateStore, vendor string) ([]VendorLimit, error) {
	merged := make([]VendorLimit, 0, len(limits)+1)
	for _, limit := range limits {
		if limit.Vendor == vendor && limit.Source == "failure-message" {
			continue
		}
		merged = append(merged, limit)
	}
	recorded, active, err := store.Active(vendor)
	if err != nil {
		return nil, err
	}
	if active {
		merged = append(merged, recorded)
	}
	return merged, nil
}

func parseClaudeReset(value string, mode claudeResetMode, now time.Time, location *time.Location) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" || location == nil {
		return time.Time{}, errors.New("value and local time zone are required")
	}
	if duration, err := parseClaudeDuration(value); err == nil {
		if mode != claudeResetRelativeOrAbsolute {
			return time.Time{}, errors.New("weekly reset must be an absolute date or weekday and time")
		}
		return now.In(location).Add(duration).UTC(), nil
	}
	if absolute, ok := parseClaudeAbsoluteTime(value, location); ok {
		return absolute.UTC(), nil
	}
	if mode == claudeResetWeekdayOrAbsolute {
		if weekday, clock, ok := parseClaudeWeekdayTime(value, location); ok {
			now = now.In(location)
			dayOffset := (int(weekday) - int(now.Weekday()) + 7) % 7
			candidate := time.Date(now.Year(), now.Month(), now.Day()+dayOffset, clock.Hour(), clock.Minute(), 0, 0, location)
			if !candidate.After(now) {
				candidate = candidate.AddDate(0, 0, 7)
			}
			return candidate.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("%q must be a supported local reset time", value)
}

func parseClaudeAbsoluteTime(value string, location *time.Location) (time.Time, bool) {
	for _, layout := range []string{
		time.RFC3339,
		"2006-01-02 15:04",
		"2006-01-02 3:04 PM",
		"2006-01-02T15:04",
		"2006-01-02T15:04:05",
	} {
		parsed, err := time.ParseInLocation(layout, value, location)
		if err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func parseClaudeWeekdayTime(value string, location *time.Location) (time.Weekday, time.Time, bool) {
	fields := strings.Fields(value)
	if len(fields) < 2 || len(fields) > 3 {
		return 0, time.Time{}, false
	}
	weekdays := map[string]time.Weekday{
		"mon": time.Monday, "tue": time.Tuesday, "wed": time.Wednesday,
		"thu": time.Thursday, "fri": time.Friday, "sat": time.Saturday, "sun": time.Sunday,
	}
	weekday, ok := weekdays[strings.ToLower(fields[0])]
	if !ok {
		return 0, time.Time{}, false
	}
	clockValue := strings.Join(fields[1:], " ")
	for _, layout := range []string{"15:04", "3:04 PM", "3 PM"} {
		parsed, err := time.ParseInLocation(layout, clockValue, location)
		if err == nil {
			return weekday, parsed, true
		}
	}
	return 0, time.Time{}, false
}

func parseClaudeDuration(value string) (time.Duration, error) {
	units := map[string]time.Duration{
		"h": time.Hour, "hr": time.Hour, "hrs": time.Hour, "hour": time.Hour, "hours": time.Hour,
		"m": time.Minute, "min": time.Minute, "mins": time.Minute, "minute": time.Minute, "minutes": time.Minute,
		"s": time.Second, "sec": time.Second, "secs": time.Second, "second": time.Second, "seconds": time.Second,
		"d": 24 * time.Hour, "day": 24 * time.Hour, "days": 24 * time.Hour,
	}
	var total time.Duration
	consumed := false
	for index := 0; index < len(value); {
		for index < len(value) && (value[index] == ' ' || value[index] == '\t') {
			index++
		}
		if index == len(value) {
			break
		}
		numberStart := index
		for index < len(value) && (value[index] >= '0' && value[index] <= '9' || value[index] == '.') {
			index++
		}
		if numberStart == index {
			return 0, errors.New("duration must contain a number and unit")
		}
		amount, err := strconv.ParseFloat(value[numberStart:index], 64)
		if err != nil || amount < 0 || math.IsInf(amount, 0) || math.IsNaN(amount) {
			return 0, errors.New("duration contains an invalid amount")
		}
		for index < len(value) && (value[index] == ' ' || value[index] == '\t') {
			index++
		}
		unitStart := index
		for index < len(value) && ((value[index] >= 'a' && value[index] <= 'z') || (value[index] >= 'A' && value[index] <= 'Z')) {
			index++
		}
		if unitStart == index {
			return 0, errors.New("duration is missing a unit")
		}
		unitDuration, ok := units[strings.ToLower(value[unitStart:index])]
		if !ok {
			return 0, errors.New("duration contains an unsupported unit")
		}
		total += time.Duration(amount * float64(unitDuration))
		consumed = true
	}
	if !consumed {
		return 0, errors.New("duration is empty")
	}
	return total, nil
}

func claudeWeeklyPace(weekly VendorLimit, now time.Time) ClaudePace {
	pace := ClaudePace{RemainingPercent: 100 - weekly.UsedPercent}
	if weekly.ResetsAt == nil {
		return pace
	}
	pace.HoursLeft = weekly.ResetsAt.Sub(now).Hours()
	if pace.HoursLeft <= 0 {
		pace.Verdict = "stale"
		return pace
	}
	pace.RemainingPerDay = pace.RemainingPercent / pace.HoursLeft * 24
	expectedRemaining := pace.HoursLeft / (7 * 24) * 100
	switch {
	case pace.RemainingPercent > expectedRemaining+0.5:
		pace.Verdict = "under"
	case pace.RemainingPercent < expectedRemaining-0.5:
		pace.Verdict = "over"
	default:
		pace.Verdict = "on"
	}
	return pace
}

func formatClaudePace(pace ClaudePace) string {
	if pace.Verdict == "stale" {
		return "pace claude stale"
	}
	return fmt.Sprintf("pace claude %.0f%% remaining / %.0fh → %.1f%%/day %s", pace.RemainingPercent, pace.HoursLeft, pace.RemainingPerDay, pace.Verdict)
}
