import json
import unittest
from subprocess import CompletedProcess

from secured_execution_steps import (
    check_secured_cli_execution_modes,
    run_selected_secured_cli_execution_check,
)


def success(data):
    return CompletedProcess([], 0, json.dumps({"ok": True, "data": data}), "")


class SecuredExecutionStepsTest(unittest.TestCase):
    # case: S-306.1
    def test_unselected_secured_backend_check_does_not_mutate_configuration(self):
        calls = []

        selected, failure = run_selected_secured_cli_execution_check(
            mode="secured",
            selection_active=True,
            selected_claims={"S-268.1"},
            check=lambda: calls.append("executed") or None,
        )

        self.assertFalse(selected)
        self.assertIsNone(failure)
        self.assertEqual(calls, [])

    # case: S-306.1
    def test_full_or_selected_run_executes_secured_backend_check(self):
        for selection_active, claims in ((False, set()), (True, {"S-306.1"})):
            with self.subTest(selection_active=selection_active, claims=claims):
                calls = []
                selected, failure = run_selected_secured_cli_execution_check(
                    mode="secured",
                    selection_active=selection_active,
                    selected_claims=claims,
                    check=lambda: calls.append("executed") or "fixture failure",
                )
                self.assertTrue(selected)
                self.assertEqual(failure, "fixture failure")
                self.assertEqual(calls, ["executed"])

    # case: S-306.1
    def test_both_secured_backends_execute_and_prior_mode_is_restored(self):
        calls = []

        def invoke(args):
            calls.append(args)
            if args[:2] == ["config", "get"]:
                return success({"found": True, "value": "auto"})
            if args[:2] == ["config", "set"]:
                return success({})
            if args[:2] == ["info", "health"]:
                mode = calls[-2][5]
                return success({"components": [{"id": "execution", "details": {"executionMode": mode}}]})
            if args[:2] == ["commit", "commit"]:
                return success({"status": "dry-run"})
            raise AssertionError(args)

        anonymous = []
        def invoke_without_session(args):
            anonymous.append(args)
            return CompletedProcess(args, 1, json.dumps({"ok": False, "error": {
                "code": "KB_AUTH_REQUIRED", "message": "login required"}}), "")

        self.assertIsNone(check_secured_cli_execution_modes(invoke, invoke_without_session))
        self.assertEqual([args[5] for args in calls if args[:2] == ["config", "set"]],
                         ["subprocess", "worker-pool", "auto"])
        self.assertEqual(sum(args[:2] == ["commit", "commit"] for args in calls), 2)
        self.assertEqual(anonymous, [["commit", "commit", "--dry-run", "--json"]])

    # case: S-306.1
    def test_failed_backend_does_not_claim_success_and_still_restores(self):
        calls = []

        def invoke(args):
            calls.append(args)
            if args[:2] == ["config", "get"]:
                return success({"found": True, "value": "subprocess"})
            if args[:2] == ["config", "set"]:
                return success({})
            if args[:2] == ["info", "health"]:
                return success({"components": [{"id": "execution", "details": {"executionMode": calls[-2][5]}}]})
            return CompletedProcess(args, 1, json.dumps({"ok": False, "error": {
                "code": "KB_RUNTIME_EXECUTION_HOST_UNAVAILABLE", "message": "no host"}}), "")

        failure = check_secured_cli_execution_modes(invoke, lambda args: success({}))
        self.assertIn("subprocess", failure)
        self.assertIn("KB_RUNTIME_EXECUTION_HOST_UNAVAILABLE", failure)
        self.assertEqual(calls[-1][5], "subprocess")

    # case: S-306.1
    def test_anonymous_success_is_failure_and_still_restores(self):
        calls = []
        def invoke(args):
            calls.append(args)
            if args[:2] == ["config", "get"]:
                return success({"found": False, "value": None})
            if args[:2] == ["info", "health"]:
                return success({"components": [{"id": "execution", "details": {
                    "executionMode": calls[-2][5]}}]})
            return success({})

        failure = check_secured_cli_execution_modes(invoke, lambda args: success({}))
        self.assertIn("unauthenticated", failure)
        self.assertEqual(calls[-1][5], "auto")


if __name__ == "__main__":
    unittest.main()
