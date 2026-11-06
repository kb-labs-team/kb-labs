package diag

import "encoding/json"

//go:generate go run ./gen

// ProcessExitClass is the catalogued Go CLI status category.
type ProcessExitClass string

const (
	ExitClassInputRefusal     ProcessExitClass = "input-refusal"
	ExitClassOperationFailure ProcessExitClass = "operation-failure"
)

// CatalogEntry is the platform-owned metadata used to render a typed error.
type CatalogEntry struct {
	Code                           string                     `json:"code"`
	HTTPStatus                     int                        `json:"httpStatus,omitempty"`
	Area                           string                     `json:"area"`
	Stage                          string                     `json:"stage"`
	Severity                       string                     `json:"severity"`
	Retryable                      bool                       `json:"retryable"`
	ProcessExitClass               ProcessExitClass           `json:"processExitClass"`
	Message                        string                     `json:"message"`
	Hint                           string                     `json:"hint"`
	HintWithoutCorrelationID       string                     `json:"hintWithoutCorrelationId,omitempty"`
	TemplateParameters             []string                   `json:"templateParameters,omitempty"`
	RequiredTemplateParameters     []string                   `json:"requiredTemplateParameters,omitempty"`
	StructuredDetailFields         []string                   `json:"structuredDetailFields,omitempty"`
	RequiredStructuredDetailFields []string                   `json:"requiredStructuredDetailFields,omitempty"`
	StructuredDetailSchemas        map[string]json.RawMessage `json:"structuredDetailSchemas,omitempty"`
	RuntimeTemplateParameters      map[string]string          `json:"runtimeTemplateParameters,omitempty"`
	EnvironmentVariables           map[string]string          `json:"environmentVariables,omitempty"`
}

// LookupCatalog returns platform metadata for a typed error code.
func LookupCatalog(code string) (CatalogEntry, bool) {
	entry, ok := catalogEntries[code]
	return entry, ok
}
