// Package stream renders shared JSONL command streams.
package stream

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
)

// Writer emits contract records followed by exactly one terminal record.
type Writer struct {
	output     io.Writer
	finished   bool
	result     bool
	exitStatus diag.ExitStatus
	failure    *diag.Diag
}

// New creates a JSONL writer for one command invocation.
func New(output io.Writer) *Writer {
	return &Writer{output: output, exitStatus: diag.SuccessStatus()}
}

// ExitStatus returns the typed terminal status selected for this stream.
func (w *Writer) ExitStatus() diag.ExitStatus { return w.exitStatus }

// Event writes one successful event record.
func (w *Writer) Event(data any) error {
	if w.finished {
		return fmt.Errorf("cannot write an event after the stream terminal record")
	}
	if w.result {
		return fmt.Errorf("cannot write an event after the stream result record")
	}
	return json.NewEncoder(w.output).Encode(map[string]any{"ok": true, "data": data})
}

// Result writes the successful command result as a stream record.
func (w *Writer) Result(data any) error {
	if w.finished {
		return fmt.Errorf("cannot write a result after the stream terminal record")
	}
	if w.result {
		return fmt.Errorf("stream already has a result record")
	}
	record := map[string]any{
		"ok":   true,
		"data": data,
		"meta": map[string]any{"stream": map[string]any{"result": true}},
	}
	if err := json.NewEncoder(w.output).Encode(record); err != nil {
		return err
	}
	w.result = true
	return nil
}

// Fail writes one typed error record.
func (w *Writer) Fail(d *diag.Diag) error {
	if w.finished {
		return fmt.Errorf("cannot write an error after the stream terminal record")
	}
	if w.result {
		return fmt.Errorf("cannot write an error after the stream result record")
	}
	d = diag.FromError(d)
	w.failure = d
	w.exitStatus = diag.ExitCode(d)
	return nil
}

// Finish writes the terminal envelope and closes the stream.
func (w *Writer) Finish(status diag.ExitStatus) error {
	if w.finished {
		return fmt.Errorf("stream already has a terminal record")
	}
	if !status.IsSelected() {
		return fmt.Errorf("terminal status was not explicitly selected")
	}
	if status != w.exitStatus {
		return fmt.Errorf("terminal status does not match the stream diagnostic")
	}
	record := map[string]any{
		"ok":   true,
		"data": nil,
		"meta": map[string]any{"stream": map[string]any{"terminal": true, "exitCode": status.Code()}},
	}
	if w.failure != nil {
		record = result.FailureEnvelope(w.failure)
		delete(record, "data")
		record["meta"] = map[string]any{"stream": map[string]any{"terminal": true, "exitCode": status.Code()}}
	}
	if err := json.NewEncoder(w.output).Encode(record); err != nil {
		return err
	}
	w.exitStatus = status
	w.finished = true
	return nil
}
