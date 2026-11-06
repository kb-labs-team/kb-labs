//go:build darwin || linux

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type EventKind string

type vendorLimitsMode uint8

const (
	vendorLimitsAppServer vendorLimitsMode = iota + 1
	vendorLimitsRecorded
	vendorLimitsLedger
)

const defaultAgentVendor = "codex"

// vendorUsageOnFailure states what a vendor's stream exposes about the spend
// of a turn that never produced a final result.
type vendorUsageOnFailure uint8

const (
	// usageUnknownOnFailure: the vendor emits usage only with the final
	// result, so a failed turn's spend cannot be known.
	usageUnknownOnFailure vendorUsageOnFailure = iota + 1
	// usagePartialOnFailure: the vendor streams running usage before the
	// final result, so the tokens observed before the failure are recorded.
	usagePartialOnFailure
)

type vendorSpec struct {
	agent          bool
	review         bool
	binaryEnv      string
	binaryDefault  string
	childEnv       []string
	limitsMode     vendorLimitsMode
	failures       vendorFailureTable
	usageOnFailure vendorUsageOnFailure
	parser         func([]byte) (VendorEvent, error)
}

var vendorRegistry = map[string]vendorSpec{
	"codex":  {agent: true, binaryEnv: "CODEX_BIN", binaryDefault: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", limitsMode: vendorLimitsAppServer, failures: textStreamFailureTable, usageOnFailure: usagePartialOnFailure, parser: func(line []byte) (VendorEvent, error) { return parseClaudeCodexEvent("codex", line) }},
	"claude": {agent: true, binaryEnv: "CLAUDE_BIN", binaryDefault: "claude", limitsMode: vendorLimitsRecorded, failures: textStreamFailureTable, usageOnFailure: usageUnknownOnFailure, parser: func(line []byte) (VendorEvent, error) { return parseClaudeCodexEvent("claude", line) }},
	"zai":    {agent: true, binaryEnv: "CLAUDE_BIN", binaryDefault: "claude", limitsMode: vendorLimitsLedger, failures: textStreamFailureTable, usageOnFailure: usageUnknownOnFailure, parser: func(line []byte) (VendorEvent, error) { return parseClaudeCodexEvent("claude", line) }},
	"zcode":  {agent: true, binaryEnv: "ZCODE_BIN", binaryDefault: "~/Desktop/work/zcode/zcode", limitsMode: vendorLimitsLedger, failures: zcodeFailureTable, usageOnFailure: usageUnknownOnFailure, parser: parseZcodeEvent},
	"gem":    {review: true, binaryEnv: "GEM_BIN", binaryDefault: "gem"},
}

func vendors() []string {
	return vendorNamesFor(nil)
}

func vendorNamesFor(mode *vendorLimitsMode) []string {
	names := make([]string, 0, len(vendorRegistry))
	for name, spec := range vendorRegistry {
		if spec.agent && (mode == nil || spec.limitsMode == *mode) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

const (
	EventStarted             EventKind = "started"
	EventActivity            EventKind = "activity"
	EventTool                EventKind = "tool"
	EventUsage               EventKind = "usage"
	EventFinal               EventKind = "final"
	EventVendorError         EventKind = "vendor_error"
	EventRateLimited         EventKind = "rate_limited"
	EventProviderUnreachable EventKind = "provider_unreachable"
	EventAuthExpired         EventKind = "auth_expired"
)

type VendorEvent struct {
	Kind          EventKind `json:"kind"`
	SessionID     string    `json:"sessionId,omitempty"`
	Message       string    `json:"message,omitempty"`
	FinalMessage  string    `json:"finalMessage,omitempty"`
	Tool          string    `json:"tool,omitempty"`
	Tokens        uint64    `json:"tokens,omitempty"`
	InputTokens   uint64    `json:"inputTokens,omitempty"`
	OutputTokens  uint64    `json:"outputTokens,omitempty"`
	RawType       string    `json:"rawType,omitempty"`
	ProviderCode  string    `json:"providerCode,omitempty"`
	StatusCode    int       `json:"statusCode,omitempty"`
	FailureSource string    `json:"failureSource,omitempty"`
}

type healthTracker struct {
	threshold int
	mu        sync.Mutex
	failures  map[string]int
}

func newHealthTracker(threshold int) *healthTracker {
	if threshold < 1 {
		threshold = 1
	}
	return &healthTracker{threshold: threshold, failures: map[string]int{}}
}
func (h *healthTracker) Observe(vendor string, line []byte) (VendorEvent, error) {
	spec, ok := vendorRegistry[vendor]
	if !ok {
		return VendorEvent{}, fmt.Errorf("unsupported vendor %q", vendor)
	}
	e, err := parseVendorEvent(vendor, line)
	if err != nil {
		return VendorEvent{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if spec.failures.classify(e).class == failureTransient {
		h.failures[vendor]++
		if h.failures[vendor] >= h.threshold {
			e.Kind = EventProviderUnreachable
		}
	} else if e.Kind != EventActivity {
		h.failures[vendor] = 0
	}
	return e, nil
}

func quotaBlocked(limits []VendorLimit, fiveHour, week float64) bool {
	for _, limit := range limits {
		if limit.Confidence != "vendor" {
			continue
		}
		if limit.Blocked || (limit.Window == "5h" && limit.UsedPercent >= fiveHour) || (limit.Window == "week" && limit.UsedPercent >= week) {
			return true
		}
	}
	return false
}

type AgentRequest struct {
	Prompt           string
	Workdir          string
	Effort           string
	WritableDirs     []string
	Model            string
	SessionID        string
	FinalPath        string
	StateDir         string
	JobID            string
	TestChannelSpool string
}
type AgentAdapter interface {
	Start(context.Context, AgentRequest) (*exec.Cmd, error)
	Resume(context.Context, AgentRequest) (*exec.Cmd, error)
	Interrupt(*os.Process) error
	Parse([]byte) (VendorEvent, error)
	Redact(string) string
	Limits(context.Context) ([]VendorLimit, error)
}

type fakeLimitProvider struct {
	limits []VendorLimit
	err    error
}

func (f fakeLimitProvider) Limits(context.Context) ([]VendorLimit, error) { return f.limits, f.err }

func parseVendorEvent(vendor string, line []byte) (VendorEvent, error) {
	spec, ok := vendorRegistry[vendor]
	if !ok {
		return VendorEvent{}, fmt.Errorf("unsupported vendor %q", vendor)
	}
	if spec.parser == nil {
		return VendorEvent{}, fmt.Errorf("vendor %q has no stream parser", vendor)
	}
	return spec.parser(line)
}

func parseClaudeCodexEvent(vendor string, line []byte) (VendorEvent, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(line, &obj); err != nil {
		return VendorEvent{}, err
	}
	decodeString := func(field string) (string, error) {
		raw, ok := obj[field]
		if !ok {
			return "", nil
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return "", fmt.Errorf("event field %q must be a string: %w", field, err)
		}
		return value, nil
	}
	typ, err := decodeString("type")
	if err != nil {
		return VendorEvent{}, err
	}
	if typ == "" {
		return VendorEvent{}, errors.New("vendor event is missing its type")
	}
	msg, err := decodeString("message")
	if err != nil {
		if vendor != "claude" {
			return VendorEvent{}, err
		}
		msg, err = decodeClaudeMessage(obj["message"])
		if err != nil {
			return VendorEvent{}, err
		}
	}
	session, err := decodeString("session_id")
	if err != nil {
		return VendorEvent{}, err
	}
	if session == "" {
		session, err = decodeString("thread_id")
		if err != nil {
			return VendorEvent{}, err
		}
	}
	e := VendorEvent{RawType: typ, SessionID: session, Kind: EventActivity, Message: msg}
	var usage struct {
		Input  uint64 `json:"input_tokens"`
		Output uint64 `json:"output_tokens"`
	}
	var usagePayload struct {
		Usage struct {
			Input  uint64 `json:"input_tokens"`
			Output uint64 `json:"output_tokens"`
		} `json:"usage"`
		Message json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(line, &usagePayload); err != nil {
		return VendorEvent{}, err
	}
	usage = usagePayload.Usage
	if usage.Input == 0 && usage.Output == 0 {
		var message struct {
			Usage struct {
				Input  uint64 `json:"input_tokens"`
				Output uint64 `json:"output_tokens"`
			} `json:"usage"`
		}
		messageJSON := strings.TrimSpace(string(usagePayload.Message))
		if strings.HasPrefix(messageJSON, "{") {
			if err := json.Unmarshal(usagePayload.Message, &message); err != nil {
				return VendorEvent{}, fmt.Errorf("decode Claude message usage: %w", err)
			}
			usage = message.Usage
		} else if messageJSON != "" && !strings.HasPrefix(messageJSON, "\"") && messageJSON != "null" {
			return VendorEvent{}, fmt.Errorf("Claude message must be a string or object")
		}
	}
	e.InputTokens, e.OutputTokens = usage.Input, usage.Output
	switch typ {
	case "thread.started", "session_started":
		e.Kind = EventStarted
	case "token_count", "usage":
		e.Kind = EventUsage
		var payload struct {
			Total struct {
				Total uint64 `json:"total_tokens"`
			} `json:"total_token_usage"`
			Usage struct {
				Total uint64 `json:"total_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(line, &payload); err != nil {
			return VendorEvent{}, err
		}
		e.Tokens = payload.Total.Total
		if e.Tokens == 0 {
			e.Tokens = payload.Usage.Total
		}
		if vendor == "claude" {
			e.InputTokens, e.OutputTokens = usage.Input, usage.Output
		}
	case "assistant":
		// Claude assistant events carry per-message usage; the final result
		// carries the turn total, so accounting both would double count it.
	case "tool_use", "tool.started":
		e.Kind = EventTool
		e.Tool, err = decodeString("name")
		if err != nil {
			return VendorEvent{}, err
		}
	case "turn.completed", "result", "final":
		e.Kind = EventFinal
		if typ == "result" {
			e.FinalMessage, err = decodeString("result")
			if err != nil {
				return VendorEvent{}, err
			}
		}
		if e.FinalMessage == "" {
			e.FinalMessage = msg
		}
	case "error", "turn.failed":
		low := strings.ToLower(msg)
		switch {
		case strings.Contains(low, "rate limit") || strings.Contains(low, "usage limit") || strings.Contains(low, "capacity"):
			e.Kind = EventRateLimited
		case strings.Contains(low, "authentication") || strings.Contains(low, "unauthorized") || strings.Contains(low, "token expired"):
			e.Kind = EventAuthExpired
		default:
			e.Kind = EventVendorError
		}
	}
	return e, nil
}

func decodeClaudeMessage(raw json.RawMessage) (string, error) {
	var message struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &message); err != nil {
		return "", fmt.Errorf("Claude message must be text or a message object: %w", err)
	}
	var text strings.Builder
	for _, block := range message.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	return text.String(), nil
}

type commandAdapter struct {
	vendor   string
	binary   string
	childEnv []string
	secret   string
}

func newAdapter(vendor string) (AgentAdapter, error) {
	spec, ok := vendorRegistry[vendor]
	if !ok {
		return nil, fmt.Errorf("unsupported vendor %q", vendor)
	}
	if !spec.agent {
		return nil, fmt.Errorf("vendor %q is not available for agent runs", vendor)
	}
	bin, err := vendorBinary(spec)
	if err != nil {
		return nil, err
	}
	adapter := commandAdapter{vendor: vendor, binary: bin, childEnv: spec.childEnv}
	if vendor == "zai" {
		keyName, err := zaiKeyFileEnvironmentName()
		if err != nil {
			return nil, err
		}
		adapter.secret, err = readZaiKeyFile(os.Getenv(keyName))
		if err != nil {
			return nil, err
		}
	}
	return adapter, nil
}
func newLimitsProvider(vendor string) (limitsProvider, error) {
	spec, ok := vendorRegistry[vendor]
	if !ok {
		return nil, fmt.Errorf("unsupported vendor %q", vendor)
	}
	if spec.limitsMode != vendorLimitsAppServer {
		return nil, fmt.Errorf("vendor %q has no automatic limits provider", vendor)
	}
	bin := os.Getenv(spec.binaryEnv)
	if bin == "" {
		bin = spec.binaryDefault
	}
	return commandAdapter{vendor: vendor, binary: bin, childEnv: spec.childEnv}, nil
}

func vendorBinary(spec vendorSpec) (string, error) {
	if binary := os.Getenv(spec.binaryEnv); binary != "" {
		return binary, nil
	}
	if strings.HasPrefix(spec.binaryDefault, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve vendor wrapper path from HOME: %w", err)
		}
		return filepath.Join(home, filepath.FromSlash(strings.TrimPrefix(spec.binaryDefault, "~/"))), nil
	}
	if spec.binaryDefault == "" {
		return "", errors.New("vendor registry entry has no binary default")
	}
	return spec.binaryDefault, nil
}
func (a commandAdapter) Start(ctx context.Context, r AgentRequest) (*exec.Cmd, error) {
	var args []string
	if a.vendor == "codex" {
		args = []string{"exec", "--json", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-c", fmt.Sprintf("model_reasoning_effort=%q", r.Effort), "-C", r.Workdir}
		writableDirs := append(append([]string(nil), r.WritableDirs...), r.TestChannelSpool)
		for _, d := range writableDirs {
			if d == "" {
				continue
			}
			args = append(args, "--add-dir", d)
		}
		if r.Model != "" {
			args = append(args, "-m", r.Model)
		}
		if r.FinalPath != "" {
			args = append(args, "-o", r.FinalPath)
		}
		args = append(args, "-")
	} else if a.vendor == "zcode" {
		args = zcodeArgs(r, false)
	} else {
		args = []string{"-p", r.Prompt, "--output-format", "stream-json"}
		if r.Model != "" {
			args = append(args, "--model", r.Model)
		}
	}
	var cmd *exec.Cmd
	var err error
	if a.vendor == "zcode" {
		cmd, err = a.zcodeCommand(ctx, r, args...)
		if err != nil {
			return nil, err
		}
	} else {
		cmd = exec.CommandContext(ctx, a.binary, args...)
	}
	cmd.Dir = r.Workdir
	cmd.Env, err = vendorAgentEnvironment(a.vendor, a.childEnv, r, a.secret)
	if err != nil {
		return nil, err
	}
	if a.vendor == "codex" {
		cmd.Stdin = strings.NewReader(r.Prompt)
	}
	return cmd, nil
}
func (a commandAdapter) Resume(ctx context.Context, r AgentRequest) (*exec.Cmd, error) {
	if a.vendor == "codex" {
		args := codexResumeArgs(r)
		cmd := exec.CommandContext(ctx, a.binary, args...)
		cmd.Dir = r.Workdir
		var err error
		cmd.Env, err = vendorAgentEnvironment(a.vendor, a.childEnv, r, a.secret)
		if err != nil {
			return nil, err
		}
		cmd.Stdin = strings.NewReader(r.Prompt)
		return cmd, nil
	}
	var cmd *exec.Cmd
	var err error
	if a.vendor == "zcode" {
		cmd, err = a.zcodeCommand(ctx, r, zcodeArgs(r, true)...)
		if err != nil {
			return nil, err
		}
	} else {
		cmd = exec.CommandContext(ctx, a.binary, "-p", r.Prompt, "--output-format", "stream-json", "--resume", r.SessionID)
	}
	cmd.Dir = r.Workdir
	cmd.Env, err = vendorAgentEnvironment(a.vendor, a.childEnv, r, a.secret)
	if err != nil {
		return nil, err
	}
	return cmd, nil
}

func codexResumeArgs(r AgentRequest) []string {
	roots := append([]string{r.Workdir}, r.WritableDirs...)
	if r.TestChannelSpool != "" {
		roots = append(roots, r.TestChannelSpool)
	}
	encodedRoots := make([]string, 0, len(roots))
	for _, root := range roots {
		encodedRoots = append(encodedRoots, strconv.Quote(root))
	}
	args := []string{
		"exec", "resume",
		"-c", `sandbox_mode="workspace-write"`,
		"-c", "sandbox_workspace_write.network_access=true",
		"-c", "sandbox_workspace_write.writable_roots=[" + strings.Join(encodedRoots, ",") + "]",
	}
	if r.FinalPath != "" {
		args = append(args, "-o", r.FinalPath)
	}
	return append(args, "--json", r.SessionID, "-")
}
func (a commandAdapter) Interrupt(p *os.Process) error { return p.Signal(os.Interrupt) }
func (a commandAdapter) Parse(line []byte) (VendorEvent, error) {
	_, ok := vendorRegistry[a.vendor]
	if !ok {
		return VendorEvent{}, fmt.Errorf("unsupported vendor %q", a.vendor)
	}
	event, err := parseVendorEvent(a.vendor, line)
	if err != nil {
		return VendorEvent{}, err
	}
	event.Message = a.Redact(event.Message)
	event.FinalMessage = a.Redact(event.FinalMessage)
	event.SessionID = a.Redact(event.SessionID)
	event.Tool = a.Redact(event.Tool)
	return event, nil
}
func (a commandAdapter) Redact(value string) string {
	if a.secret == "" {
		return value
	}
	return strings.ReplaceAll(value, a.secret, "[REDACTED]")
}
func (a commandAdapter) Limits(ctx context.Context) ([]VendorLimit, error) {
	spec, ok := vendorRegistry[a.vendor]
	if !ok {
		return nil, fmt.Errorf("unsupported vendor %q", a.vendor)
	}
	switch spec.limitsMode {
	case vendorLimitsAppServer:
		return collectVendorLimits(ctx, a.vendor,
			limitSource{name: "app-server", read: func(ctx context.Context) limitSourceOutput {
				limits, response, err := readCodexLimitsDetailed(ctx, a.binary)
				return limitSourceOutput{Limits: limits, Structured: response, Err: err}
			}},
		)
	case vendorLimitsRecorded:
		return []VendorLimit{}, nil
	case vendorLimitsLedger:
		return []VendorLimit{}, nil
	default:
		return nil, fmt.Errorf("vendor %q has no limits source", a.vendor)
	}
}

func hasVendorLimits(limits []VendorLimit) bool {
	for _, limit := range limits {
		if limit.Confidence == "vendor" {
			return true
		}
	}
	return false
}

type limitsProvider interface {
	Limits(context.Context) ([]VendorLimit, error)
}

func cachedLimits(path string, ttl time.Duration, p limitsProvider, now func() time.Time) ([]VendorLimit, error) {
	if data, err := os.ReadFile(path); err == nil {
		var current struct {
			At     time.Time     `json:"at"`
			Limits []VendorLimit `json:"limits"`
		}
		if json.Unmarshal(data, &current) == nil && now().Sub(current.At) < ttl {
			return current.Limits, nil
		}
	}
	limits, err := p.Limits(context.Background())
	if err != nil {
		return nil, err
	}
	current := struct {
		At     time.Time     `json:"at"`
		Limits []VendorLimit `json:"limits"`
	}{now().UTC(), limits}
	data, e := json.Marshal(current)
	if e != nil {
		return nil, e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	if e = os.WriteFile(path, data, 0600); e != nil {
		return nil, e
	}
	return limits, nil
}

func readCodexLimitsDetailed(ctx context.Context, binary string) ([]VendorLimit, json.RawMessage, error) {
	cmd := exec.CommandContext(ctx, binary, "app-server")
	env, err := childEnvironment(vendorRegistry["codex"].childEnv)
	if err != nil {
		return unavailableLimits("codex", "app-server", err), nil, err
	}
	cmd.Env = env
	in, err := cmd.StdinPipe()
	if err != nil {
		return unavailableLimits("codex", "app-server", err), nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return unavailableLimits("codex", "app-server", err), nil, err
	}
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		return unavailableLimits("codex", "app-server", err), nil, err
	}
	cleanup := func(limits []VendorLimit, response json.RawMessage, prior error) ([]VendorLimit, json.RawMessage, error) {
		if closeErr := in.Close(); closeErr != nil {
			prior = errors.Join(prior, fmt.Errorf("close app-server stdin: %w", closeErr))
		}
		killErr := cmd.Process.Kill()
		if killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
			killErr = fmt.Errorf("terminate app-server: %w", killErr)
			return unavailableLimits("codex", "app-server", killErr), response, errors.Join(prior, killErr)
		}
		waitErr := cmd.Wait()
		var exitErr *exec.ExitError
		if waitErr != nil && !errors.As(waitErr, &exitErr) {
			return unavailableLimits("codex", "app-server", waitErr), response, errors.Join(prior, waitErr)
		}
		return limits, response, prior
	}
	enc := json.NewEncoder(in)
	if err = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"clientInfo": map[string]string{"name": "kb-runner", "version": "1"}}}); err != nil {
		return cleanup(unavailableLimits("codex", "app-server", err), nil, err)
	}
	scan := bufio.NewScanner(out)
	initialized := false
	for scan.Scan() {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(scan.Bytes(), &m); err != nil {
			return cleanup(unavailableLimits("codex", "app-server", fmt.Errorf("invalid JSON-RPC response: %w", err)), nil, err)
		}
		if m["id"] == nil {
			continue
		}
		var id int
		if err := json.Unmarshal(m["id"], &id); err != nil {
			return cleanup(unavailableLimits("codex", "app-server", fmt.Errorf("invalid JSON-RPC response id: %w", err)), nil, err)
		}
		if id == 1 && !initialized {
			if err = enc.Encode(map[string]any{"jsonrpc": "2.0", "method": "initialized", "params": map[string]any{}}); err != nil {
				return cleanup(unavailableLimits("codex", "app-server", err), nil, err)
			}
			if err = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": map[string]any{}}); err != nil {
				return cleanup(unavailableLimits("codex", "app-server", err), nil, err)
			}
			initialized = true
			continue
		}
		if id != 2 || !initialized {
			continue
		}
		if len(m["error"]) > 0 {
			return cleanup(unavailableLimits("codex", "app-server", errors.New("app-server rate limit request failed")), m["error"], errors.New("app-server rate limit request failed"))
		}
		return cleanup(decodeCodexLimits(m["result"], time.Now), m["result"], nil)
	}
	if scan.Err() != nil {
		return cleanup(unavailableLimits("codex", "app-server", scan.Err()), nil, scan.Err())
	}
	err = errors.New("app-server returned no rate limit result")
	return cleanup(unavailableLimits("codex", "app-server", err), nil, err)
}
func decodeCodexLimits(data []byte, now func() time.Time) []VendorLimit {
	type window struct {
		Used     *float64 `json:"usedPercent"`
		Duration int      `json:"windowDurationMins"`
		Reset    *int64   `json:"resetsAt"`
	}
	var r struct {
		RateLimits struct {
			RateLimitReachedType json.RawMessage `json:"rateLimitReachedType"`
			SpendControlReached  bool            `json:"spendControlReached"`
		} `json:"rateLimits"`
	}
	if len(data) == 0 || json.Unmarshal(data, &r) != nil {
		return unavailableLimits("codex", "app-server", errors.New("unexpected app-server rate limit schema"))
	}
	var envelope struct {
		RateLimits map[string]json.RawMessage `json:"rateLimits"`
	}
	if json.Unmarshal(data, &envelope) != nil || len(envelope.RateLimits) == 0 {
		return unavailableLimits("codex", "app-server", errors.New("unexpected app-server rate limit schema"))
	}
	blocked := r.RateLimits.SpendControlReached || len(r.RateLimits.RateLimitReachedType) > 0 && string(r.RateLimits.RateLimitReachedType) != "null"
	limits := make([]VendorLimit, 0, len(envelope.RateLimits))
	for _, raw := range envelope.RateLimits {
		var value window
		if err := json.Unmarshal(raw, &value); err != nil || value.Used == nil || value.Duration <= 0 || value.Reset == nil {
			continue
		}
		windowName := fmt.Sprintf("%dm", value.Duration)
		switch value.Duration {
		case 300:
			windowName = "5h"
		case 10080:
			windowName = "week"
		}
		reset := time.Unix(*value.Reset, 0).UTC()
		limits = append(limits, VendorLimit{Vendor: "codex", Window: windowName, UsedPercent: *value.Used, Blocked: blocked, ResetsAt: &reset, Confidence: "vendor", Source: "app-server", FetchedAt: now().UTC()})
	}
	if len(limits) != 2 {
		return unavailableLimits("codex", "app-server", errors.New("unexpected app-server rate limit schema"))
	}
	sort.Slice(limits, func(i, j int) bool { return limits[i].Window < limits[j].Window })
	return limits
}
func unavailableLimits(vendor, source string, err error) []VendorLimit {
	return []VendorLimit{{Vendor: vendor, Window: "unknown", Confidence: "unavailable", Source: source, Error: err.Error(), FetchedAt: time.Now().UTC()}}
}
