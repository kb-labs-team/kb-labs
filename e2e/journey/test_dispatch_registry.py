"""Keep selected-case routing complete for every active journey claim."""
from __future__ import annotations

import ast
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
import shlex
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

from dispatch_registry import RUNNERS, runners_for_source
from hermetic_cli import run_hermetic_cli
from select_from_cases import (read_coverage_result, selection_from_coverage,
                               _case_declarations,
                               _step_declaration, _source_step_declarations,
                               _imported_journey_sources, selectors_from_coverage,
                               fixture_group_declarations,
                               validate_dependency_declarations,
                               lint_direct_module_global_state_handoffs,
                               validate_runner_conditions, validate_journey_environment_reads,
                               full_runner_plans, resolve_selection, journey_source_group_declaration)
from platform_update_steps import run_platform_update_steps
from platform_update_variant_steps import run_platform_update_variant_steps
from journey_dependencies import Dependency, FLOW_GRAPH_STATE_PRODUCERS
from journey_selection import SELECTION_KEYS
from service_steps import FlowGraph, Journey


def helper_read(memory, key):
    return memory.get(key)


def _owner_command_sites(root: Path) -> tuple[dict[str, list[str]], list[str], dict[str, int]]:
    """Resolve command paths at the sole argv/shell builders and their wrappers."""
    command_sites: dict[str, list[str]] = {}
    violations: list[str] = []
    shapes: dict[str, int] = {}
    for base in (root / "e2e", root / "scripts"):
        for source_path in base.rglob("*.py"):
            if source_path.name.startswith("test_") or "node_modules" in source_path.parts:
                continue
            source = source_path.read_text(encoding="utf-8", errors="replace")
            relative = source_path.relative_to(root).as_posix()
            try:
                tree = ast.parse(source, filename=relative)
            except SyntaxError:
                continue
            parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
            def enclosing_function(node):
                current = parents.get(node)
                while current is not None:
                    if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        return current
                    current = parents.get(current)
                return None

            def module_assignment(name):
                for statement in tree.body:
                    if isinstance(statement, ast.Assign) and any(
                            isinstance(target, ast.Name) and target.id == name
                            for target in statement.targets):
                        return statement.value
                    if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name) \
                            and statement.target.id == name:
                        return statement.value
                return None

            def scope_nodes(scope):
                pending = [scope]
                while pending:
                    node = pending.pop()
                    yield node
                    if node is not scope and isinstance(
                            node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                        continue
                    pending.extend(ast.iter_child_nodes(node))

            def literal_table_values(expression):
                """Read literal nested registry values, including dynamic registry keys."""
                if not isinstance(expression, ast.Subscript):
                    return None
                registry = expression.value
                field = expression.slice.value if isinstance(expression.slice, ast.Constant) else None
                if not isinstance(registry, ast.Subscript) or not isinstance(registry.value, ast.Name):
                    return None
                declaration = next((statement.value for statement in tree.body
                                    if isinstance(statement, (ast.Assign, ast.AnnAssign))
                                    and isinstance(statement, ast.Assign) and any(
                                        isinstance(target, ast.Name) and target.id == registry.value.id
                                        for target in statement.targets)), None)
                if not isinstance(declaration, ast.Dict):
                    return None
                values = []
                for record in declaration.values:
                    if not isinstance(record, ast.Dict):
                        return None
                    for key, value in zip(record.keys, record.values):
                        if isinstance(key, ast.Constant) and key.value == field:
                            if not isinstance(value, (ast.List, ast.Tuple)) or value.elts:
                                values.append(value)
                return values

            def static_prefix(expression, scope, at_line, seen):
                if isinstance(expression, ast.Starred):
                    return static_prefix(expression.value, scope, at_line, seen)
                if isinstance(expression, ast.Subscript):
                    table_values = literal_table_values(expression)
                    if table_values is not None:
                        results = []
                        for value in table_values:
                            results.extend(static_prefix(value, scope, at_line, seen))
                        return [(tokens, dynamic, "literal registry table")
                                for tokens, dynamic, _shape in results]
                if (isinstance(expression, ast.Call) and isinstance(expression.func, ast.Name)
                        and expression.func.id == "list" and len(expression.args) == 1):
                    results = static_prefix(expression.args[0], scope, at_line, seen)
                    return [(tokens, dynamic, "literal list conversion")
                            for tokens, dynamic, _shape in results]
                if isinstance(expression, (ast.List, ast.Tuple)):
                    if expression.elts and isinstance(expression.elts[0], (ast.List, ast.Tuple)):
                        results = []
                        for command in expression.elts:
                            results.extend(static_prefix(command, scope, at_line, seen))
                        return [(tokens, dynamic, "literal command sequence")
                                for tokens, dynamic, _shape in results]
                    alternatives = [([], False)]
                    for item in expression.elts:
                        if isinstance(item, ast.Starred):
                            expanded = static_prefix(item.value, scope, at_line, seen)
                            if not expanded:
                                alternatives = [(tokens, True) for tokens, _dynamic in alternatives]
                                break
                            next_alternatives = []
                            for tokens, dynamic in alternatives:
                                for prefix, unresolved, _shape in expanded:
                                    next_alternatives.append((tokens + prefix, dynamic or unresolved or not prefix))
                            alternatives = next_alternatives
                            continue
                        if isinstance(item, ast.Constant) and isinstance(item.value, str):
                            if item.value.startswith("-"):
                                alternatives = [
                                    (tokens + [item.value] if item.value == "--help"
                                     or not tokens and item.value in {"--help", "--version"} else tokens,
                                     dynamic)
                                    for tokens, dynamic in alternatives
                                ]
                                break
                            alternatives = [(tokens + [item.value], dynamic)
                                            for tokens, dynamic in alternatives]
                        else:
                            alternatives = [(tokens, True) for tokens, _dynamic in alternatives]
                            break
                    return [(tokens, dynamic, "literal argv") for tokens, dynamic in alternatives]
                if isinstance(expression, ast.Name) and scope is not None:
                    marker = (id(scope), expression.id)
                    if marker in seen:
                        return [([], True, "unresolved wrapper")]
                    lexical_scopes = [scope]
                    parent_scope = enclosing_function(scope)
                    while parent_scope is not None:
                        lexical_scopes.append(parent_scope)
                        parent_scope = enclosing_function(parent_scope)
                    loop_values = []
                    for lexical_scope in lexical_scopes:
                        for node in scope_nodes(lexical_scope):
                            if not isinstance(node, (ast.For, ast.AsyncFor)):
                                continue
                            iterable = node.iter
                            if isinstance(iterable, ast.Name):
                                sources = []
                                for candidate in scope_nodes(lexical_scope):
                                    if getattr(candidate, "lineno", 0) >= node.lineno:
                                        continue
                                    targets = candidate.targets if isinstance(candidate, ast.Assign) else [candidate.target] if isinstance(
                                        candidate, (ast.AnnAssign, ast.NamedExpr)) else []
                                    if any(isinstance(target, ast.Name) and target.id == iterable.id for target in targets):
                                        sources.append((candidate.lineno, candidate.value))
                                if sources:
                                    iterable = max(sources, key=lambda item: item[0])[1]
                                else:
                                    iterable = module_assignment(iterable.id)
                            target = node.target
                            if isinstance(target, ast.Name) and target.id == expression.id:
                                if isinstance(iterable, (ast.List, ast.Tuple)):
                                    loop_values.extend(iterable.elts)
                            elif isinstance(target, (ast.Tuple, ast.List)):
                                for index, item in enumerate(target.elts):
                                    if isinstance(item, ast.Name) and item.id == expression.id:
                                        if isinstance(iterable, (ast.List, ast.Tuple)):
                                            for candidate in iterable.elts:
                                                if isinstance(candidate, (ast.List, ast.Tuple)) and index < len(candidate.elts):
                                                    loop_values.append(candidate.elts[index])
                        if loop_values:
                            break
                    if loop_values:
                        results = []
                        for value in loop_values:
                            results.extend(static_prefix(value, scope, at_line, seen | {marker}))
                        return [(tokens, dynamic, "literal loop/table") for tokens, dynamic, _shape in results]
                    assignments = []
                    for lexical_scope in lexical_scopes:
                        for node in scope_nodes(lexical_scope):
                            if getattr(node, "lineno", 0) >= at_line:
                                continue
                            targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(
                                node, (ast.AnnAssign, ast.NamedExpr)) else []
                            if any(isinstance(target, ast.Name) and target.id == expression.id for target in targets):
                                value = node.value
                                assignments.append((node.lineno, value))
                        if assignments:
                            break
                    if assignments:
                        line, value = max(assignments, key=lambda item: item[0])
                        results = static_prefix(value, scope, line, seen | {marker})
                        for extension in scope_nodes(scope):
                            if not isinstance(extension, ast.Call) or not isinstance(extension.func, ast.Attribute):
                                continue
                            if extension.func.attr != "extend" or not isinstance(extension.func.value, ast.Name):
                                continue
                            if extension.func.value.id != expression.id or extension.lineno <= line or not extension.args:
                                continue
                            results.extend(static_prefix(extension.args[0], scope, extension.lineno,
                                                         seen | {marker}))
                        return [(tokens, dynamic, "local/joined argv") for tokens, dynamic, _shape in results]
                    global_value = module_assignment(expression.id)
                    if global_value is not None:
                        results = static_prefix(global_value, scope, at_line, seen | {marker})
                        return [(tokens, dynamic, "literal data declaration")
                                for tokens, dynamic, _shape in results]
                    formal_args = [*scope.args.posonlyargs, *scope.args.args]
                    if scope.args.vararg is not None:
                        formal_args.append(scope.args.vararg)
                    index = next((position for position, argument in enumerate(formal_args)
                                  if argument.arg == expression.id), None)
                    if index is None:
                        return [([], True, "unresolved name")]
                    parent_function = enclosing_function(scope)
                    call_nodes = ast.walk(parent_function) if parent_function is not None else ast.walk(tree)
                    callers = [node for node in call_nodes if isinstance(node, ast.Call)
                               and ((isinstance(node.func, ast.Name) and node.func.id == scope.name)
                                    or (isinstance(node.func, ast.Attribute) and node.func.attr == scope.name))
                               and node is not scope]
                    if not callers:
                        return [([], True, "wrapper has no statically visible call sites")]
                    results = []
                    for call in callers:
                        if scope.args.vararg is not None and expression.id == scope.args.vararg.arg:
                            fixed_count = len(scope.args.posonlyargs) + len(scope.args.args)
                            actuals = [ast.List(elts=call.args[fixed_count:], ctx=ast.Load())]
                        else:
                            actual = call.args[index] if index < len(call.args) else next((keyword.value for keyword in call.keywords
                                                                                             if keyword.arg == expression.id), None)
                            actuals = [] if actual is None else [actual]
                        if not actuals:
                            results.append(([], True, "wrapper argument is omitted"))
                        for actual in actuals:
                            resolved = static_prefix(actual, enclosing_function(call), call.lineno,
                                                     seen | {marker})
                            if not any(tokens for tokens, _dynamic, _shape in resolved):
                                violations.append(
                                    f"{relative}:{call.lineno}: wrapper {scope.name} call site has a non-literal command path")
                            results.extend(resolved)
                    return [(prefix, dynamic, "wrapper call") for prefix, dynamic, _shape in results]
                return [([], True, "non-literal command source")]

            for node in ast.walk(tree):
                if not isinstance(node, ast.List) or not node.elts:
                    continue
                if not (isinstance(node.elts[0], ast.Constant) and node.elts[0].value == "kb"):
                    continue
                if relative != "e2e/journey/kb_invocation.py":
                    violations.append(f"{relative}:{node.lineno}: raw kb argv is outside kb_invocation.py")

            for node in ast.walk(tree):
                if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                    continue
                if node.func.id not in {"kb_command", "kb_login_shell", "kb_login_shell_sequence",
                                        "kb_shell_text"} or not node.args:
                    continue
                if relative == "e2e/journey/kb_invocation.py":
                    continue
                results = static_prefix(node.args[0], enclosing_function(node), node.lineno, set())
                for tokens, dynamic, shape in results:
                    shapes[shape] = shapes.get(shape, 0) + 1
                    scope = enclosing_function(node)
                    if not tokens and node.func.id == "kb_command" and isinstance(node.args[0], (ast.List, ast.Tuple)):
                        if (node.args[0].elts and isinstance(node.args[0].elts[0], ast.Constant)
                                and node.args[0].elts[0].value in {"--help", "--version"}):
                            tokens = [node.args[0].elts[0].value]
                    if not tokens:
                        violations.append(f"{relative}:{node.lineno}: command path is not statically resolvable ({shape})")
                    elif not tokens[0].startswith("-"):
                        command_sites.setdefault(" ".join(tokens), []).append(f"{relative}:{node.lineno} ({shape})")

    return command_sites, violations, shapes


def _registered_command_registry(root: Path) -> tuple[set[str], set[str]]:
    """Derive command leaves and groups from shipped command declarations."""
    leaves: set[str] = set()
    groups: set[str] = set()
    for manifest in root.glob("plugins/*/src/manifest.ts"):
        text = manifest.read_text(encoding="utf-8")
        group_meta = set(re.findall(r"groupMeta\s*:\s*\[([^\]]*)\]", text, re.S))
        group_paths = {path for block in group_meta
                       for path in re.findall(r"path\s*:\s*['\"]([^'\"]+)['\"]", block)}
        groups.update(group_paths)
        command_paths = set(re.findall(r"path\s*:\s*['\"]([a-zA-Z0-9][a-zA-Z0-9 -]*)['\"]", text))
        leaves.update(command_paths - group_paths)
    for manifest in (root / "e2e/journey/fixtures").glob("**/manifest.js"):
        text = manifest.read_text(encoding="utf-8")
        group_meta = set(re.findall(r"groupMeta\s*:\s*\[([^\]]*)\]", text, re.S))
        group_paths = {path for block in group_meta
                       for path in re.findall(r"path\s*:\s*['\"]([^'\"]+)['\"]", block)}
        groups.update(group_paths)
        command_paths = set(re.findall(r"path\s*:\s*['\"]([a-zA-Z0-9][a-zA-Z0-9 -]*)['\"]", text))
        leaves.update(command_paths - group_paths)

    system_commands = {}
    system_aliases = {}
    system_root = root / "cli/commands/src/commands/system"
    for source_path in system_root.rglob("*.ts"):
        text = source_path.read_text(encoding="utf-8")
        for variable, name in re.findall(
                r"export const (\w+)\s*=\s*defineSystemCommand[\s\S]*?\{\s*name\s*:\s*['\"]([^'\"]+)['\"]",
                text):
            system_commands[variable] = name
            system_aliases[variable] = re.findall(r"aliases\s*:\s*\[([^\]]*)\]", text)
    groups_text = (system_root / "groups.ts").read_text(encoding="utf-8")
    for group, members in re.findall(
            r"defineSystemCommandGroup\(\s*['\"]([^'\"]+)['\"][^\[]*\[([^\]]*)\]", groups_text, re.S):
        groups.add(group)
        for member in re.findall(r"\b[A-Za-z_$][\w$]*\b", members):
            if member in system_commands:
                leaves.add(f"{group} {system_commands[member]}")
    for variable, aliases in system_aliases.items():
        leaves.update(alias for block in aliases
                      for alias in re.findall(r"['\"]([^'\"]+)['\"]", block))
    registration_source = (root / "cli/commands/src/utils/register.ts").read_text(encoding="utf-8")
    for variable in re.findall(r"registry\.register\(\s*(\w+)\s*\)", registration_source):
        if variable in system_commands:
            leaves.add(system_commands[variable])

    scaffold_source = (root / "cli/commands/src/commands/system/plugins/plugins-scaffold.ts").read_text(
        encoding="utf-8")
    generated_command_ids = set(re.findall(r"id:\s*['\"]([^'\"]+)['\"]", scaffold_source))
    if re.search(r"group:\s*['\"]\$\{pluginName\}['\"]", scaffold_source):
        for journey_source in (root / "e2e/journey").glob("*.py"):
            journey_text = journey_source.read_text(encoding="utf-8")
            if not re.search(r"kb_command\(\[\s*['\"]scaffold['\"]\s*,\s*['\"]run['\"]\s*,\s*['\"]plugin['\"]\s*,\s*PLUGIN_NAME", journey_text):
                continue
            plugin_name = re.search(r"^PLUGIN_NAME\s*=\s*['\"]([^'\"]+)['\"]", journey_text, re.M)
            if plugin_name:
                groups.add(plugin_name.group(1))
                leaves.update(f"{plugin_name.group(1)} {command}" for command in generated_command_ids)
    return leaves, groups


def _unregistered_commands(paths: dict[str, list[str]], registered: set[str],
                           groups: set[str] | None = None) -> dict[str, list[str]]:
    groups = groups or set()
    failures = {}
    for command, locations in paths.items():
        tokens = command.split()
        if len(tokens) > 1 and tokens[-1] == "--help" and " ".join(tokens[:-1]) in groups:
            continue
        resolved = next((" ".join(tokens[:index]) for index in range(len(tokens), 0, -1)
                         if " ".join(tokens[:index]) in registered), None)
        if resolved is None:
            failures[command] = locations
    return failures


def _selection_owner_violations(root: Path) -> list[str]:
    selection_fields = {"selected_claims", "selected_steps", "prerequisite_steps"}
    violations = []
    for source_path in (root / "e2e/journey").rglob("*.py"):
        if ("__pycache__" in source_path.parts or source_path.name.startswith("test_")
                or source_path.relative_to(root).as_posix() == "e2e/journey/service_steps.py"):
            continue
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        relative = source_path.relative_to(root).as_posix()
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in selection_fields:
                violations.append(
                    f"{relative}:{node.lineno}: selection metadata read outside service_steps.py")
    return sorted(violations)


def _studio_command_path_sites(root: Path) -> tuple[dict[str, list[str]], list[str]]:
    """Resolve every reference to the exported command helper by TypeScript symbol."""
    parser = r"""
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const root = path.resolve(input.root)
const repositoryRoot = path.resolve(input.repositoryRoot)
const configPath = path.join(repositoryRoot, 'e2e/studio/tsconfig.json')
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    throw new Error(`Unable to read Studio TypeScript config: ${message}`)
  },
})
if (!config) throw new Error(`Unable to read Studio TypeScript config at ${configPath}`)
const rootNames = input.isRepository
  ? config.fileNames
  : input.sources.map(source => path.join(root, source.file))
const program = ts.createProgram(rootNames, config.options)
const checker = program.getTypeChecker()
const ownerPath = path.join(root, 'e2e/studio/kb-command.ts')
const ownerFile = program.getSourceFile(ownerPath)
if (!ownerFile) throw new Error(`Studio command owner is missing: ${ownerPath}`)
const ownerModule = checker.getSymbolAtLocation(ownerFile)
if (!ownerModule) throw new Error(`Studio command owner has no module symbol: ${ownerPath}`)
const ownerSymbol = checker.getExportsOfModule(ownerModule).find(symbol => symbol.name === 'runKbCommand')
if (!ownerSymbol) throw new Error(`Studio command owner does not export runKbCommand: ${ownerPath}`)
const calls = []
const violations = []
const reason = 'command path must be literal so the rail can check it against product declarations'
function canonical(symbol) {
  let current = symbol
  const visited = new Set()
  while (current && current.flags & ts.SymbolFlags.Alias && !visited.has(current)) {
    visited.add(current)
    const target = checker.getAliasedSymbol(current)
    if (target === current) break
    current = target
  }
  return current
}
function isOwnerReference(identifier) {
  const symbol = checker.getSymbolAtLocation(identifier)
  return symbol !== undefined && canonical(symbol) === ownerSymbol
}
function location(node, sourceFile) {
  const relative = path.relative(root, sourceFile.fileName).split(path.sep).join('/')
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  return { relative, line, site: `${relative}:${line}` }
}
function directCall(identifier) {
  const parent = identifier.parent
  if (ts.isCallExpression(parent) && parent.expression === identifier) return parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier
      && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return parent.parent
  return undefined
}
function isImportBinding(identifier) {
  let current = identifier.parent
  while (current && !ts.isImportDeclaration(current)) current = current.parent
  return current !== undefined
}
function isOwnerDeclaration(identifier, sourceFile) {
  return sourceFile === ownerFile && identifier.parent && identifier.parent.name === identifier
}
const studioFiles = program.getSourceFiles().filter(sourceFile => {
  const relative = path.relative(root, sourceFile.fileName).split(path.sep).join('/')
  return relative.startsWith('e2e/studio/') && relative.endsWith('.ts')
    && !relative.endsWith('.test.ts') && !relative.includes('/node_modules/')
})
for (const sourceFile of studioFiles) {
  function visit(node) {
    if (ts.isExportSpecifier(node)) {
      const exported = node.propertyName ?? node.name
      if (isOwnerReference(exported)) {
        const site = location(node, sourceFile)
        violations.push(`${site.site}: ${reason}`)
      }
    } else if (ts.isIdentifier(node) && isOwnerReference(node)
        && !isImportBinding(node) && !isOwnerDeclaration(node, sourceFile)
        && !ts.isExportSpecifier(node.parent)) {
      const call = directCall(node)
      const site = location(node, sourceFile)
      const argument = call?.arguments[0]
      if (!argument || !ts.isArrayLiteralExpression(argument)
          || argument.elements.some(element => !ts.isStringLiteral(element))) {
        violations.push(`${site.site}: ${reason}`)
      } else {
        calls.push({ file: site.relative, line: site.line, values: argument.elements.map(element => element.text) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}
process.stdout.write(JSON.stringify({ calls, violations }))
"""
    repository_root = Path(__file__).resolve().parents[2]
    sources = []
    for source_path in sorted((root / "e2e/studio").rglob("*.ts")):
        if "node_modules" in source_path.parts or source_path.name.endswith(".test.ts"):
            continue
        sources.append({"file": source_path.relative_to(root).as_posix()})
    parser_input = {
        "root": str(root.resolve()),
        "repositoryRoot": str(repository_root),
        "isRepository": root.resolve() == repository_root,
        "sources": sources,
    }
    parsed = subprocess.run(
        ["node", "-e", parser],
        cwd=repository_root,
        input=json.dumps(parser_input),
        text=True,
        capture_output=True,
        check=False,
    )
    if parsed.returncode != 0:
        raise RuntimeError(f"TypeScript command rail parser failed: {parsed.stderr.strip()}")
    result = json.loads(parsed.stdout)
    paths: dict[str, list[str]] = {}
    for call in result["calls"]:
        command = []
        for value in call["values"]:
            if value.startswith("-"):
                break
            command.append(value)
        if "--help" in call["values"]:
            command.append("--help")
        if command:
            paths.setdefault(" ".join(command), []).append(
                f"{call['file']}:{call['line']} (TypeScript owner call)"
            )
        else:
            result["violations"].append(
                f"{call['file']}:{call['line']}: command path must be literal so the rail can check it against product declarations"
            )
    return paths, result["violations"]


def _studio_process_creation_violations(root: Path) -> list[str]:
    """Require every TypeScript process sink to live in the generic owner."""
    owner = "e2e/studio/kb-command.ts"
    sink_call = re.compile(r"\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(")
    violations = []
    for source_path in (root / "e2e/studio").rglob("*.ts"):
        if "node_modules" in source_path.parts or source_path.name.endswith(".test.ts"):
            continue
        relative = source_path.relative_to(root).as_posix()
        if relative == owner:
            continue
        text = source_path.read_text(encoding="utf-8", errors="replace")
        if "child_process" in text:
            line = next((number for number, content in enumerate(text.splitlines(), 1)
                         if "child_process" in content), 1)
            violations.append(f"{relative}:{line}: child_process sink outside {owner}")
        elif sink_call.search(text):
            match = sink_call.search(text)
            line = text.count("\n", 0, match.start()) + 1
            violations.append(f"{relative}:{line}: process sink outside {owner}")
    return sorted(violations)


def _kb_create_journey_knowledge_violations(sources: dict[str, str]) -> list[str]:
    return sorted(filename for filename, source in sources.items() if "JOURNEY" in source)


class DispatchRegistryTests(unittest.TestCase):
    def test_shared_project_and_auth_mutators_declare_state_invalidation(self):
        runner_source = Path(__file__).with_name("runner.py")
        tree = ast.parse(runner_source.read_text())
        mutators = []
        runner_text = runner_source.read_text()
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if any(isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef))
                   for statement in node.body):
                continue
            source = ast.get_source_segment(runner_text, node) or ""
            body_text = source.lower()
            mutates_shared_project_or_auth = (
                '"project", "remove"' in body_text
                or "run_bootstrap_recovery_steps(" in source
                or ("restart_host(" in source and "outer_graph" in source)
            )
            if mutates_shared_project_or_auth:
                mutators.append((node.name, source))

        self.assertTrue(mutators, "shared project/auth mutation scan found no step bodies")
        for name, source in mutators:
            self.assertIn("invalidate_state(", source,
                          f"shared project/auth mutator {name!r} must invalidate affected FlowGraph states")
        recovery = next(source for name, source in mutators if "run_bootstrap_recovery_steps(" in source)
        for state in ("project-registered", "session", "host-running"):
            self.assertIn(f'invalidate_state(\n                    "{state}"', recovery,
                          f"bootstrap recovery must declare its mutation of {state}")

    def test_kb_create_go_source_has_no_journey_knowledge(self):
        root = Path(__file__).resolve().parents[2]
        sources = {}
        for source_path in sorted((root / "tools").rglob("*.go")):
            if source_path.name.endswith("_test.go"):
                continue
            sources[source_path.relative_to(root).as_posix()] = source_path.read_text(
                encoding="utf-8", errors="replace")
        self.assertEqual(_kb_create_journey_knowledge_violations(sources), [])

    def test_kb_create_journey_knowledge_rail_rejects_source_mutation(self):
        self.assertEqual(_kb_create_journey_knowledge_violations({
            "tools/kb-create/install.go": 'const hidden = "KB_JOURNEY_PROMPT_MODE"',
        }), ["tools/kb-create/install.go"])

    def test_built_workspace_cli_missing_reports_exact_build_command(self):
        with tempfile.TemporaryDirectory(prefix="journey-missing-cli-build-") as temporary:
            with self.assertRaisesRegex(FileNotFoundError, "kb-devkit run build --affected"):
                run_hermetic_cli(
                    ["node", "./cli/bin/dist/bin.js", "qa", "cases", "validate"],
                    cwd=Path(temporary), env={},
                    workspace_root=Path(temporary),
                )

    def test_command_path_rail_follows_two_level_wrapper_and_rejects_bare_group(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="journey-command-wrapper-") as temporary:
            fixture = Path(temporary)
            (fixture / "e2e/journey").mkdir(parents=True)
            (fixture / "scripts").mkdir()
            (fixture / "e2e/journey/kb_invocation.py").write_text("def kb_command(args): return ['kb', *args]\n")
            (fixture / "e2e/journey/calls.py").write_text(
                "from kb_invocation import kb_command\n"
                "def inner(args): return kb_command(args)\n"
                "def outer(args): return inner(args)\n"
                "def run(): return outer(['commit', '--dry-run'])\n"
            )
            paths, violations, _ = _owner_command_sites(fixture)
            self.assertEqual(violations, [])
            self.assertIn("commit", paths)
            self.assertIn("commit", _unregistered_commands(paths, _registered_command_registry(root)[0]))

    def test_command_path_rail_reads_literal_data_table_and_rejects_bare_group(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="journey-command-table-") as temporary:
            fixture = Path(temporary)
            (fixture / "e2e/journey").mkdir(parents=True)
            (fixture / "scripts").mkdir()
            (fixture / "e2e/journey/kb_invocation.py").write_text("def kb_command(args): return ['kb', *args]\n")
            (fixture / "e2e/journey/calls.py").write_text(
                "from kb_invocation import kb_command\n"
                "COMMAND_PATHS = ((\"commit\", \"--dry-run\"),)\n"
                "def invoke(args): return kb_command(args)\n"
                "def run():\n"
                "    for command in COMMAND_PATHS:\n"
                "        invoke(command)\n"
            )
            paths, violations, _ = _owner_command_sites(fixture)
            self.assertEqual(violations, [])
            self.assertIn("commit", _unregistered_commands(paths, _registered_command_registry(root)[0]))

    def test_command_registry_accepts_documented_group_help_and_rejects_a_bare_group(self):
        root = Path(__file__).resolve().parents[2]
        cases = (root / "docs/qa/scenarios/S-011-marketplace-enable-disable.md").read_text()
        row = re.search(r"\|\s*S-011\.3\s*\|\s*Run `kb ([^`]+)`", cases)
        self.assertIsNotNone(row, "S-011.3 must keep its documented command probe")
        group_help = row.group(1)
        registered, groups = _registered_command_registry(root)
        self.assertEqual(_unregistered_commands({group_help: ["S-011.3"]}, registered, groups), {})
        group = " ".join(group_help.split()[:-1])
        self.assertIn(group, groups)
        self.assertEqual(_unregistered_commands({group: ["leaf-required"]}, registered, groups),
                         {group: ["leaf-required"]})

    def test_selection_metadata_reads_are_owned_by_flow_graph_module(self):
        root = Path(__file__).resolve().parents[2]
        self.assertEqual(_selection_owner_violations(root), [])
        with tempfile.TemporaryDirectory(prefix="journey-selection-owner-") as temporary:
            fixture = Path(temporary)
            (fixture / "e2e/journey").mkdir(parents=True)
            (fixture / "e2e/journey/service_steps.py").write_text("journey.selected_steps\n")
            (fixture / "e2e/journey/other_steps.py").write_text("if journey.prerequisite_steps: pass\n")
            self.assertEqual(_selection_owner_violations(fixture), [
                "e2e/journey/other_steps.py:1: selection metadata read outside service_steps.py"
            ])

    def test_studio_process_creation_is_owned_by_generic_command_runner(self):
        root = Path(__file__).resolve().parents[2]
        self.assertEqual(_studio_process_creation_violations(root), [])
        with tempfile.TemporaryDirectory(prefix="studio-process-owner-") as temporary:
            fixture = Path(temporary)
            (fixture / "e2e/studio").mkdir(parents=True)
            (fixture / "e2e/studio/kb-command.ts").write_text(
                "import { execFileSync } from 'node:child_process'\n"
                "export const run = (file: string, args: string[]) => execFileSync(file, args)\n"
            )
            (fixture / "e2e/studio/scenario.ts").write_text(
                "import { execFileSync as run } from 'node:child_process'\n"
                "run(binary, args)\n"
            )
            self.assertEqual(_studio_process_creation_violations(fixture), [
                "e2e/studio/scenario.ts:1: child_process sink outside e2e/studio/kb-command.ts"
            ])

    def test_studio_command_path_rail_resolves_aliases_and_rejects_other_symbol_uses(self):
        reason = "command path must be literal so the rail can check it against product declarations"
        with tempfile.TemporaryDirectory(prefix="studio-command-symbols-") as temporary:
            fixture = Path(temporary)
            studio = fixture / "e2e/studio"
            studio.mkdir(parents=True)
            (studio / "kb-command.ts").write_text(
                "export function runKbCommand(path: readonly string[]) { return path.join(' ') }\n",
                encoding="utf-8",
            )
            sources = {
                "aliased-spread.ts": (
                    "import { runKbCommand as run } from './kb-command'\n"
                    "run([...prefix, 'commit', 'plan', 'show'])\n"
                ),
                "template-path.ts": (
                    "import { runKbCommand } from './kb-command'\n"
                    "runKbCommand([`commit ${verb}`])\n"
                ),
                "variable-path.ts": (
                    "import { runKbCommand } from './kb-command'\n"
                    "runKbCommand(commandPath)\n"
                ),
                "call-path.ts": (
                    "import { runKbCommand } from './kb-command'\n"
                    "runKbCommand(resolvePath())\n"
                ),
                "invalid-leaf.ts": (
                    "import { runKbCommand as run } from './kb-command'\n"
                    "run(['definitely-not-a-product-command'])\n"
                ),
                "stored-value.ts": (
                    "import { runKbCommand } from './kb-command'\n"
                    "const f = runKbCommand\n"
                    "f(['commit', 'plan', 'show'])\n"
                ),
                "bridge.ts": "export { runKbCommand as forwarded } from './kb-command'\n",
                "re-export-use.ts": (
                    "import { forwarded } from './bridge'\n"
                    "forwarded(['commit', 'plan', 'show'])\n"
                ),
                "namespace.ts": (
                    "import * as k from './kb-command'\n"
                    "k.runKbCommand(path)\n"
                ),
            }
            for filename, source in sources.items():
                (studio / filename).write_text(source, encoding="utf-8")

            paths, violations = _studio_command_path_sites(fixture)
            self.assertCountEqual(violations, [
                f"e2e/studio/aliased-spread.ts:2: {reason}",
                f"e2e/studio/template-path.ts:2: {reason}",
                f"e2e/studio/variable-path.ts:2: {reason}",
                f"e2e/studio/call-path.ts:2: {reason}",
                f"e2e/studio/stored-value.ts:2: {reason}",
                f"e2e/studio/bridge.ts:1: {reason}",
                f"e2e/studio/namespace.ts:2: {reason}",
            ])
            self.assertEqual(paths["definitely-not-a-product-command"], [
                "e2e/studio/invalid-leaf.ts:2 (TypeScript owner call)"
            ])
            registered, groups = _registered_command_registry(Path(__file__).resolve().parents[2])
            self.assertEqual(
                _unregistered_commands(paths, registered, groups),
                {"definitely-not-a-product-command": ["e2e/studio/invalid-leaf.ts:2 (TypeScript owner call)"]},
            )

    def test_studio_command_path_rail_accepts_only_literal_array_elements(self):
        with tempfile.TemporaryDirectory(prefix="studio-command-literal-") as temporary:
            fixture = Path(temporary)
            source = fixture / "e2e/studio/scenario.ts"
            source.parent.mkdir(parents=True)
            (source.parent / "kb-command.ts").write_text(
                "export function runKbCommand(path: readonly string[]) { return path.join(' ') }\n",
                encoding="utf-8",
            )
            source.write_text(
                "import { runKbCommand } from './kb-command'\n"
                "runKbCommand(['commit', 'plan', 'show', '--help'])\n"
                "runKbCommand(['marketplace', 'install', '@kb-labs/commit', '--json'])\n",
                encoding="utf-8",
            )
            paths, violations = _studio_command_path_sites(fixture)
            self.assertEqual(violations, [])
            self.assertEqual(paths, {
                "commit plan show --help": ["e2e/studio/scenario.ts:2 (TypeScript owner call)"],
                "marketplace install @kb-labs/commit": [
                    "e2e/studio/scenario.ts:3 (TypeScript owner call)"
                ],
            })

    def test_command_path_rail_rejects_raw_kb_argv_outside_owner(self):
        with tempfile.TemporaryDirectory(prefix="journey-command-owner-") as temporary:
            fixture = Path(temporary)
            (fixture / "e2e/journey").mkdir(parents=True)
            (fixture / "scripts").mkdir()
            (fixture / "e2e/journey/kb_invocation.py").write_text("def kb_command(args): return ['kb', *args]\n")
            source = fixture / "e2e/journey/calls.py"
            source.write_text("def run(): return ['kb', 'commit', '--dry-run']\n")
            _, violations, _ = _owner_command_sites(fixture)
            self.assertIn("e2e/journey/calls.py:1: raw kb argv is outside kb_invocation.py", violations)

    def test_command_path_rail_names_nonliteral_wrapper_call_site(self):
        with tempfile.TemporaryDirectory(prefix="journey-command-dynamic-") as temporary:
            fixture = Path(temporary)
            (fixture / "e2e/journey").mkdir(parents=True)
            (fixture / "scripts").mkdir()
            (fixture / "e2e/journey/kb_invocation.py").write_text("def kb_command(args): return ['kb', *args]\n")
            source = fixture / "e2e/journey/calls.py"
            source.write_text(
                "from kb_invocation import kb_command\n"
                "def inner(args): return kb_command(args)\n"
                "def outer(path): return inner(path)\n"
                "def run():\n"
                "    path = resolve_command()\n"
                "    outer(path)\n"
            )
            _, violations, _ = _owner_command_sites(fixture)
            self.assertIn("e2e/journey/calls.py:6: wrapper outer call site has a non-literal command path", violations)

    def test_selection_environment_reads_are_centralized_in_typed_boundary_reader(self):
        root = Path(__file__).resolve().parents[2]
        violations = []
        for source_path in (root / "e2e/journey").glob("*.py"):
            if source_path.name == "journey_selection.py" or source_path.name.startswith("test_"):
                continue
            source = source_path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=source_path.name)
            for node in ast.walk(tree):
                key = None
                if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                        and node.func.id == "journey_value" and node.args
                        and isinstance(node.args[0], ast.Constant)):
                    key = node.args[0].value
                elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                      and node.func.attr == "get" and node.args
                      and isinstance(node.args[0], ast.Constant)):
                    key = node.args[0].value
                elif isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
                    key = node.slice.value
                if key in SELECTION_KEYS:
                    violations.append(f"{source_path.name}:{node.lineno}: {key}")
        self.assertEqual(violations, [])

    def test_installed_registry_lists_runnable_representatives_for_each_session_class(self):
        root = Path(__file__).resolve().parents[2]
        node = shutil.which("node")
        self.assertIsNotNone(node)
        result = run_hermetic_cli(
            [node, str(root / "cli/bin/dist/bin.js"), "registry", "commands", "--json"],
            cwd=root,
            env=os.environ,
            timeout=120,
            workspace_root=root,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        listing = json.loads(result.stdout)
        commands = listing["data"]["commands"]
        registered_by_path = {tuple(command["path"]): command for command in commands}
        from workflow_steps import select_session_protection_representatives
        representatives = select_session_protection_representatives(listing)
        self.assertTrue(representatives)
        for protection_class, path in representatives.items():
            self.assertEqual(registered_by_path[tuple(path)]["protectionClass"], protection_class)
            self.assertTrue(registered_by_path[tuple(path)]["available"])

    def test_fixture_default_runner_comes_from_registered_mode(self):
        with tempfile.TemporaryDirectory(prefix="journey-fixture-mode-") as temporary:
            root = Path(temporary)
            source_path = root / "e2e/journey/fixture_group.py"
            source_path.parent.mkdir(parents=True)
            source_path.write_text(
                "def selected_fixture(journey):\n"
                "    journey.step('secured fixture claim', 'test', lambda: None, cases=['TEST-MODE.1'])\n"
            )
            namespace = {"__file__": str(source_path)}
            exec(compile(source_path.read_text(), str(source_path), "exec"), namespace)
            registered_runner = SimpleNamespace(
                journey_sources=("e2e/journey/fixture_group.py",),
                mode="secured",
                claim_family="journey",
            )
            local_runner = SimpleNamespace(
                journey_sources=("e2e/journey/fixture_group.py",),
                mode="local",
                claim_family="journey",
            )
            with patch.dict("dispatch_registry.RUNNERS", {
                    "runner:blue": registered_runner,
                    "runner:green": local_runner,
            }, clear=True):
                declarations = fixture_group_declarations(
                    (namespace["selected_fixture"],), "runner:blue", root)
                local_declarations = fixture_group_declarations(
                    (namespace["selected_fixture"],), "runner:green", root)
                full_declarations = fixture_group_declarations(
                    (namespace["selected_fixture"],), "", root)

            self.assertEqual(declarations["selected_fixture"]["cases"], ("TEST-MODE.1",))
            self.assertEqual(local_declarations["selected_fixture"]["cases"], ("TEST-MODE.1",))
            self.assertEqual(full_declarations, declarations)

    def test_installer_fixture_claims_are_declared_for_the_outer_graph(self):
        from installer_case_steps import (run_apply_scenario_step, run_doctor_root_isolation_step,
                                          run_installer_case_steps, run_invalid_request_step,
                                          run_missing_project_request_steps)
        root = Path(__file__).resolve().parents[2]
        groups = (run_doctor_root_isolation_step, run_installer_case_steps,
                  run_apply_scenario_step, run_invalid_request_step,
                  run_missing_project_request_steps)
        declarations = fixture_group_declarations(groups, "agent:commit", root)
        self.assertIn("PC-001.4", declarations[run_installer_case_steps.__name__]["cases"])
        self.assertEqual(declarations[run_apply_scenario_step.__name__]["cases"], ("S-039.1",))
        self.assertIn("run_installer_case_steps", declarations)

    def test_fixture_claim_prerequisites_use_the_shared_resolver_steps(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory(prefix="journey-fixture-registry-") as temporary:
            root = Path(temporary)
            source_path = root / "fixture_group.py"
            source_path.write_text(
                "def fixture_producer(journey):\n"
                "    journey.step('fixture producer', 'test', lambda: None, "
                "runners=['agent:commit'])\n"
                "def selected_consumer(journey):\n"
                "    journey.step('selected consumer', 'test', lambda: None, "
                "cases=['TEST-CLAIM.1'], requires=('step:fixture producer',), "
                "runners=['agent:commit'])\n"
            )
            namespace = {"__file__": str(source_path)}
            exec(compile(source_path.read_text(), str(source_path), "exec"), namespace)
            with patch("select_from_cases.RUNNERS", {
                    "agent:commit": SimpleNamespace(journey_sources=("fixture_group.py",), mode="local")}):
                declarations = fixture_group_declarations(
                    (namespace["fixture_producer"], namespace["selected_consumer"]), "agent:commit", root)
            self.assertEqual(declarations["selected_consumer"]["cases"], ("TEST-CLAIM.1",))
            self.assertIn("selected consumer", declarations["selected_consumer"]["steps"])
            self.assertIn("fixture producer", declarations["fixture_producer"]["steps"])

            with patch.dict("os.environ", {
                    "KB_JOURNEY_SELECTED_STEPS": "TEST-CLAIM.1",
                    "KB_JOURNEY_PREREQUISITE_STEPS": '["fixture producer"]',
            }, clear=True):
                journey = Journey("local", "fixture-group-selection")
                graph = FlowGraph(journey, {}, groups={
                    f"isolated-fixture:{name}": {
                        "cases": declaration["cases"],
                        "steps": declaration["steps"],
                    } for name, declaration in declarations.items()
                })
            self.assertTrue(graph.group_selected("isolated-fixture:selected_consumer"))
            self.assertTrue(graph.group_selected("isolated-fixture:fixture_producer"))

    def test_fixture_execution_and_host_cycle_use_outer_flow_graph(self):
        root = Path(__file__).resolve().parents[2]
        source = ast.parse((root / "e2e/journey/runner.py").read_text())
        calls = [node for node in ast.walk(source) if isinstance(node, ast.Call)]
        self.assertTrue(any(isinstance(call.func, ast.Attribute) and call.func.attr == "flow"
                            and isinstance(call.func.value, ast.Name) and call.func.value.id == "outer_graph"
                            and call.args and isinstance(call.args[0], ast.Attribute)
                            and call.args[0].attr == "__name__" for call in calls))
        self.assertTrue(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                            and node.func.attr == "group_selected" for node in ast.walk(source)))
        host_commands = {call.args[0].elts[1].value for call in calls
                         if isinstance(call.func, ast.Name) and call.func.id == "run"
                         and call.args and isinstance(call.args[0], ast.List)
                         and len(call.args[0].elts) > 1 and isinstance(call.args[0].elts[1], ast.Constant)}
        self.assertTrue({"stop", "start"}.issubset(host_commands))

    def test_registered_memory_rejects_helper_read_without_prerequisite(self):
        from service_steps import JourneyMemory, JourneyContractError
        memory = JourneyMemory({"setup": ((), ("project",))})
        with memory.activate("consumer", (), ()):
            with self.assertRaisesRegex(JourneyContractError, "undeclared dependency.*consumer.*project.*setup"):
                helper_read(memory, "project")

    def test_registered_memory_rejects_attribute_held_state_without_prerequisite(self):
        from service_steps import JourneyMemory, JourneyContractError
        holder = type("Holder", (), {})()
        holder.memory = JourneyMemory({"setup": ((), ("project",))})
        with holder.memory.activate("consumer", (), ()):
            with self.assertRaisesRegex(JourneyContractError, "undeclared dependency.*consumer.*project.*setup"):
                holder.memory.get("project")

    def test_registered_memory_rejects_undeclared_write(self):
        from service_steps import JourneyMemory, JourneyContractError
        memory = JourneyMemory({})
        with memory.activate("writer", (), ()):
            with self.assertRaisesRegex(JourneyContractError, "undeclared write.*writer.*project"):
                memory.set("project", "registered")

    def test_journey_records_undeclared_memory_read_as_harness_failure(self):
        journey = Journey("local", "memory-contract")
        journey.step("project setup", "test",
                     lambda: journey.memory.set("project", "registered"),
                     provides=("project",))
        result = journey.step("project consumer", "test",
                              lambda: helper_read(journey.memory, "project"))
        self.assertEqual(result.status, "FAIL")
        self.assertRegex(result.message,
                         r"harness defect: undeclared dependency: reader 'project consumer' "
                         r"reads key 'project' from producer 'project setup'")

    def test_module_global_state_lint_detects_shared_mutable_global(self):
        with tempfile.TemporaryDirectory(prefix="journey-global-state-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'shared = {}\n'
                'def produce():\n'
                '    shared["project"] = "registered"\n'
                'def check():\n'
                '    return shared.get("project")\n'
                'journey.step("project setup", "test", produce)\n'
                'journey.step("consumer", "test", check)\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "module-global-state lint detected"):
                lint_direct_module_global_state_handoffs({"fixture_steps.py"}, root)

    def test_module_global_state_lint_detects_attribute_held_global(self):
        with tempfile.TemporaryDirectory(prefix="journey-attribute-state-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'class Holder: pass\n'
                'state = Holder()\n'
                'state.values = {}\n'
                'def produce():\n'
                '    state.values["project"] = "registered"\n'
                'def check():\n'
                '    return state.values.get("project")\n'
                'journey.step("project setup", "test", produce)\n'
                'journey.step("consumer", "test", check)\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "module-global-state lint detected"):
                lint_direct_module_global_state_handoffs({"fixture_steps.py"}, root)

    def test_module_global_state_lint_detects_helper_mediated_global_read(self):
        with tempfile.TemporaryDirectory(prefix="journey-helper-state-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'shared = {}\n'
                'def produce():\n'
                '    shared["project"] = "registered"\n'
                'def helper():\n'
                '    return shared.get("project")\n'
                'def check():\n'
                '    return helper()\n'
                'journey.step("project setup", "test", produce)\n'
                'journey.step("consumer", "test", check)\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "module-global-state lint detected"):
                lint_direct_module_global_state_handoffs({"fixture_steps.py"}, root)

    def test_module_global_state_lint_follows_case_action_callback(self):
        with tempfile.TemporaryDirectory(prefix="journey-case-action-state-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'shared = {}\n'
                'def produce(case_ids):\n'
                '    shared["project"] = "registered"\n'
                'def check(case_ids):\n'
                '    return shared.get("project")\n'
                'journey.flow("project setup", "test", "test", None, '
                'cases=["S-001.1"], case_action=produce)\n'
                'journey.flow("project consumer", "test", "test", None, '
                'cases=["S-001.1"], case_action=check)\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "module-global-state lint detected"):
                lint_direct_module_global_state_handoffs({"fixture_steps.py"}, root)

    def test_environment_lint_detects_literal_kb_journey_read_outside_accessor(self):
        with tempfile.TemporaryDirectory(prefix="journey-env-state-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'import os\n'
                'value = os.environ.get("KB_JOURNEY_PROJECT_ID")\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "KB_JOURNEY_PROJECT_ID.*journey_values"):
                validate_journey_environment_reads({"fixture_steps.py"}, root)

    def test_environment_lint_rejects_computed_environment_key(self):
        with tempfile.TemporaryDirectory(prefix="journey-dynamic-env-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'import os\n'
                'def check(key):\n'
                '    return os.environ.get(key)\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "computed environment keys"):
                validate_journey_environment_reads({"fixture_steps.py"}, root)

    def test_journey_unknown_required_producer_is_runtime_contract_failure(self):
        journey = Journey("local", "unknown-memory-producer")
        result = journey.step("project consumer", "test", lambda: None,
                              cases=("S-042.1",), requires=("step:missing project producer",))
        self.assertEqual(result.status, "FAIL")
        self.assertIn("unknown journey prerequisite 'missing project producer'", result.message)
        self.assertEqual(journey.result().status, "FAIL")

    def test_dependency_lint_rejects_unknown_required_producer(self):
        with tempfile.TemporaryDirectory(prefix="journey-unknown-producer-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'def check(): return None\n'
                'journey.step("project consumer", "test", check, '
                'requires=("step:missing project producer",))\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(ValueError, "does not resolve to a declared"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_full_unselected_plan_matches_checked_in_golden(self):
        root = Path(__file__).resolve().parents[2]
        baseline_path = root / "e2e/journey/full-plan-baseline.json"
        expected = json.loads(baseline_path.read_text(encoding="utf-8"))
        actual = full_runner_plans(root)
        self.assertEqual(
            actual, expected,
            "full journey plan drifted; run python3 e2e/journey/select_from_cases.py "
            "--write-plan-baseline, then review the ordered plan diff before updating the golden",
        )

    def test_installed_host_stop_plan_barrier_follows_steps_before_lifecycle(self):
        root = Path(__file__).resolve().parents[2]
        plans = full_runner_plans(root)
        for selector, plan in plans.items():
            runner = RUNNERS[selector]
            sources = set().union(*(_imported_journey_sources({source}, root)
                                    for source in runner.journey_sources))
            declarations = [declaration for declaration in _source_step_declarations(sources, root).values()
                            if declaration.get("name") is not None
                            and (not declaration.get("runners") or selector in declaration["runners"])]
            barrier = next(declaration for declaration in declarations
                           if declaration.get("plan_after_phase") == "all-steps")
            teardown = next(declaration for declaration in declarations
                            if declaration.get("plan_phase") == "teardown")
            self.assertEqual(plan[-2:], [barrier["name"], teardown["name"]], selector)

    def test_full_runner_plan_rejects_missing_or_duplicate_ordering_markers(self):
        root = Path(__file__).resolve().parents[2]
        invalid_counts = (
            (0, 1),
            (1, 0),
            (0, 0),
            (2, 1),
            (1, 2),
        )
        for barrier_count, teardown_count in invalid_counts:
            with self.subTest(barriers=barrier_count, teardowns=teardown_count):
                declarations = {"step": {"name": "regular journey step"}}
                for index in range(barrier_count):
                    declarations[f"barrier-{index}"] = {
                        "name": f"barrier {index}", "plan_after_phase": "all-steps",
                    }
                for index in range(teardown_count):
                    declarations[f"teardown-{index}"] = {
                        "name": f"teardown {index}", "plan_phase": "teardown", "role": "lifecycle",
                    }
                with patch("select_from_cases.RUNNERS", {
                        "fixture-plan": SimpleNamespace(journey_sources=("fixture.py",))}), \
                        patch("select_from_cases._imported_journey_sources",
                              side_effect=lambda sources, _root: frozenset(sources)), \
                        patch("select_from_cases._source_step_declarations", return_value=declarations):
                    with self.assertRaisesRegex(
                            ValueError,
                            rf"fixture-plan:.*barrier.*{barrier_count}.*teardown.*{teardown_count}"):
                        full_runner_plans(root)

    def test_service_readiness_claim_uses_registered_project_state(self):
        resolved = selection_from_coverage(self._coverage(), "PC-002.3")
        self.assertEqual(resolved["prerequisiteSteps"], [])
        self.assertIn("e2e/journey/service_runner.py", resolved["stepSources"])

    def test_fresh_install_claim_resolves_candidate_provenance(self):
        resolved = selection_from_coverage(self._coverage(), "PC-001.2")
        self.assertEqual(resolved["prerequisiteSteps"], ["candidate provenance"])

    def test_installed_smoke_claims_resolve_to_one_service_runner_per_mode(self):
        root = Path(__file__).resolve().parents[2]
        smoke_source = (root / "e2e/journey/smoke.sh").read_text(encoding="utf-8")
        smoke_selection = re.search(r'^export KB_JOURNEY_CASES="([^"]+)"$', smoke_source, re.MULTILINE)
        self.assertIsNotNone(smoke_selection)
        selected_claims = set(smoke_selection.group(1).split(","))
        registrations: dict[str, list[tuple[str, dict]]] = {}
        runner_sources = {}
        for selector, runner in RUNNERS.items():
            if not runner.service_profile:
                continue
            runner_sources[selector] = _imported_journey_sources(set(runner.journey_sources), root)
        for source in set().union(*runner_sources.values()):
            declarations_by_signature = {}
            for declaration in _case_declarations(source, root).values():
                signature = (declaration["name"], tuple(declaration.get("cases") or ()),
                             tuple(declaration["requires"]), tuple(declaration["runners"]))
                declarations_by_signature[signature] = declaration
            for declaration in declarations_by_signature.values():
                for claim_id in declaration.get("cases") or ():
                    registrations.setdefault(claim_id, []).append((source, declaration))

        for mode in ("local", "secured"):
            mode_branch = re.search(
                rf"(?ms)^  {mode}\)\s+export KB_JOURNEY_ONLY=\"([^\"]+)\"",
                smoke_source,
            )
            self.assertIsNotNone(mode_branch)
            selector = mode_branch.group(1)
            runner = RUNNERS[selector]
            declarations = _source_step_declarations(runner_sources[selector], root)
            claim_prerequisites = set()
            for claim_id in selected_claims:
                with self.subTest(mode=mode, claim=claim_id):
                    owners = []
                    for source, declaration in registrations.get(claim_id, []):
                        declared_runners = declaration["runners"] or runners_for_source(source, mode)
                        if selector in declared_runners and source in runner_sources[selector]:
                            owners.append((source, declaration))
                    self.assertEqual(len(owners), 1, f"{claim_id} must have one registration on {selector}")
                    claim_source, declaration = owners[0]
                    for prerequisite_name in declaration["requires"]:
                        prerequisite = declarations[prerequisite_name]
                        self.assertTrue(prerequisite["sources"].intersection(runner_sources[selector]))
                        claim_prerequisites.add(prerequisite_name)

            self.assertEqual(
                {claim_id for claim_id in registrations if any(
                    selector in (declaration["runners"] or runners_for_source(source, mode))
                    for source, declaration in registrations[claim_id]
                    if source in runner_sources[selector])}.intersection(selected_claims),
                selected_claims,
            )
            self.assertTrue(claim_prerequisites)

    def test_s100_1_selects_both_bootstrap_secret_scans_and_update_journey(self):
        resolved = selection_from_coverage(self._coverage(), "S-100.1")
        self.assertEqual(resolved["runners"], ["service-secured:explore"])
        self.assertIn("e2e/journey/bootstrap_secret_steps.py", resolved["stepSources"])
        self.assertIn("e2e/journey/platform_update_steps.py", resolved["stepSources"])
        self.assertIn("roll back to version N with explicit non-TTY confirmation", resolved["prerequisiteSteps"])
        self.assertIn("reject a missing snapshot without changing the active install", resolved["prerequisiteSteps"])
        root = Path(__file__).resolve().parents[2]
        declarations = [declaration
                       for source in ("e2e/journey/bootstrap_secret_steps.py",
                                      "e2e/journey/platform_update_steps.py")
                       for declaration in _case_declarations(source, root).values()
                       if "S-100.1" in (declaration.get("cases") or ())]
        scans = {declaration["name"]: declaration for declaration in declarations
                 if declaration["name"].startswith("verify disclosed bootstrap credential absent")}
        self.assertEqual(set(scans), {
            "verify disclosed bootstrap credential absent after install",
            "verify disclosed bootstrap credential absent after update and rollback",
        })
        self.assertTrue(all("service-secured:explore" in declaration["runners"]
                            for declaration in scans.values()))
        rollback_scan = scans["verify disclosed bootstrap credential absent after update and rollback"]
        self.assertEqual(rollback_scan["requires"], [
            "step:verify restored receipt, config, host, and project command",
        ])

    def test_s181_3_selects_the_supplied_password_install_file_scan(self):
        resolved = selection_from_coverage(self._coverage(), "S-181.3")
        self.assertEqual(resolved["runners"], ["agent-secured:commit", "agent:commit"])
        self.assertIn("e2e/journey/bootstrap_secret_steps.py", resolved["stepSources"])
        self.assertIn("e2e/journey/installer_case_steps.py", resolved["stepSources"])
        root = Path(__file__).resolve().parents[2]
        declarations = _case_declarations("e2e/journey/bootstrap_secret_steps.py", root).values()
        scan = next(declaration for declaration in declarations
                    if declaration["name"] == "verify supplied bootstrap credential absent from install files")
        self.assertEqual(scan["cases"], ["S-181.3"])
        self.assertEqual(scan["runners"], ["agent-secured:commit", "agent:commit"])

    def test_s181_6_selects_the_installed_secret_input_refusal_step(self):
        resolved = selection_from_coverage(self._coverage(), "S-181.6")
        self.assertEqual(resolved["runners"], ["service-local:explore", "service-secured:explore"])
        self.assertIn("e2e/journey/installer_case_steps.py", resolved["stepSources"])
        root = Path(__file__).resolve().parents[2]
        declarations = _case_declarations("e2e/journey/installer_case_steps.py", root).values()
        refusal = next(declaration for declaration in declarations
                       if declaration["name"] == "refuse undeclared secret environment inputs before writing state")
        self.assertEqual(refusal["cases"], ["S-181.6"])
        self.assertEqual(refusal["runners"], ["service-local:explore", "service-secured:explore"])
        self.assertIn("step:apply a secret through an environment reference", refusal["requires"])

    def test_every_active_journey_claim_resolves_its_runner_and_prerequisites(self):
        results = []
        root = Path(__file__).resolve().parents[2]
        node = shutil.which("node")
        self.assertIsNotNone(node, "A Node.js executable is required to run the workspace CLI")
        for mode in ("local", "secured"):
            command = [node, str(root / "cli/bin/dist/bin.js"), "qa", "coverage", "show", "--level", "all",
                       "--mode", mode, "--json"]
            result = run_hermetic_cli(command, cwd=root, env=os.environ, timeout=120,
                                      workspace_root=root)
            self.assertEqual(result.returncode, 0, result.stderr)
            results.append(read_coverage_result(result))

        registered: dict[str, dict[str, set[tuple[str, int]]]] = {}
        root = Path(__file__).resolve().parents[2]
        for coverage in results:
            mode = coverage["mode"]
            for case in coverage.get("cases", []):
                if case.get("status") != "active":
                    continue
                for step in case.get("steps", []):
                    step_id = step.get("stepId")
                    for claim in step.get("claims", []):
                        if claim.get("kind") not in {"journey", "e2e"}:
                            continue
                        source = str(claim.get("source", ""))
                        if source:
                            registered.setdefault(mode, {}).setdefault(step_id, set()).add(
                                (source, int(claim.get("line", 0))))

        self.assertTrue(registered, "QA claim registry returned no active journey claims")
        resolved_counts = {mode: 0 for mode in registered}
        refused_claims: dict[str, dict[str, str]] = {mode: {} for mode in registered}
        for mode, claims_by_step in registered.items():
            coverage = next(item for item in results if item["mode"] == mode)
            for step_id, claims in claims_by_step.items():
                with self.subTest(mode=mode, step_id=step_id):
                    declarations = [_step_declaration(source, line, root)
                                    for source, line in claims if source.endswith(".py")]
                    expected_routes = set()
                    for source, line in claims:
                        declaration = _step_declaration(source, line, root) if source.endswith(".py") else {}
                        routes = declaration.get("runners") or runners_for_source(source, mode)
                        expected_routes.update(selector for selector in routes
                                               if selector in RUNNERS and
                                               RUNNERS[selector].mode == mode)
                    try:
                        resolved = selection_from_coverage([coverage], step_id)
                    except ValueError as error:
                        self.assertFalse(expected_routes, f"{step_id} has executable routes but was refused: {error}")
                        self.assertIn("no executable registration", str(error),
                                      f"{step_id} was refused for an unrelated reason: {error}")
                        refused_claims[mode][step_id] = str(error)
                        continue
                    resolved_counts[mode] += 1
                    self.assertTrue(expected_routes, f"{step_id} resolved without an eligible registration")
                    self.assertIn(step_id, resolved["steps"])
                    self.assertEqual(set(resolved["runners"]), expected_routes)
                    self.assertTrue(all(selector in RUNNERS for selector in resolved["runners"]))
                    for selector in resolved["runners"]:
                        self.assertIn(step_id, resolved["owners"].get(selector, []),
                                      f"plan routed {step_id} to {selector} without its emitter")
                    direct_prerequisites = {
                        str(dependency)
                        for item in declarations
                        for reference in item.get("requires", [])
                        if (dependency := Dependency.parse(reference)).kind in {"step", "flow"}
                    }
                    prerequisites = {f"step:{name}" for name in resolved["prerequisiteSteps"]}
                    prerequisites.update(f"flow:{name}" for name in resolved["prerequisiteFlows"])
                    self.assertTrue(direct_prerequisites.issubset(prerequisites))
                    graph = _source_step_declarations(set(resolved["stepSources"]), root)
                    for name in prerequisites:
                        with self.subTest(mode=mode, step_id=step_id, prerequisite=name):
                            self.assertIn(name, graph, f"declared prerequisite {name!r} has no step declaration")
                            self.assertTrue(graph[name]["sources"].intersection(resolved["stepSources"]))
                            required = {Dependency.parse(reference)
                                        for reference in graph[name]["requires"]}
                            self.assertTrue({str(item) for item in required if item.kind in {"step", "flow"}}
                                            .issubset(prerequisites),
                                            f"prerequisite closure omitted a dependency of {name!r}")
                            self.assertTrue({item.name for item in required if item.kind == "state"}
                                            .issubset(FLOW_GRAPH_STATE_PRODUCERS),
                                            f"prerequisite closure names an unregistered state of {name!r}")

        for mode, claims_by_step in registered.items():
            print(f"whole-coverage resolution {mode}: {len(claims_by_step)} claims, "
                  f"{resolved_counts[mode]} routed, {len(refused_claims[mode])} refused")
            for step_id, reason in sorted(refused_claims[mode].items()):
                print(f"refused {mode} {step_id}: {reason}")

        default_matrix = selectors_from_coverage(results)
        for selector in default_matrix:
            runner = RUNNERS[selector]
            reachable = set().union(*(_imported_journey_sources({source}, root)
                                      for source in runner.journey_sources))
            registrations = _source_step_declarations(reachable, root)
            full_plan = [(key, declaration) for key, declaration in registrations.items()
                         if declaration.get("name") is not None
                         and (not declaration.get("runners") or selector in declaration["runners"])]
            with self.subTest(full_run=selector), patch.dict(os.environ, {
                    "KB_JOURNEY_CASES": "", "KB_JOURNEY_SELECTED_STEPS": "",
                    "KB_JOURNEY_RUNNER_SELECTOR": selector,
            }, clear=False):
                journey = Journey(runner.mode, f"full-plan-{selector}")
                for _, declaration in full_plan:
                    journey.step(declaration["name"], "journey.registry", lambda: None)
                self.assertEqual([step.name for step in journey.steps],
                                 [declaration["name"] for _, declaration in full_plan])
                self.assertTrue(all(step.status == "PASS" for step in journey.steps))

    def test_resolver_names_update_owners_and_prerequisites(self):
        resolved = resolve_selection(
            ["S-023.2"],
            {"S-023.2": {"e2e/journey/platform_update_steps.py"}},
            {"S-023.2": [{"kind": "step", "name": "plan the newer sealed release",
                           "requires": ["step:candidate provenance"]}]},
            {"step:candidate provenance": {"sources": {"e2e/journey/runner.py"}, "requires": []}},
            {"S-023.2": {"agent:commit": {"S-023.2"}}},
            "",
        )
        self.assertEqual(resolved["selectedOwningSteps"], {
            "candidate provenance": ["S-023.2"],
            "plan the newer sealed release": ["S-023.2"],
        })

    def test_flow_graph_uses_resolved_step_names_to_select_update_journey(self):
        with patch.dict(os.environ, {
                "KB_JOURNEY_SELECTED_STEPS": "S-023.2",
                "KB_JOURNEY_SELECTED_OWNING_STEPS": json.dumps({"plan the newer sealed release": ["S-023.2"]}),
                "KB_JOURNEY_PREREQUISITE_STEPS": '["candidate provenance"]',
        }, clear=True):
            journey = Journey("local", "update-step-selection")
            graph = FlowGraph(journey, {}, groups={"update": {
                "cases": ("S-023.2",), "steps": ("plan the newer sealed release",),
            }})
            self.assertTrue(graph.group_selected("update"))
            self.assertTrue(graph.selects_steps("plan the newer sealed release"))

    def test_resolver_group_declaration_follows_local_helper_imports(self):
        with tempfile.TemporaryDirectory(prefix="journey-source-group-") as temporary:
            root = Path(temporary)
            helper = root / "e2e/journey/owner_steps.py"
            runner = root / "e2e/journey/update_steps.py"
            helper.parent.mkdir(parents=True)
            helper.write_text(
                "def register(journey):\n"
                "    journey.step('helper-owned claim', 'update', lambda: None, cases=['TEST-UPDATE.1'])\n",
                encoding="utf-8",
            )
            runner.write_text("from owner_steps import register\ndef run(journey):\n    register(journey)\n",
                              encoding="utf-8")
            declaration = journey_source_group_declaration("e2e/journey/update_steps.py", root)
        self.assertEqual(declaration, {
            "cases": ("TEST-UPDATE.1",), "steps": ("helper-owned claim",),
        })

    def test_source_file_selection_gate_is_removed(self):
        root = Path(__file__).resolve().parents[2]
        source = (root / "e2e/journey/runner.py").read_text()
        values = (root / "e2e/journey/service_steps.py").read_text()
        shell = (root / "e2e/journey/run.sh").read_text()
        self.assertNotIn("def source_selected", source)
        self.assertNotIn("source_selected", values)
        self.assertNotIn("KB_JOURNEY_SELECTED_SOURCES", shell + values)
        self.assertIn("journey_source_group_declaration", source)

    def test_selected_owning_steps_are_forwarded_to_the_runner_container(self):
        root = Path(__file__).resolve().parents[2]
        shell = (root / "e2e/journey/run.sh").read_text(encoding="utf-8")
        self.assertIn("export KB_JOURNEY_SELECTED_OWNING_STEPS=", shell)
        self.assertIn("-e KB_JOURNEY_SELECTED_OWNING_STEPS", shell)

    def test_selected_update_and_marketplace_claims_select_the_declared_units(self):
        coverage = self._coverage()
        base_update = selection_from_coverage(coverage, "S-023.2")
        self.assertIn("start platform host", base_update["prerequisiteFlows"])
        env = {
            "KB_JOURNEY_SELECTED_STEPS": ",".join(base_update["steps"]),
            "KB_JOURNEY_PREREQUISITE_STEPS": json.dumps(base_update["prerequisiteSteps"]),
            "KB_JOURNEY_PREREQUISITE_FLOWS": json.dumps(base_update["prerequisiteFlows"]),
        }
        with patch.dict(os.environ, env, clear=False):
            journey = Journey("local", "selected-flow-closure")
            graph = FlowGraph(journey, {})
            status = graph.flow(
                "start platform host", "host", "platform.host",
                lambda: journey.step("start host", "platform.host", lambda: None, cases=["PC-002.1"]),
                cases=["PC-002.1"],
            )
            self.assertEqual(status, "PASS")
            self.assertEqual(next(step.status for step in journey.steps if step.name == "start host"), "PASS")
            self.assertEqual(journey.flows["start platform host"][0], "PASS")

        variant = selection_from_coverage(coverage, "S-023.9")
        self.assertIn("platform_update_variant_steps.py", ",".join(variant["stepSources"]))
        self.assertIn("start platform host", variant["prerequisiteFlows"])
        marketplace = selection_from_coverage(coverage, "S-010.4")
        self.assertIn("install Commit into the project for the route lifecycle",
                      marketplace["prerequisiteSteps"])
        self.assertTrue(any(source.endswith("marketplace_steps.py") for source in marketplace["stepSources"]))

    def test_static_dependency_rail_reports_unresolvable_name_at_declaration(self):
        with tempfile.TemporaryDirectory(prefix="journey-dependency-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'journey.step("consumer", "test", check, requires=("step:typo",))\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(ValueError, r"fixture_steps.py:1: 'step:typo'.*does not resolve"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_static_dependency_rail_rejects_runner_conditional_step_prerequisite(self):
        with tempfile.TemporaryDirectory(prefix="journey-conditional-prerequisite-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'def register(journey, check):\n'
                '    if FRONT == "agent":\n'
                '        journey.step("conditional project registration", "test", lambda: None)\n'
                '    journey.step("consumer", "test", lambda: None, requires=("step:conditional project registration",))\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(
                        ValueError,
                        r"fixture_steps.py:3: step prerequisite 'conditional project registration'.*runner condition"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_static_dependency_rail_resolves_registered_flow_graph_state(self):
        with tempfile.TemporaryDirectory(prefix="journey-state-prerequisite-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'journey.step("consumer", "test", lambda: None, requires=("state:project-registered",))\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                declarations = validate_dependency_declarations({"fixture_steps.py"}, root)
            self.assertIn("step:consumer", declarations)

    def test_static_dependency_rail_rejects_untyped_dependency_names(self):
        with tempfile.TemporaryDirectory(prefix="journey-untyped-dependency-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'journey.step("consumer", "test", check, requires=("candidate provenance",))\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(
                        ValueError,
                        r"fixture_steps.py:1: invalid journey dependency.*use 'step:<name>'.*'state:<name>'"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_static_dependency_rail_checks_edges_when_step_name_is_dynamic(self):
        with tempfile.TemporaryDirectory(prefix="journey-dynamic-name-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'journey.step(name, "test", check, requires=("step:missing",))\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(
                        ValueError,
                        r"fixture_steps.py:1: 'step:missing'.*does not resolve"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_dynamic_step_name_is_not_a_selector_producer(self):
        with tempfile.TemporaryDirectory(prefix="journey-dynamic-producer-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'journey.step(name, "test", check)\n'
                'journey.step("consumer", "test", check, requires=("step:runtime-name",))\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(
                        ValueError,
                        r"fixture_steps.py:2: 'step:runtime-name'.*does not resolve"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_static_dependency_rail_follows_forwarded_requires_to_call_sites(self):
        with tempfile.TemporaryDirectory(prefix="journey-forwarded-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'def record(journey, name, check, *, requires=()):\n'
                '    journey.step(name, "test", check, requires=requires)\n'
                'def run(journey, check):\n'
                '    record(journey, "consumer", check, requires=("step:misspelled",))\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(
                        ValueError,
                        r"fixture_steps.py:4: 'step:misspelled'.*does not resolve"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_static_dependency_rail_rejects_computed_requires(self):
        with tempfile.TemporaryDirectory(prefix="journey-computed-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'journey.step("consumer", "test", check, requires=dependencies)\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(
                        ValueError,
                        r"fixture_steps.py:1: dependency declaration is not statically resolvable"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_forwarded_computed_requires_fails_at_call_site(self):
        with tempfile.TemporaryDirectory(prefix="journey-forwarded-computed-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'def record(journey, name, check, *, requires=()):\n'
                '    journey.step(name, "test", check, requires=requires)\n'
                'def run(journey, check, dependencies):\n'
                '    record(journey, "consumer", check, requires=dependencies)\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(
                        ValueError,
                        r"fixture_steps.py:4: dependency declaration is not statically resolvable"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_static_dependency_rail_rejects_keyword_expansion(self):
        with tempfile.TemporaryDirectory(prefix="journey-kwargs-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'journey.step("consumer", "test", check, **options)\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(
                        ValueError,
                        r"fixture_steps.py:1: dependency declaration is not statically resolvable"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_module_global_state_lint_detects_shared_state_read(self):
        with tempfile.TemporaryDirectory(prefix="journey-state-dependency-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'shared_state = {}\n'
                'def produce():\n'
                '    shared_state["project"] = "registered"\n'
                'def consume():\n'
                '    return shared_state.get("project")\n'
                'journey.step("project setup", "test", produce)\n'
                'journey.step("project consumer", "test", consume)\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, r"module-global-state lint detected.*'shared_state'"):
                lint_direct_module_global_state_handoffs({"fixture_steps.py"}, root)

    def test_module_global_state_lint_detects_dynamic_key_read(self):
        with tempfile.TemporaryDirectory(prefix="journey-dynamic-state-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'shared_state = {}\n'
                'def produce():\n'
                '    shared_state["project"] = "registered"\n'
                'def consume():\n'
                '    return shared_state[key]\n'
                'journey.step("project setup", "test", produce)\n'
                'journey.step("project consumer", "test", consume)\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, r"module-global-state lint detected.*'shared_state'"):
                lint_direct_module_global_state_handoffs({"fixture_steps.py"}, root)

    def test_runner_condition_rail_rejects_unowned_conditional_registration(self):
        with tempfile.TemporaryDirectory(prefix="journey-runner-condition-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'if VARIANT == "interactive":\n'
                '    journey.step("conditional claim", "test", check, cases=["S-900.1"])\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, r"fixture_steps.py:2: claim registration is conditional"):
                validate_runner_conditions({"fixture_steps.py"}, root)

    def test_static_dependency_rail_rejects_partial_recorder(self):
        with tempfile.TemporaryDirectory(prefix="journey-partial-recorder-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'from functools import partial\n'
                'record = partial(journey.step, "consumer", "test", check, requires=("step:missing",))\n'
                'record()\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(
                        ValueError,
                        r"fixture_steps.py:2: recorder must be called directly so its dependencies are statically visible"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_static_dependency_rail_rejects_recorder_alias(self):
        with tempfile.TemporaryDirectory(prefix="journey-alias-recorder-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'rec = journey.step\n'
                'rec("consumer", "test", check, requires=("step:missing",))\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(
                        ValueError,
                        r"fixture_steps.py:1: recorder must be called directly so its dependencies are statically visible"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def test_static_dependency_rail_rejects_recorder_callback(self):
        with tempfile.TemporaryDirectory(prefix="journey-callback-recorder-rail-") as directory:
            root = Path(directory)
            (root / "fixture_steps.py").write_text(
                'register_callback(journey.step)\n',
                encoding="utf-8",
            )
            with patch("select_from_cases.RUNNERS", {
                    "fixture": SimpleNamespace(journey_sources=("fixture_steps.py",))}):
                with self.assertRaisesRegex(
                        ValueError,
                        r"fixture_steps.py:1: recorder must be called directly so its dependencies are statically visible"):
                    validate_dependency_declarations({"fixture_steps.py"}, root)

    def _coverage(self):
        root = Path(__file__).resolve().parents[2]
        node = shutil.which("node")
        self.assertIsNotNone(node)
        results = []
        for mode in ("local", "secured"):
            command = [node, str(root / "cli/bin/dist/bin.js"), "qa", "coverage", "show", "--level", "all",
                       "--mode", mode, "--json"]
            result = run_hermetic_cli(command, cwd=root, env=os.environ, timeout=120,
                                      workspace_root=root)
            self.assertEqual(result.returncode, 0, result.stderr)
            results.append(read_coverage_result(result))
        return results


if __name__ == "__main__":
    unittest.main()
