package stream

import (
	"bufio"
	"bytes"
	"encoding/json"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
)

func TestFinishUsesCataloguedFailureStatus(t *testing.T) {
	var output bytes.Buffer
	writer := New(&output)
	if !writer.ExitStatus().IsSelected() || writer.ExitStatus().Code() != 0 {
		t.Fatalf("new stream writer status = %#v, want explicitly selected success", writer.ExitStatus())
	}
	failure := diag.New("KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE", "index unavailable")
	if err := writer.Fail(failure); err != nil {
		t.Fatal(err)
	}
	if err := writer.Finish(writer.ExitStatus()); err != nil {
		t.Fatal(err)
	}
	if writer.ExitStatus() != diag.ExitCode(diag.New("KB_RUNTIME_UNEXPECTED", "failed")) {
		t.Fatalf("stream exit = %d, want catalogued status %d", writer.ExitStatus().Code(), diag.ExitCode(diag.New("KB_RUNTIME_UNEXPECTED", "failed")).Code())
	}
}

func TestFinishRejectsUnselectedStatus(t *testing.T) {
	var output bytes.Buffer
	writer := New(&output)
	if err := writer.Finish(diag.ExitStatus{}); err == nil {
		t.Fatal("Finish accepted an unselected zero-value status")
	}
	if output.Len() != 0 {
		t.Fatalf("Finish wrote a terminal record for an unselected status: %s", output.String())
	}
}

// case: S-203.7
func TestStreamWritesEnvelopeEventsAndTerminalRecord(t *testing.T) {
	var output bytes.Buffer
	writer := New(&output)
	if err := writer.Event(map[string]any{"event": "alive"}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Fail(diag.New("KB_RUNTIME_UNEXPECTED", "The operation failed.",
		diag.WithCorrelationID("stream-correlation"))); err != nil {
		t.Fatal(err)
	}
	if err := writer.Finish(writer.ExitStatus()); err != nil {
		t.Fatal(err)
	}

	encoded := append([]byte(nil), output.Bytes()...)
	scanner := bufio.NewScanner(bytes.NewReader(encoded))
	var records []map[string]json.RawMessage
	for scanner.Scan() {
		var record map[string]json.RawMessage
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatalf("invalid JSONL record %q: %v", scanner.Text(), err)
		}
		if err := result.ValidateMachineResult(scanner.Bytes()); err != nil {
			t.Fatalf("record doesn't use machine envelope: %v", err)
		}
		records = append(records, record)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 {
		t.Fatalf("got %d records, want event and terminal failure", len(records))
	}
	if records[0]["data"] == nil || records[0]["ok"] == nil {
		t.Fatalf("event record = %v", records[0])
	}
	lines := bytes.Split(bytes.TrimSpace(encoded), []byte("\n"))
	var failure struct {
		Error struct {
			Code          string `json:"code"`
			CorrelationID string `json:"correlationId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(lines[1], &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Error.Code != "KB_RUNTIME_UNEXPECTED" || failure.Error.CorrelationID != "stream-correlation" {
		t.Fatalf("failure record = %+v", failure)
	}
	var terminal struct {
		OK   bool `json:"ok"`
		Meta struct {
			Stream struct {
				Terminal bool `json:"terminal"`
				ExitCode int  `json:"exitCode"`
			} `json:"stream"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(lines[1], &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.OK {
		t.Fatalf("failed terminal reports success: %s", lines[1])
	}
	if !terminal.Meta.Stream.Terminal || terminal.Meta.Stream.ExitCode != diag.ExitCode(diag.New("KB_RUNTIME_UNEXPECTED", "failed")).Code() {
		t.Fatalf("terminal record = %+v", terminal)
	}
}

func TestStreamResultEventHasResultMetadataAndTerminalRecord(t *testing.T) {
	var output bytes.Buffer
	writer := New(&output)
	if err := writer.Event(map[string]any{"phase": "Apply"}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Result(map[string]any{"operation": "apply"}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Finish(writer.ExitStatus()); err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte("\n"))
	if len(lines) != 3 {
		t.Fatalf("got %d records, want event, result, and terminal", len(lines))
	}
	var resultRecord struct {
		Data struct {
			Operation string `json:"operation"`
		} `json:"data"`
		Meta struct {
			Stream struct {
				Result bool `json:"result"`
			} `json:"stream"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(lines[1], &resultRecord); err != nil {
		t.Fatal(err)
	}
	if resultRecord.Data.Operation != "apply" || !resultRecord.Meta.Stream.Result {
		t.Fatalf("result record = %+v", resultRecord)
	}
}

func TestResultRecordMayBeWrittenOnlyOnce(t *testing.T) {
	writer := New(&bytes.Buffer{})
	if err := writer.Result(map[string]string{"operation": "apply"}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Result(map[string]string{"operation": "apply"}); err == nil {
		t.Fatal("second result record succeeded")
	}
}

func TestFailureTerminalMetadataMustDescribeNonzeroExit(t *testing.T) {
	var out bytes.Buffer
	writer := New(&out)
	if err := writer.Fail(diag.New("KB_RUNTIME_UNEXPECTED", "failed")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Finish(writer.ExitStatus()); err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n"))
	var terminal map[string]any
	if err := json.Unmarshal(lines[0], &terminal); err != nil {
		t.Fatal(err)
	}
	terminal["meta"] = map[string]any{"stream": map[string]any{"terminal": true, "exitCode": 0}}
	mutated, err := json.Marshal(terminal)
	if err != nil {
		t.Fatal(err)
	}
	if err := result.ValidateMachineResult(mutated); err == nil {
		t.Fatalf("failure terminal with zero exit was accepted: %s", mutated)
	}
}

func TestFailedStreamEmitsOneErrorEnvelope(t *testing.T) {
	var out bytes.Buffer
	w := New(&out)
	if err := w.Fail(diag.New("KB_RUNTIME_UNEXPECTED", "failed")); err != nil {
		t.Fatal(err)
	}
	if err := w.Finish(w.ExitStatus()); err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n"))
	if len(lines) != 1 {
		t.Fatalf("expected one terminal error, got %d: %s", len(lines), out.String())
	}
	if err := result.ValidateMachineResult(lines[0]); err != nil {
		t.Fatal(err)
	}
}
