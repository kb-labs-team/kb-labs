// Package diagnostics builds redacted, attachable failure dossiers. Raw logs
// remain local; any secret key supplied by the engine is replaced before write.
package diagnostics

import (
	"encoding/json"
	"fmt"
	"github.com/kb-labs/clikit/diag"
	"os"
	"path/filepath"

	"strings"

	"github.com/kb-labs/create/v2/contracts"
)

type Dossier struct {
	CorrelationID       string               `json:"correlationId"`
	Error               *diag.Diag           `json:"error"`
	PlanHash            string               `json:"planHash"`
	ReleaseDigest       string               `json:"releaseDigest,omitempty"`
	ScenarioStateDigest string               `json:"scenarioStateDigest,omitempty"`
	ReceiptID           string               `json:"receiptId,omitempty"`
	SnapshotID          string               `json:"snapshotId,omitempty"`
	Stage               contracts.ErrorStage `json:"stage"`
	Toolchain           map[string]string    `json:"toolchain,omitempty"`
	ConfigHashes        map[string]string    `json:"configHashes,omitempty"`
	ServiceGraph        []string             `json:"serviceGraph,omitempty"`
	Journal             []string             `json:"journal,omitempty"`
	Logs                []string             `json:"logs,omitempty"`
	LogPath             string               `json:"logPath,omitempty"`
}

func Redact(value string, secrets []string) string {
	result := diag.RedactText(value)
	for _, secret := range secrets {
		if secret != "" {
			result = strings.ReplaceAll(result, secret, "[REDACTED]")
		}
	}
	return result
}
func Write(directory string, dossier Dossier, secrets []string) (string, error) {
	if dossier.CorrelationID == "" {
		return "", fmt.Errorf("diagnostic correlation ID is required")
	}
	if dossier.Error != nil {
		dossier.Error.Message = Redact(dossier.Error.Message, secrets)
		dossier.Error.Cause = Redact(dossier.Error.Cause, secrets)
		dossier.Error.Reason = Redact(dossier.Error.Reason, secrets)
		for key, value := range dossier.Error.Meta {
			if text, ok := value.(string); ok {
				dossier.Error.Meta[key] = Redact(text, secrets)
			}
		}
	}
	for i := range dossier.Journal {
		dossier.Journal[i] = Redact(dossier.Journal[i], secrets)
	}
	for i := range dossier.Logs {
		dossier.Logs[i] = Redact(dossier.Logs[i], secrets)
	}
	data, err := json.MarshalIndent(dossier, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return "", err
	}
	path := filepath.Join(directory, dossier.CorrelationID+".json")
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		return "", err
	}
	return path, nil
}
