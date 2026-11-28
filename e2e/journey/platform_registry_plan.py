"""Generate the Registry E2E plan through the shared CLI result boundary."""
import json
import sys
from pathlib import Path

from invocations import decode_ux_error_result, decode_ux_success_result, read_kb_create_cli_result, run_command


def main(argv: list[str]) -> None:
    output, *plan_args = argv
    result = run_command(["kb-create", "plan", "--json", *plan_args])
    envelope = read_kb_create_cli_result("plan", result)
    if result.returncode:
        error = decode_ux_error_result(envelope)
        raise RuntimeError(f"kb-create plan failed: {error['code']}")
    decode_ux_success_result(envelope)
    Path(output).write_text(json.dumps(envelope) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])
