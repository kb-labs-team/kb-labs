package diag

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
)

// Action is a copy-ready recovery action in the platform error envelope.
type Action struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Command string `json:"command,omitempty"`
}

// Envelope is the canonical platform error wire shape. Required catalog
// metadata is always populated from the generated platform catalog.
type Envelope struct {
	Code          string         `json:"code"`
	Area          string         `json:"area"`
	Stage         string         `json:"stage"`
	Severity      string         `json:"severity"`
	Retryable     bool           `json:"retryable"`
	Message       string         `json:"message"`
	Cause         string         `json:"cause,omitempty"`
	Hint          string         `json:"hint"`
	Actions       []Action       `json:"actions,omitempty"`
	Docs          string         `json:"docs,omitempty"`
	CorrelationID string         `json:"correlationId,omitempty"`
	Details       map[string]any `json:"details,omitempty"`
}

// ToEnvelope serializes a diagnostic with all required canonical metadata.
func ToEnvelope(d *Diag) (Envelope, error) {
	if d == nil {
		return Envelope{}, fmt.Errorf("cannot serialize a nil diagnostic")
	}
	entry, ok := LookupCatalog(d.Code)
	if !ok {
		return Envelope{}, fmt.Errorf("diagnostic code %q is absent from the platform catalog", d.Code)
	}
	hint := d.Hint
	useCatalogHint := hint == "" || hint == entry.Hint
	if useCatalogHint {
		hint = entry.Hint
		if d.CorrelationID == "" && entry.HintWithoutCorrelationID != "" {
			hint = entry.HintWithoutCorrelationID
		}
	}
	message := d.Message
	if message == "" {
		message = entry.Message
	}
	templateValues := make(map[string]string, len(d.Meta)+2)
	for key, value := range d.Meta {
		switch value.(type) {
		case map[string]any, map[string]string, []any, []map[string]string:
			continue
		}
		templateValues[key] = fmt.Sprint(value)
	}
	if d.Binary != "" {
		templateValues["binary"] = d.Binary
	}
	if d.CorrelationID != "" {
		templateValues["correlationId"] = d.CorrelationID
	}
	templateParameters := templateParameterSet(entry)
	violations := make(map[string]struct{})
	metaFields := make([]string, 0, len(d.Meta))
	for key := range d.Meta {
		metaFields = append(metaFields, key)
	}
	for _, key := range UndeclaredDetailFields(d.Code, metaFields) {
		violations[key] = struct{}{}
	}
	for _, name := range entry.RequiredTemplateParameters {
		if value, exists := templateValues[name]; !exists || strings.TrimSpace(value) == "" {
			violations[name] = struct{}{}
		}
	}
	for _, name := range entry.RequiredStructuredDetailFields {
		if _, exists := d.Meta[name]; !exists {
			violations[name] = struct{}{}
		}
	}
	for name, schema := range entry.StructuredDetailSchemas {
		if value, exists := d.Meta[name]; exists && !matchesCatalogDetailSchema(value, schema) {
			violations[name] = struct{}{}
		}
	}
	if len(violations) > 0 {
		fields := make([]string, 0, len(violations))
		for field := range violations {
			fields = append(fields, field)
		}
		sort.Strings(fields)
		return Envelope{}, NewContractViolation(d.Code, strings.Join(fields, ", "))
	}
	message = renderTemplate(message, templateValues, templateParameters)
	if useCatalogHint {
		hint = renderTemplate(hint, templateValues, templateParameters)
	}
	envelope := Envelope{
		Code: entry.Code, Area: entry.Area, Stage: entry.Stage,
		Severity: entry.Severity, Retryable: entry.Retryable,
		Message: message, Hint: hint, Cause: d.Cause,
		Actions: append([]Action(nil), d.Actions...), Docs: d.Docs,
		CorrelationID: d.CorrelationID,
	}
	if envelope.Cause == "" {
		envelope.Cause = d.Reason
	}
	if len(d.Meta) > 0 {
		envelope.Details = make(map[string]any, len(d.Meta))
		for key, value := range d.Meta {
			envelope.Details[key] = value
		}
	}
	return envelope, nil
}

func matchesCatalogDetailSchema(value any, encoded json.RawMessage) bool {
	var schema map[string]any
	if json.Unmarshal([]byte(encoded), &schema) != nil {
		return false
	}
	serialized, err := json.Marshal(value)
	if err != nil {
		return false
	}
	var normalized any
	if json.Unmarshal(serialized, &normalized) != nil {
		return false
	}
	return matchesSchemaValue(normalized, schema)
}

func matchesSchemaValue(value any, schema map[string]any) bool {
	switch schema["type"] {
	case "string":
		_, ok := value.(string)
		return ok
	case "array":
		items, ok := value.([]any)
		if !ok {
			return false
		}
		itemSchema, ok := schema["items"].(map[string]any)
		if !ok {
			return false
		}
		for _, item := range items {
			if !matchesSchemaValue(item, itemSchema) {
				return false
			}
		}
		return true
	case "object":
		object, ok := value.(map[string]any)
		if !ok {
			return false
		}
		properties, ok := schema["properties"].(map[string]any)
		if !ok {
			return false
		}
		if required, ok := schema["required"].([]any); ok {
			for _, field := range required {
				name, ok := field.(string)
				if !ok {
					return false
				}
				if _, exists := object[name]; !exists {
					return false
				}
			}
		}
		for name, item := range object {
			property, exists := properties[name]
			if !exists {
				if schema["additionalProperties"] == false {
					return false
				}
				continue
			}
			propertySchema, ok := property.(map[string]any)
			if !ok || !matchesSchemaValue(item, propertySchema) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func templateParameterSet(entry CatalogEntry) map[string]struct{} {
	declared := make(map[string]struct{}, len(entry.TemplateParameters))
	for _, name := range entry.TemplateParameters {
		declared[name] = struct{}{}
	}
	return declared
}

// renderTemplate substitutes only names declared by the generated catalog. Unknown brace text and
// braces inside a replacement value remain literal.
func renderTemplate(template string, values map[string]string, declared map[string]struct{}) string {
	var rendered strings.Builder
	for len(template) > 0 {
		opening := strings.IndexByte(template, '{')
		if opening < 0 {
			rendered.WriteString(template)
			break
		}
		rendered.WriteString(template[:opening])
		template = template[opening:]
		closing := strings.IndexByte(template[1:], '}')
		if closing < 0 {
			rendered.WriteString(template)
			break
		}
		closing++
		key := template[1:closing]
		original := template[:closing+1]
		if _, known := declared[key]; !known {
			rendered.WriteString(original)
		} else if value, ok := values[key]; ok {
			rendered.WriteString(value)
		} else {
			rendered.WriteString(original)
		}
		template = template[closing+1:]
	}
	return rendered.String()
}

// NewContractViolation creates the canonical diagnostic used when a producer violates
// the catalog detail contract at the serialization boundary.
func NewContractViolation(originalCode, fields string) *Diag {
	slog.Default().Error("diagnostic producer violates catalog detail contract", "code", originalCode, "fields", fields)
	code := "KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION"
	entry := catalogEntries[code]
	values := map[string]string{"originalCode": originalCode, "fields": fields}
	message := renderTemplate(entry.Message, values, templateParameterSet(entry))
	return New(code, message,
		WithMeta(map[string]any{"originalCode": originalCode, "fields": fields}))
}

// UndeclaredDetailFields returns supplied field names outside the code's generated contract.
func UndeclaredDetailFields(code string, fields []string) []string {
	entry, ok := LookupCatalog(code)
	if !ok {
		return append([]string(nil), fields...)
	}
	declared := make(map[string]struct{}, len(entry.TemplateParameters)+len(entry.StructuredDetailFields))
	for _, name := range entry.TemplateParameters {
		declared[name] = struct{}{}
	}
	for _, name := range entry.StructuredDetailFields {
		declared[name] = struct{}{}
	}
	var undeclared []string
	for _, field := range fields {
		if _, ok := declared[field]; !ok {
			undeclared = append(undeclared, field)
		}
	}
	sort.Strings(undeclared)
	return undeclared
}
