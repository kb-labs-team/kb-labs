#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PYTHONPATH="$ROOT/e2e/journey${PYTHONPATH:+:$PYTHONPATH}"

node scripts/ci/journey-case-claims-preflight.mjs
node --test scripts/ci/journey-case-claims-preflight.test.mjs

python3 -m unittest \
  test_dispatch_registry.DispatchRegistryTests.test_full_unselected_plan_matches_checked_in_golden \
  test_case_selection.CaseJourneySelectionTests.test_commit_default_and_registry_lane_step_graphs_are_disjoint \
  test_case_selection.CaseJourneySelectionTests.test_selects_only_entry_points_with_active_release_journey_claims \
  test_case_selection.CaseJourneySelectionTests.test_partial_batch_filters_claims_owned_by_different_modes \
  test_case_selection.CaseJourneySelectionTests.test_partial_batch_keeps_all_same_mode_claim_owners \
  test_case_selection.CaseJourneySelectionTests.test_resolves_cases_and_steps_from_the_qa_claim_registry \
  test_case_selection.CaseJourneySelectionTests.test_case_selection_refuses_unclaimed_steps_before_runner_start \
  test_case_selection.CaseJourneySelectionTests.test_only_filters_resolved_runners_and_reports_omitted_owners
