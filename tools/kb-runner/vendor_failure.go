//go:build darwin || linux

package main

import (
	"strconv"
	"strings"
	"time"
)

// failureClass is the resume decision for one provider failure: transient
// failures resume the same vendor session, permanent failures end the job,
// opaque failures (no structured class) end the job without a retry.
type failureClass uint8

const (
	failureUnrelated failureClass = iota
	failureTransient
	failurePermanent
	failureOpaque
)

// vendorFailure is the classified outcome of one provider failure.
type vendorFailure struct {
	class   failureClass
	reason  JobReason
	resetAt *time.Time
	message string
}

var (
	unrelatedFailure            = vendorFailure{class: failureUnrelated}
	transientRateLimitFailure   = vendorFailure{class: failureTransient, reason: ReasonRateLimited}
	transientUnreachableFailure = vendorFailure{class: failureTransient, reason: ReasonProviderUnreachable}
	permanentAuthFailure        = vendorFailure{class: failurePermanent, reason: ReasonAuthExpired}
	permanentVendorFailure      = vendorFailure{class: failurePermanent, reason: ReasonVendorError}
	opaqueVendorFailure         = vendorFailure{class: failureOpaque, reason: ReasonVendorError}
)

// Failure texts a vendor emits when it carries no structured code. Ordered by
// specificity; the first matching list wins.
var (
	failureRateLimitPhrases = []string{"rate limit", "usage limit", "capacity", "concurrency"}
	failureAuthPhrases      = []string{"authentication", "unauthorized", "token expired"}
	failureNetworkPhrases   = []string{"timed out", "timeout", "connection refused", "network is unreachable", "network connection failed", "dns"}
)

// vendorFailureTable classifies one vendor's provider failures. It is the
// single classification owner: structured provider codes and HTTP statuses are
// consulted first, then the coarse event kinds the vendor parser emits, and
// only then the vendor's failure text — never when a structured code exists.
type vendorFailureTable struct {
	// transientCodes and permanentCodes map provider business codes the vendor
	// emits in structured event fields (ZCode attribution.providerErrorCode).
	transientCodes map[string]vendorFailure
	permanentCodes map[string]vendorFailure
	// events classify the coarse kinds the vendor parser emits; text-only
	// vendors (codex, claude) classify through this map.
	events map[EventKind]vendorFailure
	// networkPhrases classify failure text that carries no structured code.
	networkPhrases []string
}

// classify maps one vendor stream event to its failure class.
func (t vendorFailureTable) classify(event VendorEvent) vendorFailure {
	return t.classifyAt(event, time.Now(), time.Local)
}

func (t vendorFailureTable) classifyAt(event VendorEvent, now time.Time, location *time.Location) vendorFailure {
	failure := t.classifyWithoutReset(event)
	if failure.reason == ReasonRateLimited {
		failure.message = event.Message
		failure.resetAt, _ = parseCodexResetAt(event.Message, now, location)
	}
	return failure
}

func (t vendorFailureTable) classifyWithoutReset(event VendorEvent) vendorFailure {
	if event.ProviderCode != "" {
		if failure, ok := t.transientCodes[event.ProviderCode]; ok {
			return failure
		}
		if failure, ok := t.permanentCodes[event.ProviderCode]; ok {
			return failure
		}
	}
	if failure, ok := classifyProviderStatus(event.StatusCode); ok {
		return failure
	}
	if event.FailureSource == "network" {
		return transientUnreachableFailure
	}
	if failure, ok := t.events[event.Kind]; ok {
		return failure
	}
	if event.Kind != EventVendorError {
		return unrelatedFailure
	}
	if matchAnyPhrase(event.Message, t.networkPhrases) {
		return transientUnreachableFailure
	}
	return opaqueVendorFailure
}

// classifyStderr applies the table to the diagnostic text a vendor writes on
// exit when its event stream carried no failure event. Label-anchored
// structured tokens (provider code, HTTP status) are matched before phrases.
func (t vendorFailureTable) classifyStderr(stderr string) (vendorFailure, bool) {
	return t.classifyStderrAt(stderr, time.Now(), time.Local)
}

func (t vendorFailureTable) classifyStderrAt(stderr string, now time.Time, location *time.Location) (vendorFailure, bool) {
	for code, failure := range t.transientCodes {
		if matchLabeledCode(stderr, code) {
			return failure, true
		}
	}
	for code, failure := range t.permanentCodes {
		if matchLabeledCode(stderr, code) {
			return failure, true
		}
	}
	for _, token := range labeledStatusTokens(stderr) {
		if failure, ok := classifyProviderStatus(token); ok {
			return failure, true
		}
	}
	if matchAnyPhrase(stderr, failureRateLimitPhrases) {
		failure := transientRateLimitFailure
		failure.message = stderr
		failure.resetAt, _ = parseCodexResetAt(stderr, now, location)
		return failure, true
	}
	if matchAnyPhrase(stderr, failureAuthPhrases) {
		return permanentAuthFailure, true
	}
	if matchAnyPhrase(stderr, t.networkPhrases) {
		return transientUnreachableFailure, true
	}
	return vendorFailure{}, false
}

func parseCodexResetAt(message string, now time.Time, location *time.Location) (*time.Time, bool) {
	if location == nil || now.IsZero() {
		return nil, false
	}
	const marker = "try again at "
	lower := strings.ToLower(message)
	index := strings.LastIndex(lower, marker)
	if index < 0 {
		return nil, false
	}
	fields := strings.Fields(strings.TrimSpace(message[index+len(marker):]))
	if len(fields) < 2 {
		return nil, false
	}
	parsed, err := time.ParseInLocation("3:04 PM", strings.Join(fields[:2], " "), location)
	if err != nil {
		return nil, false
	}
	localNow := now.In(location)
	year, month, day := localNow.Date()
	reset := time.Date(year, month, day, parsed.Hour(), parsed.Minute(), 0, 0, location)
	if !reset.After(localNow) {
		reset = reset.AddDate(0, 0, 1)
	}
	return &reset, true
}

// classifyProviderStatus maps an HTTP status a vendor reports for a failed
// provider request. 5xx and 429 are transient; auth and invalid-request
// statuses are permanent.
func classifyProviderStatus(status int) (vendorFailure, bool) {
	switch {
	case status == 429:
		return transientRateLimitFailure, true
	case status == 401 || status == 403:
		return permanentAuthFailure, true
	case status == 400 || status == 404 || status == 422:
		return permanentVendorFailure, true
	case status >= 500:
		return transientUnreachableFailure, true
	}
	return vendorFailure{}, false
}

func matchAnyPhrase(text string, phrases []string) bool {
	lower := strings.ToLower(text)
	if lower == "" {
		return false
	}
	for _, phrase := range phrases {
		if strings.Contains(lower, phrase) {
			return true
		}
	}
	return false
}

// matchLabeledCode reports whether stderr names this provider code through one
// of the labels vendors use in their diagnostics. Bare numbers never match,
// and the code must end at the token boundary.
func matchLabeledCode(stderr, code string) bool {
	lower := strings.ToLower(stderr)
	for _, label := range []string{"provider code", "provider_code", "providercode"} {
		for _, separator := range []string{" ", "=", ":"} {
			prefix := label + separator + code
			index := strings.Index(lower, prefix)
			for index >= 0 {
				end := index + len(prefix)
				if end >= len(lower) || !isDigit(lower[end]) {
					return true
				}
				next := strings.Index(lower[end:], prefix)
				if next < 0 {
					return false
				}
				index = end + next
			}
		}
	}
	return false
}

func isDigit(value byte) bool { return value >= '0' && value <= '9' }

// labeledStatusTokens extracts HTTP statuses from label-anchored stderr tokens
// such as "responseStatus 429", "statusCode=502", or "status: 503".
func labeledStatusTokens(stderr string) []int {
	tokens := []int{}
	for _, label := range []string{"responsestatus", "statuscode", "status"} {
		rest := strings.ToLower(stderr)
		for {
			index := strings.Index(rest, label)
			if index < 0 {
				break
			}
			rest = rest[index+len(label):]
			rest = strings.TrimLeft(rest, " :=")
			digits := 0
			for digits < len(rest) && rest[digits] >= '0' && rest[digits] <= '9' {
				digits++
			}
			if digits == 3 {
				if status, err := strconv.Atoi(rest[:digits]); err == nil {
					tokens = append(tokens, status)
				}
			}
			rest = rest[min(digits, len(rest)):]
		}
	}
	return tokens
}

// textStreamFailureTable classifies vendors whose stream carries no structured
// failure fields (codex, claude): the parser's coarse kinds and the failure
// text are all the vendor emits.
var textStreamFailureTable = vendorFailureTable{
	events: map[EventKind]vendorFailure{
		EventRateLimited:         transientRateLimitFailure,
		EventAuthExpired:         permanentAuthFailure,
		EventProviderUnreachable: transientUnreachableFailure,
	},
	networkPhrases: failureNetworkPhrases,
}

// zcodeFailureTable classifies ZCode turn failures from the structured fields
// its stream events emit (payload.error.attribution). Provider codes follow
// the vendor's own business-code surface: concurrency limits are transient at
// the session level (the session survives and resumes once the competing job
// finishes), while quota exhaustion, auth, and invalid-request codes end the
// job.
var zcodeFailureTable = vendorFailureTable{
	transientCodes: map[string]vendorFailure{
		"3008": transientRateLimitFailure, // model concurrency limit
		"3009": transientRateLimitFailure, // model concurrency limit (x151 evidence)
		"3010": transientRateLimitFailure, // current-model concurrency limit
		"1302": transientRateLimitFailure,
		"1303": transientRateLimitFailure,
		"1305": transientRateLimitFailure,
		"3002": transientRateLimitFailure,
		"500":  transientUnreachableFailure, // provider-wrapped server error
		"1120": transientUnreachableFailure,
		"1230": transientUnreachableFailure,
		"1234": transientUnreachableFailure, // provider-wrapped network failure
		"1312": transientUnreachableFailure, // provider overload
		"2007": transientUnreachableFailure,
	},
	permanentCodes: map[string]vendorFailure{
		"1006":  permanentAuthFailure,   // account authorization
		"3007":  permanentAuthFailure,   // provider authentication
		"1005":  permanentVendorFailure, // quota exhausted
		"3001":  permanentVendorFailure, // invalid request
		"3006":  permanentVendorFailure, // model not found
		"1113":  permanentVendorFailure,
		"1304":  permanentVendorFailure, // terminal rate limit (window quota)
		"1308":  permanentVendorFailure,
		"1309":  permanentVendorFailure,
		"1310":  permanentVendorFailure,
		"1311":  permanentVendorFailure,
		"1313":  permanentVendorFailure,
		"1316":  permanentVendorFailure,
		"1317":  permanentVendorFailure,
		"1318":  permanentVendorFailure,
		"1319":  permanentVendorFailure,
		"1320":  permanentVendorFailure,
		"1321":  permanentVendorFailure,
		"2056":  permanentVendorFailure, // credit balance exhausted
		"20097": permanentVendorFailure,
	},
	networkPhrases: failureNetworkPhrases,
}
