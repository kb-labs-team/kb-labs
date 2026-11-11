//go:build darwin || linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kb-labs/clikit/diag"
)

const zaiKeyFileDiagnosticCode = "KB_RUNNER_ZAI_KEY_FILE_INVALID"

type zaiKeyFileError struct {
	path   string
	reason string
}

func (e zaiKeyFileError) Error() string { return e.reason }

func zaiKeyFileEnvironmentName() (string, error) {
	entry, ok := diag.LookupCatalog(zaiKeyFileDiagnosticCode)
	if !ok {
		return "", errors.New("z.ai key-file diagnostic is missing from the platform catalog")
	}
	name := entry.EnvironmentVariables["keyFile"]
	if name == "" {
		return "", errors.New("z.ai key-file environment setting is missing from the platform catalog")
	}
	return name, nil
}

func readZaiKeyFile(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", zaiKeyFileError{reason: "KB_RUNNER_ZAI_KEY_FILE is not set"}
	}
	file, err := os.Open(path)
	if err != nil {
		return "", zaiKeyFileError{path: path, reason: "cannot read the configured key file"}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", zaiKeyFileError{path: path, reason: "cannot inspect the configured key file"}
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&^0o600 != 0 || info.Mode().Perm()&0o400 == 0 {
		return "", zaiKeyFileError{path: path, reason: "the configured key file must be a regular owner-readable file with no group or other permissions"}
	}
	data, err := io.ReadAll(io.LimitReader(file, 64*1024+1))
	if err != nil {
		return "", zaiKeyFileError{path: path, reason: "cannot read the configured key file"}
	}
	if len(data) > 64*1024 {
		return "", zaiKeyFileError{path: path, reason: "the configured key file exceeds the 64 KiB limit"}
	}
	key := strings.TrimSpace(string(data))
	if key == "" {
		return "", zaiKeyFileError{path: path, reason: "the configured key file is empty"}
	}
	return key, nil
}

func zaiKeyDiagnostic(root runnerRoot, err error) error {
	var keyErr zaiKeyFileError
	if !errors.As(err, &keyErr) {
		return err
	}
	entry, ok := diag.LookupCatalog(zaiKeyFileDiagnosticCode)
	if !ok {
		return fmt.Errorf("z.ai key-file diagnostic is missing from the platform catalog: %w", err)
	}
	return diag.New(entry.Code, entry.Message,
		diag.WithReason(keyErr.Error()),
		diag.WithBinary(root.InvocationCommand()),
		diag.WithMeta(map[string]any{"keyFile": keyErr.path}),
	)
}

func failZaiKeySetup(store *jobStore, id string, root runnerRoot, messagePath string, cause error) (int, error) {
	diagnostic := zaiKeyDiagnostic(root, cause)
	if err := store.Terminate(id, JobTerminal{
		State: JobFailed, Phase: PhaseWorktree, Reason: ReasonSetup,
		Error: diagnostic.Error(), Next: root.InvocationCommand() + " status --state " + shellQuote(filepath.Dir(store.dir)) + " --json",
		MessagePath: messagePath,
	}); err != nil {
		return 1, fmt.Errorf("z.ai key-file refusal could not be persisted: %w; next: %s status --state %s --json", err, root.InvocationCommand(), shellQuote(filepath.Dir(store.dir)))
	}
	return 1, diagnostic
}

type vendorGrant struct {
	Tokens     uint64    `json:"tokens"`
	RecordedAt time.Time `json:"recordedAt"`
}

type vendorGrantStore struct {
	dir    string
	vendor string
	now    func() time.Time
}

func newVendorGrantStore(state, vendor string, now func() time.Time) vendorGrantStore {
	return vendorGrantStore{dir: filepath.Join(state, "limits"), vendor: vendor, now: now}
}

func (s vendorGrantStore) path() string { return filepath.Join(s.dir, s.vendor+".grant.json") }

func (s vendorGrantStore) Record(value string) (vendorGrant, error) {
	tokens, err := parseTokenGrant(value)
	if err != nil {
		return vendorGrant{}, err
	}
	if s.now == nil {
		return vendorGrant{}, errors.New("vendor grant store requires a clock")
	}
	grant := vendorGrant{Tokens: tokens, RecordedAt: s.now().UTC()}
	data, err := json.MarshalIndent(grant, "", "  ")
	if err != nil {
		return vendorGrant{}, fmt.Errorf("encode %s grant: %w", s.vendor, err)
	}
	if err := writeAtomicFile(s.path(), data); err != nil {
		return vendorGrant{}, fmt.Errorf("save %s grant: %w", s.vendor, err)
	}
	return grant, nil
}

func (s vendorGrantStore) Read() (*vendorGrant, error) {
	data, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var grant vendorGrant
	if err := json.Unmarshal(data, &grant); err != nil {
		return nil, fmt.Errorf("decode %s grant: %w", s.vendor, err)
	}
	if grant.Tokens == 0 || grant.RecordedAt.IsZero() {
		return nil, fmt.Errorf("stored %s grant is incomplete", s.vendor)
	}
	return &grant, nil
}

func parseTokenGrant(value string) (uint64, error) {
	trimmed := strings.TrimSpace(strings.ReplaceAll(strings.ToUpper(value), ",", ""))
	if trimmed == "" {
		return 0, errors.New("grant value is empty")
	}
	multiplier := float64(1)
	switch trimmed[len(trimmed)-1] {
	case 'K':
		multiplier, trimmed = 1_000, trimmed[:len(trimmed)-1]
	case 'M':
		multiplier, trimmed = 1_000_000, trimmed[:len(trimmed)-1]
	case 'B':
		multiplier, trimmed = 1_000_000_000, trimmed[:len(trimmed)-1]
	}
	amount, err := strconv.ParseFloat(strings.TrimSpace(trimmed), 64)
	if err != nil || amount <= 0 || math.IsInf(amount, 0) || math.IsNaN(amount) || amount*multiplier > math.MaxUint64 || math.Trunc(amount*multiplier) != amount*multiplier {
		return 0, fmt.Errorf("invalid token grant %q; use a positive integer or K/M/B suffix", value)
	}
	return uint64(amount * multiplier), nil
}

func vendorSpendLimit(vendor, state string, jobs []Job) (VendorLimit, error) {
	var total uint64
	var latest *Job
	unknownAttempts := 0
	for index := range jobs {
		job := &jobs[index]
		if job.Vendor != vendor {
			continue
		}
		total += job.Tokens
		if latest == nil || job.StartedAt.After(latest.StartedAt) {
			latest = job
		}
		for _, attempt := range job.Attempts {
			if attempt.Usage == attemptUsageUnknown {
				unknownAttempts++
			}
		}
	}
	spend := &VendorSpend{UnknownAttempts: unknownAttempts}
	if latest != nil {
		spend.ThisJob = latest.Tokens
	}
	spend.Total = total
	grant, err := newVendorGrantStore(state, vendor, time.Now).Read()
	if err != nil {
		return VendorLimit{}, err
	}
	if grant != nil {
		spend.Grant = grant.Tokens
		if total < grant.Tokens {
			spend.Remaining = grant.Tokens - total
		}
		spend.HasGrant = true
	}
	return VendorLimit{Vendor: vendor, Window: "spend", Confidence: "recorded", Source: "ledger", FetchedAt: time.Now().UTC(), Spend: spend}, nil
}

func formatVendorSpend(vendor string, spend VendorSpend) string {
	line := fmt.Sprintf("%s spent %d tokens (this job) / %d total", vendor, spend.ThisJob, spend.Total)
	if spend.UnknownAttempts > 0 {
		line += fmt.Sprintf("; usage unknown for %s", attemptCountLabel(spend.UnknownAttempts))
	}
	if spend.HasGrant {
		line += fmt.Sprintf("; remaining %d tokens of %d", spend.Remaining, spend.Grant)
	}
	return line
}

func attemptCountLabel(count int) string {
	if count == 1 {
		return "1 attempt"
	}
	return fmt.Sprintf("%d attempts", count)
}
