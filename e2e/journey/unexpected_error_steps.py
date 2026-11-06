"""Installed CLI checks for correlated plugin handler failure diagnostics."""
from __future__ import annotations

import json
import secrets
import shutil
from pathlib import Path
from typing import Mapping

from invocations import (
    catalogued_error_hint,
    logs_from_query_envelope,
    parse_error_correlation_id,
    run_command,
)
import redaction


_ERROR_FIXTURE = Path(__file__).parent / 'fixtures/plugin-error/package.json'
_ERROR_CODE = 'KB_PLUGIN_COMMAND_FAILED'
_ERROR_COMMAND = ['journey-error', 'throw']


def run_unexpected_error_steps(journey, *, mode: str, env: Mapping[str, str]) -> None:
    cli = env.get('KB_JOURNEY_CLI_PATH', '')
    platform_root = env.get('KB_JOURNEY_PLATFORM_ROOT', '')
    if not cli or not platform_root:
        journey.step("unexpected CLI trail", "cli", lambda: "BLOCKED: installed CLI and platform root are required",
                     cases=["S-203.26"])
        return

    fixture_package = json.loads(_ERROR_FIXTURE.read_text(encoding='utf-8'))['name']
    installed = False
    correlated_records: list[dict[str, object]] = []

    def install_fixture() -> str | None:
        nonlocal installed
        result = run_command(
            [cli, 'marketplace', 'install', fixture_package, '--scope', 'platform', '--json'],
            cwd=platform_root, env=env, capture_output=True, text=True, check=False, timeout=120,
        )
        if result.returncode != 0:
            return f"failed to install {fixture_package}: marketplace install exited {result.returncode}"
        installed = True
        return None

    secret = secrets.token_urlsafe(24)

    def verify_state(host_state: str) -> str | None:
        if host_state == 'host-running' and not installed:
            install_error = install_fixture()
            if install_error:
                return install_error
        if not installed:
            return f"{mode} {host_state} plugin failure fixture was not installed"
        for output_mode, args in (
            ('json', ['--json']),
            ('human', []),
        ):
            failed = run_command(
                [cli, *_ERROR_COMMAND, '--secret', secret, *args],
                cwd=platform_root, env=env, capture_output=True, text=True,
                check=False, timeout=120,
            )
            is_expected_failure, correlation_id = parse_error_correlation_id(
                failed.stdout, failed.stderr, expected_code=_ERROR_CODE,
            )
            if failed.returncode == 0 or not is_expected_failure:
                return f"{mode} {host_state} plugin command {output_mode} did not return {_ERROR_CODE}"
            if correlation_id is None:
                return f"{mode} {host_state} {output_mode} error omitted its correlation ID"
            expected_hint = catalogued_error_hint(_ERROR_CODE, correlationId=correlation_id)
            safe_output = failed.stdout + failed.stderr
            if secret in safe_output:
                return f"{mode} {host_state} {output_mode} failure exposed a secret command input"

            if output_mode == 'json':
                try:
                    envelope = json.loads(failed.stdout)
                except json.JSONDecodeError as error:
                    return f"{mode} JSON failure returned invalid JSON: {error}"
                error_envelope = envelope.get('error') if isinstance(envelope, dict) else None
                if not isinstance(error_envelope, dict) or error_envelope.get('code') != _ERROR_CODE:
                    return f"{mode} JSON failure returned no {_ERROR_CODE} envelope"
                if error_envelope.get('hint') != expected_hint:
                    return f"{mode} JSON failure did not render its next command from the error catalogue"
                if any(key in error_envelope for key in ('cause', 'stack', 'causeChain')):
                    return f"{mode} JSON failure exposed a cause or stack field"
                details = error_envelope.get('details')
                if not isinstance(details, dict) or details.get('plugin') != fixture_package:
                    return f"{mode} JSON failure did not name the fixture plugin"
                if details.get('command') != ' '.join(_ERROR_COMMAND):
                    return f"{mode} JSON failure did not name the fixture command"
            elif _ERROR_CODE not in safe_output:
                return f"{mode} human failure omitted {_ERROR_CODE}"
            elif expected_hint not in safe_output:
                return f"{mode} human failure omitted the catalogued log-query command"

            query = run_command(
                [cli, 'logs', 'query', '--correlation-id', correlation_id, '--json'],
                cwd=platform_root, env=env, capture_output=True, text=True,
                check=False, timeout=120,
            )
            if query.returncode != 0:
                return f"{mode} {host_state} diagnostic query exited {query.returncode}"
            try:
                result = json.loads(query.stdout)
            except json.JSONDecodeError as error:
                return f"{mode} {host_state} diagnostic query returned invalid JSON: {error}"
            logs = logs_from_query_envelope(result) if isinstance(result, dict) else []
            record = next((item for item in logs
                           if isinstance(item, dict) and item.get('correlationId') == correlation_id), None)
            if record is None:
                return f"{mode} {host_state} query did not return the matching correlation ID"
            serialized_error = record.get('serializedError')
            if (record.get('event') != 'plugin.handler.failed'
                    or record.get('sourceErrorClass') != 'Error'
                    or not record.get('sourceMessage')):
                return f"{mode} {host_state} record omitted the plugin failure event, error class, or message"
            if (not isinstance(serialized_error, dict)
                    or serialized_error.get('name') != 'Error'
                    or not serialized_error.get('message')
                    or not serialized_error.get('stack')):
                return f"{mode} {host_state} record omitted serialized error class, message, or stack"
            nested_cause = serialized_error.get('cause')
            if (not isinstance(nested_cause, dict)
                    or not nested_cause.get('message')
                    or not nested_cause.get('stack')):
                return f"{mode} {host_state} record omitted the nested cause message or stack"
            rendered = json.dumps(record, sort_keys=True)
            if secret in rendered:
                return f"{mode} {host_state} log record contains the secret command input"
            if '[REDACTED]' not in rendered:
                return f"{mode} {host_state} log record did not mark the secret as redacted"
            for name, value in env.items():
                if value and redaction.is_secret_key(name) and value in rendered:
                    return f"{mode} {host_state} log record contains the value of secret environment variable {name}"
            correlated_records.append(record)
        return None

    journey.step(
        'unexpected CLI error trail with host running',
        'cli',
        lambda: verify_state('host-running'),
        cases=['S-203.26'],
        details=lambda: {'correlatedFailureRecords': list(correlated_records)},
    )

    create_cli = shutil.which('kb-create', path=env.get('PATH'))
    if create_cli is None:
        journey.step('unexpected CLI error trail with host stopped', 'cli',
                     lambda: 'BLOCKED: installed kb-create is required to stop and restore the host',
                     cases=['S-203.26'])
        return

    stopped = False
    try:
        stop = run_command([create_cli, 'stop', '--platform-root', platform_root, '--json'],
                           cwd=platform_root, env=env, capture_output=True, text=True,
                           check=False, timeout=120)
        if stop.returncode != 0:
            journey.step('unexpected CLI error trail with host stopped', 'cli',
                         lambda: f'kb-create stop exited {stop.returncode}', cases=['S-203.26'])
        else:
            stopped = True
            journey.step(
                'unexpected CLI error trail with host stopped',
                'cli',
                lambda: verify_state('host-stopped'),
                cases=['S-203.26'],
                details=lambda: {'correlatedFailureRecords': list(correlated_records)},
            )
    finally:
        if stopped:
            restored = run_command([create_cli, 'start', '--platform-root', platform_root, '--json'],
                                   cwd=platform_root, env=env, capture_output=True, text=True,
                                   check=False, timeout=120)
            if restored.returncode != 0:
                journey.step('restore host after unexpected CLI trail', 'cli',
                             lambda: f'kb-create start exited {restored.returncode}')
