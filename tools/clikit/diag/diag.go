// Package diag is the structured-diagnostic core shared by the KB Labs Go
// launcher tools. It mirrors the platform's TypeScript error contract
// (core/config/src/errors/kb-error.ts: KbError {code, message, hint, meta})
// and adds an explicit Reason, so every failure can say WHAT happened
// (Message), WHY (Reason) and WHAT TO DO / WHERE TO LOOK (Hint).
//
// A *Diag satisfies the error interface, so it flows through cobra RunE and
// any error path unchanged; the top-level handler renders it per output mode.
package diag

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"regexp"
	"runtime/debug"
	"sort"
	"strings"
	"time"
)

var (
	secretAssignment = regexp.MustCompile(`(?i)(\b[A-Z0-9_]*(PASSWORD|TOKEN|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*=\s*)[^\s]+`)
	secretJSONField  = regexp.MustCompile(`(?i)(["']?(password|token|secret|apiKey|key)["']?\s*:\s*)("[^"\\]*(\\.[^"\\]*)*"|'[^']*'|[^,}\]\s]+)`)
	urlCredentials   = regexp.MustCompile(`(?i)(https?://)[^/@\s:]+:[^/@\s]+@`)
)

// RedactText removes common credential forms before diagnostic text reaches
// human or machine output. Secret values supplied by a runtime are handled by
// that runtime's value-aware log/dossier redactor.
func RedactText(value string) string {
	value = secretAssignment.ReplaceAllString(value, `${1}"[REDACTED]"`)
	value = secretJSONField.ReplaceAllString(value, `${1}"[REDACTED]"`)
	return urlCredentials.ReplaceAllString(value, `${1}[REDACTED]@`)
}

// Diag is a structured diagnostic. The zero value is not useful — construct
// with New or Wrap.
type Diag struct {
	// Binary is the registered root command name used to render binary-scoped
	// catalog templates. It is invocation context, not wire data.
	Binary string `json:"-"`
	// Code is a stable KB_* platform error identifier.
	Code string `json:"code"`
	// Message is the human-readable WHAT (one line, no trailing punctuation).
	Message string `json:"message"`
	// Reason is the WHY — the underlying cause, in plain language.
	Reason string `json:"reason,omitempty"`
	// Hint is the WHAT-TO-DO / WHERE-TO-LOOK from the platform error catalog.
	Hint string `json:"hint,omitempty"`
	// Cause is safe explanatory text for machine output. It is not printed by
	// the human renderer; wrapped Go errors remain available only via Unwrap.
	Cause string `json:"-"`
	// Meta carries structured context (paths, hosts, per-action failures, …).
	Meta          map[string]any `json:"meta,omitempty"`
	Data          any            `json:"-"`
	Actions       []Action       `json:"-"`
	Docs          string         `json:"-"`
	CorrelationID string         `json:"correlationId,omitempty"`

	// cause is the wrapped error; surfaced via Unwrap, never serialized.
	cause error
}

// Error satisfies the error interface using Message.
func (d *Diag) Error() string {
	if d == nil {
		return ""
	}
	return d.Message
}

// Unwrap exposes the wrapped cause for errors.Is/As.
func (d *Diag) Unwrap() error {
	if d == nil {
		return nil
	}
	return d.cause
}

// Opt mutates a Diag during construction.
type Opt func(*Diag)

// WithReason sets the WHY.
func WithReason(reason string) Opt { return func(d *Diag) { d.Reason = RedactText(reason) } }

// WithHint preserves a command-specific next step while retaining the
// catalog's remaining canonical envelope fields.
func WithHint(hint string) Opt { return func(d *Diag) { d.Hint = hint } }

// WithCause sets a safe cause for the canonical machine error envelope.
func WithCause(cause string) Opt { return func(d *Diag) { d.Cause = RedactText(cause) } }

// WithCauseAndReason sanitizes one failure string for machine and human output.
func WithCauseAndReason(cause string) Opt {
	return func(d *Diag) {
		safe := RedactText(cause)
		d.Cause = safe
		d.Reason = safe
	}
}

// WithMeta merges structured context into Meta.
func WithMeta(meta map[string]any) Opt {
	return func(d *Diag) {
		if d.Meta == nil {
			d.Meta = make(map[string]any, len(meta))
		}
		for k, v := range meta {
			d.Meta[k] = v
		}
	}
}

// WithData attaches structured command result data to a failed diagnostic
// envelope without flattening it into string-only diagnostic details.
func WithData(data any) Opt { return func(d *Diag) { d.Data = data } }

// WithCorrelationID attaches the ID that joins a safe result to its log entry.
func WithCorrelationID(id string) Opt { return func(d *Diag) { d.CorrelationID = id } }

// WithBinary supplies the registered CLI root name to catalog templates.
func WithBinary(binary string) Opt { return func(d *Diag) { d.Binary = binary } }

// New builds a Diag and uses the platform catalog hint for a known code.
func New(code, message string, opts ...Opt) *Diag {
	d := &Diag{Code: code, Message: message}
	if entry, ok := LookupCatalog(code); ok {
		d.Hint = entry.Hint
	}
	for _, o := range opts {
		o(d)
	}
	return d
}

// FromCatalog reconstructs canonical diagnostic text from structured catalog
// values. Required template values and catalog-declared structured details are
// retained; callers may add locally observed metadata through opts.
func FromCatalog(code string, values map[string]string, opts ...Opt) (*Diag, error) {
	entry, ok := LookupCatalog(code)
	if !ok {
		return nil, fmt.Errorf("error envelope code %q is absent from the platform catalog", code)
	}
	violations := make(map[string]struct{})
	valueFields := make([]string, 0, len(values))
	for key := range values {
		valueFields = append(valueFields, key)
	}
	for _, key := range UndeclaredDetailFields(code, valueFields) {
		violations[key] = struct{}{}
	}
	for _, name := range entry.RequiredTemplateParameters {
		value, exists := values[name]
		if !exists || strings.TrimSpace(value) == "" {
			violations[name] = struct{}{}
		}
	}
	if len(violations) > 0 {
		fields := make([]string, 0, len(violations))
		for field := range violations {
			fields = append(fields, field)
		}
		sort.Strings(fields)
		return nil, NewContractViolation(code, strings.Join(fields, ", "))
	}
	meta := make(map[string]any, len(values))
	for key, value := range values {
		if len(UndeclaredDetailFields(code, []string{key})) == 0 {
			meta[key] = value
		}
	}
	d := New(entry.Code, entry.Message, WithMeta(meta))
	for _, option := range opts {
		option(d)
	}
	envelope, err := ToEnvelope(d)
	if err != nil {
		return nil, err
	}
	d.Message = envelope.Message
	d.Hint = envelope.Hint
	return d, nil
}

// Wrap builds a Diag wrapping an underlying error (preserved for Unwrap).
func Wrap(err error, code, message string, opts ...Opt) *Diag {
	d := New(code, message, opts...)
	d.cause = err
	return d
}

// FromError converts an untyped failure at a CLI boundary into a safe
// platform error and writes its stack only to the structured log.
func FromError(err error) *Diag {
	return FromErrorWithLogger(err, slog.New(slog.NewJSONHandler(os.Stderr, nil)))
}

// FromErrorWithLogger normalizes an untyped boundary failure and sends its
// raw error and stack to the supplied structured logger only.
func FromErrorWithLogger(err error, logger *slog.Logger) *Diag {
	if err == nil {
		return nil
	}
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(os.Stderr, nil))
	}
	var typed *Diag
	if errors.As(err, &typed) && typed != nil {
		entry, known := LookupCatalog(typed.Code)
		if !known {
			correlationID := NewCorrelationID()
			logger.Error("CLI command failed unexpectedly",
				"correlationId", correlationID, "error", typed.Error(), "stack", string(debug.Stack()))
			return New("KB_RUNTIME_UNEXPECTED", "An unexpected error occurred.", WithCorrelationID(correlationID))
		}
		normalized := *typed
		if normalized.Hint == "" {
			normalized.Hint = entry.Hint
		}
		if normalized.CorrelationID == "" {
			normalized.CorrelationID = NewCorrelationID()
		}
		return &normalized
	}
	correlationID := NewCorrelationID()
	logger.Error("CLI command failed unexpectedly",
		"correlationId", correlationID, "error", err.Error(), "stack", string(debug.Stack()))
	return New("KB_RUNTIME_UNEXPECTED", "An unexpected error occurred.", WithCorrelationID(correlationID))
}

// MarshalJSON serializes diagnostics through the canonical platform envelope.
func (d *Diag) MarshalJSON() ([]byte, error) {
	envelope, err := ToEnvelope(d)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope)
}

// UnmarshalJSON accepts only the canonical platform error envelope.
func (d *Diag) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, field := range []string{"code", "area", "stage", "severity", "retryable", "message", "hint"} {
		if _, exists := fields[field]; !exists {
			return fmt.Errorf("canonical error envelope is missing required field %q", field)
		}
	}
	var envelope Envelope
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("decode canonical error envelope trailing data: %v", err)
	}
	entry, ok := LookupCatalog(envelope.Code)
	if !ok {
		*d = *ProtocolFailure(envelope.Code, "code")
		return nil
	}
	if envelope.Area != entry.Area || envelope.Stage != entry.Stage || envelope.Severity != entry.Severity || envelope.Retryable != entry.Retryable {
		*d = *ProtocolFailure(envelope.Code, "metadata")
		return nil
	}
	if envelope.Message == "" || envelope.Hint == "" {
		return fmt.Errorf("error envelope message and hint are required")
	}
	templateValues := make(map[string]string, len(envelope.Details))
	structuredDetails := make(map[string]any)
	for key, value := range envelope.Details {
		if text, ok := value.(string); ok {
			templateValues[key] = text
		} else {
			structuredDetails[key] = value
		}
	}
	reconstructed, err := FromCatalog(envelope.Code, templateValues,
		WithMeta(structuredDetails), WithCause(envelope.Cause), WithCorrelationID(envelope.CorrelationID))
	if err != nil {
		fields := "details"
		var violation *Diag
		if errors.As(err, &violation) {
			if value, ok := violation.Meta["fields"].(string); ok {
				fields = value
			}
		}
		*d = *ProtocolFailure(envelope.Code, fields)
		return nil
	}
	canonical, err := ToEnvelope(reconstructed)
	if err != nil {
		*d = *ProtocolFailure(envelope.Code, "details")
		return nil
	}
	reconstructed.Message = canonical.Message
	reconstructed.Hint = canonical.Hint
	*d = *reconstructed
	d.Actions = append([]Action(nil), envelope.Actions...)
	d.Docs = envelope.Docs
	return nil
}

// ProtocolFailure returns a typed local diagnostic for a received envelope that does not
// satisfy the shared catalog contract. The remote code and field names remain available.
func ProtocolFailure(remoteCode, fields string) *Diag {
	meta := make(map[string]any, 2)
	if remoteCode != "" {
		meta["remoteCode"] = remoteCode
	}
	if fields != "" {
		meta["fields"] = fields
	}
	return New("KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE", "", WithMeta(meta))
}

// NewCorrelationID returns a correlation ID accepted by IsValidCorrelationID.
func NewCorrelationID() string {
	var rawID [16]byte
	if _, err := rand.Read(rawID[:]); err != nil {
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(rawID[:])
}

// IsValidCorrelationID validates the platform format: 32 lowercase hexadecimal
// characters.
func IsValidCorrelationID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
