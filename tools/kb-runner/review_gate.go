//go:build darwin || linux

package main

import (
	"fmt"
	"strings"
)

type schedulerReviewGateResult struct {
	Missing  []string
	Skipped  []schedulerReviewerSlot
	Rejected []string
	Accepted []string
}

type schedulerReviewerSlot struct {
	Key    string
	Vendor string
}

func schedulerReviewerSlots(task SchedulerTask) []schedulerReviewerSlot {
	reviewers := normalizeSchedulerReviewers(task)
	if task.Review == "single" && len(reviewers) > 1 {
		reviewers = reviewers[:1]
	}
	slots := make([]schedulerReviewerSlot, 0, len(reviewers))
	for index, vendor := range reviewers {
		key := vendor
		if len(reviewers) > 1 {
			key = fmt.Sprintf("%s-%d", vendor, index+1)
		}
		slots = append(slots, schedulerReviewerSlot{Key: key, Vendor: vendor})
	}
	return slots
}

func schedulerReviewGate(task SchedulerTask, stream SchedulerStream) schedulerReviewGateResult {
	result := schedulerReviewGateResult{}
	for _, slot := range schedulerReviewerSlots(task) {
		switch stream.ReviewResults[slot.Key] {
		case "ACCEPT":
			result.Accepted = append(result.Accepted, slot.Key)
		case "SKIP":
			result.Skipped = append(result.Skipped, slot)
		case "REJECT":
			result.Rejected = append(result.Rejected, slot.Key)
		default:
			result.Missing = append(result.Missing, slot.Key)
		}
	}
	return result
}

func (result schedulerReviewGateResult) allowsLand() bool {
	return len(result.Missing) == 0 && len(result.Skipped) == 0 && len(result.Rejected) == 0 && len(result.Accepted) > 0
}

func (result schedulerReviewGateResult) refusal() string {
	switch {
	case len(result.Skipped) > 0:
		keys := make([]string, 0, len(result.Skipped))
		for _, slot := range result.Skipped {
			keys = append(keys, slot.Key)
		}
		return "review unavailable: " + strings.Join(keys, ", ") + " skipped"
	case len(result.Missing) > 0:
		return "review missing: " + strings.Join(result.Missing, ", ")
	case len(result.Rejected) > 0:
		return "review rejected: " + strings.Join(result.Rejected, ", ")
	default:
		return "review policy has no required reviewers"
	}
}
