from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from runner import (
    ProjectBRootInvalid,
    ProjectBRootValid,
    invalidate_project_b_handoff,
    outer_selection_groups,
    project_b_fixture_from_state,
    validate_project_b_root,
)
from service_steps import FlowGraph, Journey


class ProjectFixtureStateTests(unittest.TestCase):
    def test_missing_project_b_fixture_state_is_optional_at_runner_boundary(self):
        graph = FlowGraph(Journey("local", "missing-project-b-fixture"), {})
        result = project_b_fixture_from_state(graph)
        self.assertIsInstance(result, ProjectBRootInvalid)
        self.assertEqual(result.diagnostic["code"], "PROJECT_B_ROOT_INVALID")
        self.assertEqual(result.diagnostic["serializedValue"], None)

    def test_project_b_fixture_values_are_read_from_established_state(self):
        with TemporaryDirectory(prefix="kb-project-b-state-") as directory:
            value = {"projectBId": "prj_project_b", "projectBRoot": directory}
            graph = FlowGraph(Journey("local", "registered-project-b-fixture"), {}, states={
                "fixtures-installed": {"passed": True, "evidence": "registered fixture project", "value": value},
            })
            result = project_b_fixture_from_state(graph)
        self.assertIsInstance(result, ProjectBRootValid)
        self.assertEqual(result.project_id, value["projectBId"])
        self.assertEqual(result.root.resolve(), Path(value["projectBRoot"]).resolve())

    def test_project_b_handoff_rejects_unwritable_root_with_one_structured_diagnostic(self):
        with TemporaryDirectory(prefix="kb-project-b-handoff-") as directory:
            with patch("runner.os.access", return_value=False):
                result = validate_project_b_root("prj_project_b", directory)

        self.assertIsInstance(result, ProjectBRootInvalid)
        diagnostic = result.diagnostic
        self.assertEqual(diagnostic["code"], "PROJECT_B_ROOT_INVALID")
        self.assertEqual(diagnostic["serializedValue"], directory)
        self.assertEqual(diagnostic["realpath"], str(Path(directory).resolve()))
        self.assertIsInstance(diagnostic["mode"], int)
        self.assertEqual(set(diagnostic["owner"]), {"uid", "gid"})
        self.assertEqual(diagnostic["reason"], "not writable")

    def test_project_b_handoff_reports_missing_root_as_structured_diagnostic(self):
        missing = "/tmp/kb-project-b-does-not-exist"
        result = validate_project_b_root("prj_project_b", missing)

        self.assertIsInstance(result, ProjectBRootInvalid)
        diagnostic = result.diagnostic
        self.assertEqual(diagnostic["serializedValue"], missing)
        self.assertIsNone(diagnostic["realpath"])
        self.assertIsNone(diagnostic["mode"])
        self.assertIsNone(diagnostic["owner"])

    def test_invalid_handoff_blocks_studio_claims_with_diagnostic_without_calling_consumer(self):
        graph = FlowGraph(Journey("local", "invalid-project-b-studio"), {
            "studio": ("fixtures-installed",),
        }, states={"fixtures-installed": {"passed": True, "evidence": "fixture installed"}})
        handoff = validate_project_b_root("prj_project_b", "")
        self.assertIsInstance(handoff, ProjectBRootInvalid)
        invalidate_project_b_handoff(graph, handoff)
        consumer_calls = []
        claims = ["studio-case"]

        status = graph.flow(
            "Studio browser journey", "studio", "studio", None,
            cases=claims,
            case_action=lambda _case_ids: consumer_calls.append("Studio received root"),
        )

        self.assertEqual(status, "BLOCKED")
        self.assertEqual(consumer_calls, [])
        blocked = graph.journey.steps[-1]
        self.assertEqual(blocked.status, "BLOCKED")
        self.assertEqual(tuple(blocked.cases), tuple(claims))
        self.assertIn('"code": "PROJECT_B_ROOT_INVALID"', blocked.message)
        self.assertIn('"serializedValue": ""', blocked.message)

    def test_invalid_handoff_blocks_update_variant_claims_with_diagnostic_without_calling_consumer(self):
        graph = FlowGraph(Journey("local", "invalid-project-b-update-variants"), {
            "update-variants": ("fixtures-installed",),
        }, states={"fixtures-installed": {"passed": True, "evidence": "fixture installed"}})
        handoff = validate_project_b_root("prj_project_b", "")
        self.assertIsInstance(handoff, ProjectBRootInvalid)
        invalidate_project_b_handoff(graph, handoff)
        consumer_calls = []
        claims = list(outer_selection_groups()["update-variants"]["cases"])

        if isinstance(handoff, ProjectBRootValid):
            action = lambda: consumer_calls.append("update variants received root")
        else:
            action = lambda: handoff.diagnostic
        status = graph.flow(
            "platform update variant prerequisites", "update-variants", "platform.update",
            action, cases=claims,
        )

        self.assertEqual(status, "BLOCKED")
        self.assertEqual(consumer_calls, [])
        blocked = graph.journey.steps[-1]
        self.assertEqual(blocked.status, "BLOCKED")
        self.assertEqual(tuple(blocked.cases), tuple(claims))
        self.assertIn('"code": "PROJECT_B_ROOT_INVALID"', blocked.message)
        self.assertIn('"serializedValue": ""', blocked.message)


if __name__ == "__main__":
    unittest.main()
