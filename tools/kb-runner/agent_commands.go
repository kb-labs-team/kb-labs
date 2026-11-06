//go:build darwin || linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func statusCommand(root runnerRoot, args []string, out, errOut io.Writer) (int, error) {
	return agentStatusCommandWithRoot(root, args, out)
}
func agentStatusCommand(args []string, out io.Writer) (int, error) {
	return agentStatusCommandWithRoot(runnerRoot{invocation: "kb-runner"}, args, out)
}
func agentStatusCommandWithRoot(root runnerRoot, args []string, out io.Writer) (int, error) {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		_, err := fmt.Fprintln(out, "Usage: kb-runner status [--state <dir>] [--json]")
		return 0, err
	}
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	state := fs.String("state", defaultRunnerState(), "runner state directory")
	asJSON := fs.Bool("json", false, "write JSON")
	if err := fs.Parse(args); err != nil {
		return 2, err
	}
	resolvedState, err := resolveRunnerState(root, "status", *state)
	if err != nil {
		return 2, err
	}
	state = &resolvedState
	store := newJobStore(*state)
	jobs, err := store.List()
	if err != nil {
		return 1, err
	}
	status := AgentStatus{Jobs: jobs, Limits: readStatusLimits(*state, root), DailyTokens: dailyTokenTotals(jobs)}
	if *asJSON {
		return 0, json.NewEncoder(out).Encode(status)
	}
	if len(jobs) > 10 {
		jobs = jobs[len(jobs)-10:]
	}
	for _, j := range jobs {
		age := "-"
		if !j.LastActivity.IsZero() {
			age = time.Since(j.LastActivity).Round(time.Second).String()
		}
		message := j.MessagePath
		if j.Final != nil && j.Final.MessagePath != "" {
			message = j.Final.MessagePath
		}
		if _, err := fmt.Fprintf(out, "%-20s %-10s %-8s %-10s %-12s activity=%-7s tokens=%-7d session=%-16s %s\n", j.ID, j.Stream, j.Vendor, j.State, j.Phase, age, j.Tokens, j.SessionID, message); err != nil {
			return 1, err
		}
	}
	for _, limit := range status.Limits {
		if _, err := fmt.Fprintf(out, "limit %-7s %-5s %5.1f%% %-12s reset=%v\n", limit.Vendor, limit.Window, limit.UsedPercent, limit.Confidence, limit.ResetsAt); err != nil {
			return 1, err
		}
	}
	for _, usage := range status.DailyTokens {
		if _, err := fmt.Fprintf(out, "tokens %-7s %-10s %d\n", usage.Vendor, usage.Day, usage.Tokens); err != nil {
			return 1, err
		}
	}
	return 0, nil
}

func readStatusLimits(state string, root runnerRoot) []VendorLimit {
	all := []VendorLimit{}
	for _, vendor := range vendors() {
		spec := vendorRegistry[vendor]
		if spec.limitsMode == vendorLimitsRecorded {
			limits, _, err := newClaudeReadingStore(state, time.Now, time.Local).Limits()
			if err != nil {
				err = fmt.Errorf("Claude usage has no current recorded reading: %w; next: %s limits record claude --help", err, root.InvocationCommand())
				all = append(all, unavailableLimits(vendor, "recorded", err)...)
				continue
			}
			all = append(all, limits...)
			continue
		}
		if spec.limitsMode == vendorLimitsLedger {
			continue
		}
		b, err := os.ReadFile(filepath.Join(state, "limits", vendor+".json"))
		var limits []VendorLimit
		if err == nil {
			var cache struct {
				At     time.Time     `json:"at"`
				Limits []VendorLimit `json:"limits"`
			}
			if json.Unmarshal(b, &cache) == nil && len(cache.Limits) > 0 {
				limits = cache.Limits
			}
		}
		recorded, active, recordedErr := newVendorLimitStateStore(state, time.Now).Active(vendor)
		if recordedErr != nil {
			all = append(all, unavailableLimits(vendor, "recorded", recordedErr)...)
			continue
		}
		if active {
			limits = append(limits, recorded)
		}
		if len(limits) == 0 {
			err = fmt.Errorf("no cached Codex usage; next: %s limits --state %s", root.InvocationCommand(), shellQuote(state))
			all = append(all, unavailableLimits(vendor, "cache", err)[0])
			continue
		}
		all = append(all, limits...)
	}
	return all
}

type contextLimitProvider struct {
	ctx     context.Context
	adapter limitsProvider
}

func (p contextLimitProvider) Limits(context.Context) ([]VendorLimit, error) {
	return p.adapter.Limits(p.ctx)
}
func defaultRunnerState() string {
	if value := os.Getenv("KBLABS_RUNNER_STATE"); value != "" {
		return value
	}
	if value := os.Getenv("XDG_STATE_HOME"); value != "" {
		return filepath.Join(value, "kb-runner")
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "kb-runner-state")
	}
	return filepath.Join(config, "kb-runner")
}

func limitsCommand(root runnerRoot, args []string, out, errOut io.Writer) (int, error) {
	if len(args) > 0 && args[0] == "record" {
		return limitsRecordCommand(root, args[1:], out)
	}
	return limitsCommandWithProviderFactory(root, args, out, errOut, newLimitsProvider)
}

func limitsRecordCommand(root runnerRoot, args []string, out io.Writer) (int, error) {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") || len(args) == 0 {
		ledgerMode := vendorLimitsLedger
		_, err := fmt.Fprintf(out, "Usage: %s limits record claude --state <dir> --session <pct> --session-resets <duration|local-time> --weekly <pct> --weekly-resets <local-time|weekday-time> | %s limits record <%s> --state <dir> --grant <tokens[K|M|B]>\n", root.Name(), root.Name(), strings.Join(vendorNamesFor(&ledgerMode), "|"))
		return 0, err
	}
	if spec, ok := vendorRegistry[args[0]]; ok && spec.limitsMode == vendorLimitsLedger {
		return limitsRecordVendorGrantCommand(root, args[0], args[1:], out)
	}
	if args[0] != "claude" {
		return 2, fmt.Errorf("%s limits record: supported records are Claude readings and grants for ledger vendors; next: %s limits record --help", root.Name(), root.InvocationCommand())
	}
	if len(args) == 2 && (args[1] == "--help" || args[1] == "-h") {
		_, err := fmt.Fprintf(out, "Usage: %s limits record claude --state <dir> --session <pct> --session-resets <duration|local-time> --weekly <pct> --weekly-resets <local-time|weekday-time>\n", root.Name())
		return 0, err
	}
	fs := flag.NewFlagSet("limits record claude", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	state := fs.String("state", defaultRunnerState(), "runner state directory")
	session := fs.Float64("session", -1, "session usage percent")
	sessionResets := fs.String("session-resets", "", "session reset duration or local date/time")
	weekly := fs.Float64("weekly", -1, "weekly usage percent")
	weeklyResets := fs.String("weekly-resets", "", "weekly local date/time or weekday and time")
	if err := fs.Parse(args[1:]); err != nil {
		return 2, fmt.Errorf("%s limits record claude: %w; next: %s limits record claude --help", root.Name(), err, root.InvocationCommand())
	}
	if len(fs.Args()) != 0 || *session < 0 || *weekly < 0 || *sessionResets == "" || *weeklyResets == "" {
		return 2, fmt.Errorf("%s limits record claude: provide --session, --session-resets, --weekly, and --weekly-resets; next: %s limits record claude --help", root.Name(), root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "limits record claude", *state)
	if err != nil {
		return 2, err
	}
	*state = resolvedState
	store := newClaudeReadingStore(*state, time.Now, time.Local)
	if err := store.Record(*session, *sessionResets, *weekly, *weeklyResets); err != nil {
		var saveErr claudeReadingWriteError
		if errors.As(err, &saveErr) {
			return 1, fmt.Errorf("%s limits record claude: %w; next: ls -ld %s %s", root.InvocationCommand(), err, shellQuote(filepath.Dir(saveErr.directory)), shellQuote(saveErr.directory))
		}
		return 1, fmt.Errorf("%s limits record claude: %w; next: %s limits record claude --help", root.InvocationCommand(), err, root.InvocationCommand())
	}
	if _, err := fmt.Fprintf(out, "Recorded Claude usage: session %.1f%%, weekly %.1f%%\n", *session, *weekly); err != nil {
		return 1, fmt.Errorf("%s limits record claude: write confirmation: %w", root.Name(), err)
	}
	return 0, nil
}

func limitsRecordVendorGrantCommand(root runnerRoot, vendor string, args []string, out io.Writer) (int, error) {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		_, err := fmt.Fprintf(out, "Usage: %s limits record %s --state <dir> --grant <tokens[K|M|B]>\n", root.Name(), vendor)
		return 0, err
	}
	fs := flag.NewFlagSet("limits record "+vendor, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	state := fs.String("state", defaultRunnerState(), "runner state directory")
	grant := fs.String("grant", "", "total token grant (integer, K, M, or B)")
	if err := fs.Parse(args); err != nil {
		return 2, fmt.Errorf("%s limits record %s: %w; next: %s limits record %s --help", root.Name(), vendor, err, root.InvocationCommand(), vendor)
	}
	if len(fs.Args()) != 0 || *grant == "" {
		return 2, fmt.Errorf("%s limits record %s: provide --grant; next: %s limits record %s --help", root.Name(), vendor, root.InvocationCommand(), vendor)
	}
	resolvedState, err := resolveRunnerState(root, "limits record "+vendor, *state)
	if err != nil {
		return 2, err
	}
	*state = resolvedState
	recorded, err := newVendorGrantStore(*state, vendor, time.Now).Record(*grant)
	if err != nil {
		return 1, fmt.Errorf("%s limits record %s: %w; next: %s limits record %s --help", root.Name(), vendor, err, root.InvocationCommand(), vendor)
	}
	if _, err := fmt.Fprintf(out, "Recorded %s token grant: %d tokens\n", vendor, recorded.Tokens); err != nil {
		return 1, err
	}
	return 0, nil
}

type limitsProviderFactory func(string) (limitsProvider, error)

func limitsCommandWithProviderFactory(root runnerRoot, args []string, out, errOut io.Writer, providerFactory limitsProviderFactory) (int, error) {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		ledgerMode := vendorLimitsLedger
		_, err := fmt.Fprintf(out, "Usage: %s limits [--state <dir>] [--json] [--capture <dir>] | %s limits record claude ... | %s limits record <%s> --state <dir> --grant <tokens[K|M|B]>\n", root.Name(), root.Name(), root.Name(), strings.Join(vendorNamesFor(&ledgerMode), "|"))
		return 0, err
	}
	fs := flag.NewFlagSet("limits", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	state := fs.String("state", defaultRunnerState(), "runner state directory")
	asJSON := fs.Bool("json", false, "write JSON")
	ttl := fs.Duration("ttl", time.Minute, "cached result lifetime")
	captureDir := fs.String("capture", "", "write redacted per-source diagnostics to this directory")
	if err := fs.Parse(args); err != nil {
		return 2, err
	}
	resolvedState, err := resolveRunnerState(root, "limits", *state)
	if err != nil {
		return 2, err
	}
	*state = resolvedState
	all := []VendorLimit{}
	var captureFailures []error
	for _, vendor := range vendors() {
		spec := vendorRegistry[vendor]
		if spec.limitsMode == vendorLimitsRecorded {
			limits, _, err := newClaudeReadingStore(*state, time.Now, time.Local).Limits()
			if err != nil {
				err = fmt.Errorf("Claude usage has no current recorded reading: %w; next: %s limits record claude --help", err, root.InvocationCommand())
				all = append(all, unavailableLimits(vendor, "recorded", err)...)
				continue
			}
			all = append(all, limits...)
			continue
		}
		if spec.limitsMode == vendorLimitsLedger {
			jobs, err := newJobStore(*state).List()
			if err != nil {
				all = append(all, unavailableLimits(vendor, "ledger", err)...)
				continue
			}
			limit, err := vendorSpendLimit(vendor, *state, jobs)
			if err != nil {
				all = append(all, unavailableLimits(vendor, "ledger", err)...)
				continue
			}
			all = append(all, limit)
			continue
		}
		provider, createErr := providerFactory(vendor)
		if createErr != nil {
			all = append(all, unavailableLimits(vendor, "adapter", createErr)...)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if *captureDir != "" {
			ctx = withLimitsCapture(ctx, *captureDir)
		}
		var cached []VendorLimit
		var sourceErr error
		if *captureDir != "" {
			cached, sourceErr = contextLimitProvider{ctx: ctx, adapter: provider}.Limits(ctx)
		} else {
			cached, sourceErr = cachedLimits(filepath.Join(*state, "limits", vendor+".json"), *ttl, contextLimitProvider{ctx: ctx, adapter: provider}, time.Now)
		}
		cancel()
		cached, recordedErr := limitsWithRecordedVendorState(cached, newVendorLimitStateStore(*state, time.Now), vendor)
		if recordedErr != nil {
			sourceErr = errors.Join(sourceErr, fmt.Errorf("read recorded vendor limit: %w", recordedErr))
		}
		if sourceErr != nil {
			if *captureDir == "" {
				all = append(all, unavailableLimits(vendor, "provider", sourceErr)...)
			} else {
				captureFailures = append(captureFailures, sourceErr)
			}
		}
		all = append(all, cached...)
	}
	if *asJSON {
		if err := json.NewEncoder(out).Encode(all); err != nil {
			return 1, err
		}
		if len(captureFailures) > 0 {
			return 1, fmt.Errorf("limits capture failed: %w", errors.Join(captureFailures...))
		}
		return 0, nil
	}
	for _, l := range all {
		if l.Spend != nil {
			if _, err := fmt.Fprintln(out, formatVendorSpend(l.Vendor, *l.Spend)); err != nil {
				return 1, err
			}
			continue
		}
		if _, err := fmt.Fprintf(out, "%-8s %-8s %6.1f%% %-12s %s %s", l.Vendor, l.Window, l.UsedPercent, l.Confidence, l.Source, l.Error); err != nil {
			return 1, err
		}
		if l.Age != "" {
			if _, err := fmt.Fprintf(out, " age=%s", l.Age); err != nil {
				return 1, err
			}
		}
		if l.Stale {
			if _, err := fmt.Fprint(out, " stale=true"); err != nil {
				return 1, err
			}
		}
		if _, err := fmt.Fprintln(out); err != nil {
			return 1, err
		}
		if l.Pace != nil && l.Window == "week" {
			if _, err := fmt.Fprintln(out, formatClaudePace(*l.Pace)); err != nil {
				return 1, err
			}
		}
		for _, attempt := range l.Attempts {
			if _, err := fmt.Fprintf(out, "  source=%s outcome=%s duration=%dms error=%s\n", attempt.Source, attempt.Outcome, attempt.DurationMS, attempt.Error); err != nil {
				return 1, err
			}
		}
	}
	if len(captureFailures) > 0 {
		return 1, fmt.Errorf("limits capture failed: %w", errors.Join(captureFailures...))
	}
	return 0, nil
}

func agentWaitCommand(root runnerRoot, args []string, out, errOut io.Writer) (int, error) {
	fs := flag.NewFlagSet("wait", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	any := fs.Bool("any", false, "wait for first selected job")
	all := fs.Bool("all", false, "wait for every selected job")
	state := fs.String("state", defaultRunnerState(), "runner state directory")
	since := fs.String("since", "", "acknowledgement cursor returned by a previous wait")
	asJSON := fs.Bool("json", false, "write JSON")
	if err := fs.Parse(args); err != nil {
		return 2, err
	}
	if *any == *all || len(fs.Args()) == 0 {
		return 2, fmt.Errorf("%s wait: choose --any or --all and name at least one job or stream; next: %s wait --help", root.Name(), root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "wait", *state)
	if err != nil {
		return 2, err
	}
	*state = resolvedState
	store := newJobStore(*state)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for {
		jobs, cursor, err := store.Wait(fs.Args(), *all, *since)
		if err != nil {
			return 1, err
		}
		if len(jobs) > 0 {
			if *asJSON {
				return 0, json.NewEncoder(out).Encode(struct {
					Jobs   []Job  `json:"jobs"`
					Cursor string `json:"cursor"`
				}{jobs, cursor})
			}
			for _, j := range jobs {
				if _, err := fmt.Fprintf(out, "%s\t%s\t%s\t%s\t%s\n", j.ID, j.State, j.Phase, j.Reason, cursor); err != nil {
					return 1, err
				}
			}
			return 0, nil
		}
		select {
		case <-ctx.Done():
			return 1, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}
