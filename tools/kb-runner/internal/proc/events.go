//go:build darwin || linux

package proc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const MaxJSONLLineBytes = 16 * 1024
const jsonlWriterSafetyMarginBytes = 1024

type JSONLLineErrorKind string

const (
	JSONLLineTooLong JSONLLineErrorKind = "line-too-long"
	JSONLLineInvalid JSONLLineErrorKind = "invalid-json"
)

type JSONLLineError struct {
	Line int
	Kind JSONLLineErrorKind
	Err  error
}

// OlderEventFormatError identifies an event shape written by an older runner.
type OlderEventFormatError struct {
	Type  EventType
	Field string
}

func (e *OlderEventFormatError) Error() string {
	return fmt.Sprintf("event %q field %q was written by an older kb-runner format", e.Type, e.Field)
}

func (e *JSONLLineError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("proc: JSONL line %d %s: %v", e.Line, e.Kind, e.Err)
	}
	return fmt.Sprintf("proc: JSONL line %d %s", e.Line, e.Kind)
}

func (e *JSONLLineError) Unwrap() error { return e.Err }

// JSONLDecoder bounds buffered partial records and validates each complete line.
// Feed is safe for append-only streams whose records may cross read boundaries.
type JSONLDecoder struct {
	pending []byte
	line    int
}

func (d *JSONLDecoder) Feed(chunk []byte, consume func([]byte) error) error {
	data := append(d.pending, chunk...)
	d.pending = nil
	for {
		lineEnd := bytes.IndexByte(data, '\n')
		if lineEnd < 0 {
			if len(data) > MaxJSONLLineBytes {
				return &JSONLLineError{Line: d.line + 1, Kind: JSONLLineTooLong}
			}
			d.pending = append(d.pending[:0], data...)
			return nil
		}
		if lineEnd > MaxJSONLLineBytes {
			return &JSONLLineError{Line: d.line + 1, Kind: JSONLLineTooLong}
		}
		line := data[:lineEnd]
		d.line++
		if !json.Valid(line) {
			return &JSONLLineError{Line: d.line, Kind: JSONLLineInvalid, Err: errors.New("record is not valid JSON")}
		}
		if err := consume(line); err != nil {
			var lineErr *JSONLLineError
			if errors.As(err, &lineErr) {
				return err
			}
			return &JSONLLineError{Line: d.line, Kind: JSONLLineInvalid, Err: err}
		}
		data = data[lineEnd+1:]
	}
}

func (d *JSONLDecoder) Finish() error {
	if len(d.pending) != 0 {
		return &JSONLLineError{Line: d.line + 1, Kind: JSONLLineInvalid, Err: errors.New("event stream ends with an incomplete JSONL record")}
	}
	return nil
}

// ReadJSONL validates a JSONL stream and passes each bounded JSON record to consume.
func ReadJSONL(reader io.Reader, consume func([]byte) error) error {
	decoder := JSONLDecoder{}
	buffer := make([]byte, 4096)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			if feedErr := decoder.Feed(buffer[:n], consume); feedErr != nil {
				return feedErr
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				return err
			}
			return decoder.Finish()
		}
		if n == 0 {
			return io.ErrNoProgress
		}
	}
}

// ReadEvents decodes bounded lifecycle records from the shared event stream.
func ReadEvents(reader io.Reader, consume func(Event) error) error {
	return ReadJSONL(reader, func(line []byte) error {
		var event Event
		if err := json.Unmarshal(line, &event); err != nil {
			var raw map[string]json.RawMessage
			if json.Unmarshal(line, &raw) == nil {
				var kind EventType
				if err := json.Unmarshal(raw["type"], &kind); err != nil {
					return err
				}
				if kind == "" {
					return errors.New("event record has no kind")
				}
				var resources []json.RawMessage
				if json.Unmarshal(raw["resources"], &resources) == nil && resources != nil {
					return &OlderEventFormatError{Type: kind, Field: "resources"}
				}
			}
			return err
		}
		return consume(event)
	})
}

func validateEventStream(stateDir string) error {
	path := filepath.Join(stateDir, "events.jsonl")
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open event stream: %w", err)
	}
	readErr := ReadEvents(file, func(Event) error { return nil })
	var lineErr *JSONLLineError
	var oldFormat *OlderEventFormatError
	if errors.As(readErr, &lineErr) && errors.As(lineErr, &oldFormat) {
		readErr = fmt.Errorf("%s line %d record kind %q: %w", path, lineErr.Line, oldFormat.Type, oldFormat)
	}
	return errors.Join(readErr, file.Close())
}

func ParseEventFilter(value string) ([]EventType, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	allowed := map[EventType]bool{
		EventQueued: true, EventBlocked: true, EventIdle: true, EventStart: true,
		EventStall: true, EventExit: true, EventLost: true, EventTeardown: true,
		EventPressure: true, EventOverBudget: true, EventUngatedHeavy: true,
	}
	parts := strings.Split(value, ",")
	filters := make([]EventType, 0, len(parts))
	seen := make(map[EventType]bool, len(parts))
	for _, part := range parts {
		kind := EventType(strings.TrimSpace(part))
		if !allowed[kind] {
			return nil, fmt.Errorf("unknown event type %q", part)
		}
		if !seen[kind] {
			seen[kind] = true
			filters = append(filters, kind)
		}
	}
	return filters, nil
}

// Events streams existing JSONL records and, when follow is true, later appends.
func Events(ctx context.Context, stateDir string, follow bool, filter []EventType, startOffset int64, output io.Writer) error {
	if startOffset < 0 {
		return errors.New("proc: event offset must not be negative")
	}
	info, err := os.Stat(stateDir)
	if err != nil {
		return fmt.Errorf("proc: inspect state directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("proc: state path %q is not a directory", stateDir)
	}
	path := filepath.Join(stateDir, "events.jsonl")
	offset := startOffset
	decoder := JSONLDecoder{}
	allowed := make(map[EventType]bool, len(filter))
	for _, kind := range filter {
		allowed[kind] = true
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		file, err := os.Open(path)
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("proc: open events: %w", err)
		}
		if err == nil {
			info, statErr := file.Stat()
			if statErr != nil {
				return errors.Join(fmt.Errorf("proc: stat events: %w", statErr), file.Close())
			}
			remaining := info.Size() - offset
			if remaining < 0 {
				return errors.Join(errors.New("proc: append-only event file shrank while being followed"), file.Close())
			}
			var readErr error
			for remaining > 0 {
				chunkSize := min(remaining, int64(64*1024))
				chunk := make([]byte, int(chunkSize))
				n, chunkErr := file.ReadAt(chunk, offset)
				if chunkErr != nil && !errors.Is(chunkErr, io.EOF) {
					readErr = chunkErr
					break
				}
				offset += int64(n)
				remaining -= int64(n)
				if err := decoder.Feed(chunk[:n], func(line []byte) error {
					var event Event
					if err := json.Unmarshal(line, &event); err != nil {
						return &JSONLLineError{Line: decoder.line, Kind: JSONLLineInvalid, Err: err}
					}
					if len(allowed) == 0 || allowed[event.Type] {
						if _, err := output.Write(append(append([]byte(nil), line...), '\n')); err != nil {
							return err
						}
					}
					return nil
				}); err != nil {
					_ = file.Close()
					var lineErr *JSONLLineError
					var oldFormat *OlderEventFormatError
					if errors.As(err, &lineErr) && errors.As(lineErr, &oldFormat) {
						return fmt.Errorf("%s line %d record kind %q: %w", path, lineErr.Line, oldFormat.Type, oldFormat)
					}
					return err
				}
				if n == 0 {
					break
				}
			}
			closeErr := file.Close()
			if readErr != nil {
				return errors.Join(fmt.Errorf("proc: read events: %w", readErr), closeErr)
			}
			if closeErr != nil {
				return fmt.Errorf("proc: close events: %w", closeErr)
			}
		}
		if !follow {
			return decoder.Finish()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
