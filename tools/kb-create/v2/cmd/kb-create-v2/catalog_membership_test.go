package v2cli

import (
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/diag/catalogcheck"
)

func TestRegisteredOperationCodesBelongToDiagnosticCatalog(t *testing.T) {
	if len(operationDescriptors) == 0 {
		t.Fatal("operation descriptor registry is empty")
	}
	registeredHandlers := make(map[string]struct{}, len(operationDescriptors))
	for _, descriptor := range operationDescriptors {
		if descriptor.Handler == nil {
			t.Errorf("operation %q has no registered handler", descriptor.Name)
			continue
		}
		function := runtime.FuncForPC(reflect.ValueOf(descriptor.Handler).Pointer())
		if function == nil {
			t.Errorf("operation %q handler has no source location", descriptor.Name)
			continue
		}
		file, _ := function.FileLine(function.Entry())
		registeredHandlers[filepath.Clean(file)] = struct{}{}
	}
	if len(registeredHandlers) == 0 {
		t.Fatal("no registered operation handler source files were found")
	}

	sourceRoot := filepath.Dir(firstRegisteredHandler(t))
	scan, err := catalogcheck.Scan(sourceRoot, diag.CatalogEnvironmentVariableNames())
	if err != nil {
		t.Fatal(err)
	}
	scannedSources := make(map[string]struct{}, len(scan.Files))
	for _, source := range scan.Files {
		scannedSources[filepath.Clean(source)] = struct{}{}
	}
	for source := range registeredHandlers {
		if _, scanned := scannedSources[source]; !scanned {
			t.Errorf("registered handler source %s is outside the catalog scan", source)
		}
	}
	if len(scannedSources) == 0 {
		t.Fatal("no production Go sources were scanned")
	}
	for code, sources := range scan.Codes {
		if _, found := diag.LookupCatalog(code); !found {
			t.Errorf("operation diagnostic %s in %s is absent from the clikit diagnostic catalog", code, strings.Join(sources, ", "))
		}
	}
}

func firstRegisteredHandler(t *testing.T) string {
	t.Helper()
	for _, descriptor := range operationDescriptors {
		if descriptor.Handler == nil {
			continue
		}
		function := runtime.FuncForPC(reflect.ValueOf(descriptor.Handler).Pointer())
		if function != nil {
			file, _ := function.FileLine(function.Entry())
			return filepath.Clean(file)
		}
	}
	t.Fatal("no registered operation handler source file was found")
	return ""
}
