//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type LimitAttempt struct {
	Source       string    `json:"source"`
	Outcome      string    `json:"outcome"`
	Error        string    `json:"error,omitempty"`
	DurationMS   int64     `json:"durationMs"`
	StartedAt    time.Time `json:"startedAt"`
	CapturePath  string    `json:"capturePath,omitempty"`
	CaptureError string    `json:"captureError,omitempty"`
}

type limitSourceOutput struct {
	Limits     []VendorLimit
	Structured json.RawMessage
	Err        error
}

type limitSource struct {
	name string
	read func(context.Context) limitSourceOutput
}

type limitCaptureKey struct{}

type limitCaptureConfig struct{ directory string }

type limitCaptureFile struct {
	Vendor             string          `json:"vendor"`
	Attempt            LimitAttempt    `json:"attempt"`
	StructuredResponse json.RawMessage `json:"structuredResponse,omitempty"`
}

var captureEmailPattern = regexp.MustCompile(`[A-Za-z0-9.!#$%&'*+/=?^_` + "`" + `{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+`)

func withLimitsCapture(ctx context.Context, directory string) context.Context {
	return context.WithValue(ctx, limitCaptureKey{}, limitCaptureConfig{directory: directory})
}

func limitsCaptureFromContext(ctx context.Context) limitCaptureConfig {
	config, _ := ctx.Value(limitCaptureKey{}).(limitCaptureConfig)
	return config
}

func collectVendorLimits(ctx context.Context, vendor string, sources ...limitSource) ([]VendorLimit, error) {
	attempts := make([]LimitAttempt, 0, len(sources))
	var selected []VendorLimit
	var captureErr error
	for _, source := range sources {
		started := time.Now().UTC()
		output := source.read(ctx)
		finished := time.Now().UTC()
		attempt := LimitAttempt{Source: source.name, Outcome: "unavailable", StartedAt: started, DurationMS: finished.Sub(started).Milliseconds()}
		if output.Err != nil {
			attempt.Error = output.Err.Error()
		} else if hasVendorLimits(output.Limits) {
			attempt.Outcome = "available"
		} else if len(output.Limits) > 0 {
			attempt.Error = output.Limits[0].Error
		}
		config := limitsCaptureFromContext(ctx)
		if config.directory != "" {
			attempt.CapturePath = limitCapturePath(config.directory, vendor, source.name)
			path, err := writeLimitCapture(config.directory, vendor, attempt, output)
			if path != "" {
				attempt.CapturePath = path
			}
			if err != nil {
				attempt.CaptureError = err.Error()
				if captureErr == nil {
					captureErr = fmt.Errorf("write %s %s capture: %w", vendor, source.name, err)
				}
			}
		}
		attempts = append(attempts, attempt)
		if hasVendorLimits(output.Limits) {
			selected = output.Limits
			break
		}
		selected = output.Limits
	}
	if len(selected) == 0 {
		selected = unavailableLimits(vendor, "limits", errors.New("all limit sources returned no result"))
	}
	for index := range selected {
		selected[index].Attempts = append([]LimitAttempt(nil), attempts...)
	}
	if captureErr != nil {
		return selected, captureErr
	}
	return selected, nil
}

func limitCapturePath(directory, vendor, source string) string {
	return filepath.Join(directory, vendor, source+".json")
}

func writeLimitCapture(directory, vendor string, attempt LimitAttempt, output limitSourceOutput) (path string, resultErr error) {
	path = limitCapturePath(directory, vendor, attempt.Source)
	payload := json.RawMessage(nil)
	if len(output.Structured) > 0 {
		var err error
		payload, err = redactLimitPayload(output.Structured)
		if err != nil {
			return path, fmt.Errorf("redact structured response: %w", err)
		}
	}
	file := limitCaptureFile{Vendor: vendor, Attempt: attempt, StructuredResponse: payload}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return path, fmt.Errorf("encode capture: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return path, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".limits-capture-")
	if err != nil {
		return path, err
	}
	tmpName := tmp.Name()
	closed, renamed := false, false
	defer func() {
		if !closed {
			if err := tmp.Close(); err != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("close capture temp file: %w", err))
			}
		}
		if !renamed {
			if err := os.Remove(tmpName); err != nil && !errors.Is(err, os.ErrNotExist) {
				resultErr = errors.Join(resultErr, fmt.Errorf("remove capture temp file: %w", err))
			}
		}
	}()
	if err := tmp.Chmod(0600); err != nil {
		return path, err
	}
	if _, err := tmp.Write(data); err != nil {
		return path, err
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return path, err
	}
	closed = true
	if err := os.Rename(tmpName, path); err != nil {
		return path, err
	}
	renamed = true
	return path, nil
}

func redactLimitPayload(data []byte) (json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	redacted := redactLimitValue(value)
	encoded, err := json.Marshal(redacted)
	return encoded, err
}

func redactLimitValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			if sensitiveLimitField(key) {
				continue
			}
			result[key] = redactLimitValue(item)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = redactLimitValue(item)
		}
		return result
	case string:
		return redactLimitText(typed)
	default:
		return value
	}
}

func sensitiveLimitField(key string) bool {
	lower := strings.ToLower(key)
	for _, word := range []string{"token", "secret", "key", "email", "account"} {
		if strings.Contains(lower, word) {
			return true
		}
	}
	return false
}

func redactLimitText(text string) string {
	return captureEmailPattern.ReplaceAllStringFunc(text, func(value string) string {
		if _, err := mail.ParseAddress(value); err == nil {
			return "[redacted email]"
		}
		return value
	})
}
