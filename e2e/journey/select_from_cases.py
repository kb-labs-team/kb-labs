#!/usr/bin/env python3
"""Select journey entry points from release cases claimed by executable flows.

The declaration parser and the module-global-state lint inspect specific AST
forms. They do not prove that all callback state is declared; closure-held
state and FlowGraph state remain outside this lint. Runtime JourneyMemory
checks apply to the keys explicitly routed through that container.
"""
from __future__ import annotations

import json
import os
import ast
import sys
from functools import lru_cache
from pathlib import Path

from hermetic_cli import run_hermetic_cli
from invocations import (
    CompletedProcess,
    decode_ux_success_result,
    describe_cli_failure,
    invocation_context,
    print_report_text,
    read_ux_cli_result,
)
from dispatch_registry import RUNNERS, RUNNER_GROUPS, lanes_for_runners, runners_for_source
from journey_dependencies import Dependency, FLOW_GRAPH_STATE_PRODUCERS
from journey_selection import read_journey_selection, read_requested_cases
from journey_resources import resource_root
from journey_values import journey_value


RUNNER_CONTEXT_NAMES = {"FRONT", "FRONT_DOOR", "SCENARIO", "VARIANT", "mode",
                        "local_service_journey", "secured_service_journey", "BASE_ENV"}


def _call_name(call: ast.Call) -> str:
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    if isinstance(call.func, ast.Name):
        return call.func.id
    return ""


@lru_cache(maxsize=None)
def _source_tree(source: str, root: Path) -> ast.Module:
    path = root / source
    try:
        return ast.parse(path.read_text(encoding="utf-8"), filename=source)
    except (OSError, SyntaxError) as error:
        raise ValueError(f"cannot read journey step declarations in {source}: {error}") from error


@lru_cache(maxsize=None)
def _case_declarations(source: str, root: Path) -> dict[int, dict]:
    """Index step declarations by their source lines once per claim module."""
    path = root / source
    if not path.is_file():
        raise ValueError(f"journey claim source does not exist: {source}")
    if path.suffix != ".py":
        return {}
    tree = _source_tree(source, root)
    calls = [node for node in ast.walk(tree)
             if isinstance(node, ast.Call)
             and any(keyword.arg == "cases" for keyword in node.keywords)]
    declarations: dict[int, dict] = {}
    for call in sorted(calls, key=lambda item: item.end_lineno - item.lineno):
        name = call.args[0].value if call.args and isinstance(call.args[0], ast.Constant) else None
        if not isinstance(name, str):
            continue
        keywords = {keyword.arg: keyword.value for keyword in call.keywords}
        prerequisites = keywords.get("requires")
        role = keywords.get("role")
        plan_after_phase = keywords.get("plan_after_phase")
        plan_phase = keywords.get("plan_phase")
        runners_node = keywords.get("runners")
        runners = []
        if runners_node is not None:
            if not isinstance(runners_node, (ast.Tuple, ast.List)):
                raise ValueError(f"runners= in {source}:{call.lineno} must contain literal runner selectors")
            for item in runners_node.elts:
                if not isinstance(item, ast.Constant) or not isinstance(item.value, str):
                    raise ValueError(f"runners= in {source}:{call.lineno} must contain literal runner selectors")
                if item.value not in RUNNERS:
                    raise ValueError(f"{source}:{call.lineno}: unknown registered journey runner {item.value!r}")
                runners.append(item.value)
        function = call.func.attr if isinstance(call.func, ast.Attribute) else (
            call.func.id if isinstance(call.func, ast.Name) else "")
        capability_index = 2 if function == "flow" else 1
        capability = (call.args[capability_index].value
                      if len(call.args) > capability_index
                      and isinstance(call.args[capability_index], ast.Constant)
                      and isinstance(call.args[capability_index].value, str) else None)
        if prerequisites is None:
            required = []
        elif isinstance(prerequisites, (ast.Tuple, ast.List)):
            required = []
            for item in prerequisites.elts:
                if not isinstance(item, ast.Constant) or not isinstance(item.value, str):
                    raise ValueError(f"requires= in {source}:{call.lineno} must contain literal dependency references")
                try:
                    required.append(str(Dependency.parse(item.value)))
                except ValueError as error:
                    raise ValueError(f"{source}:{call.lineno}: {error}") from error
        else:
            raise ValueError(f"step {name!r} in {source} must declare prerequisites as a literal sequence")
        role_name = role.value if isinstance(role, ast.Constant) else None
        if plan_after_phase is not None and (
                not isinstance(plan_after_phase, ast.Constant)
                or plan_after_phase.value != "all-steps"):
            raise ValueError(f"{source}:{call.lineno}: plan_after_phase must be 'all-steps'")
        if plan_phase is not None and (
                not isinstance(plan_phase, ast.Constant)
                or plan_phase.value != "teardown"
                or role_name != "lifecycle"):
            raise ValueError(f"{source}:{call.lineno}: plan_phase must be 'teardown' on a lifecycle step")
        provides_node = keywords.get("provides")
        if provides_node is None:
            provides = []
        elif isinstance(provides_node, (ast.Tuple, ast.List)):
            if any(not isinstance(item, ast.Constant) or not isinstance(item.value, str)
                   for item in provides_node.elts):
                raise ValueError(f"provides= in {source}:{call.lineno} must contain literal state keys")
            provides = [item.value for item in provides_node.elts]
        else:
            raise ValueError(f"provides= in {source}:{call.lineno} must contain a literal sequence")
        declaration = {"name": name, "kind": "flow" if function == "flow" else "step",
                       "capability": capability,
                       "requires": required, "provides": provides,
                       "role": role_name, "runners": runners,
                       "plan_after_phase": plan_after_phase.value if plan_after_phase is not None else None,
                       "plan_phase": plan_phase.value if plan_phase is not None else None}
        cases_node = keywords.get("cases")
        if isinstance(cases_node, (ast.Tuple, ast.List)) and all(
                isinstance(item, ast.Constant) and isinstance(item.value, str)
                for item in cases_node.elts):
            declaration["cases"] = [item.value for item in cases_node.elts]
        else:
            declaration["cases"] = None
        for line in range(call.lineno, call.end_lineno + 1):
            declarations.setdefault(line, declaration)
    return declarations


def _step_declaration(source: str, line: int, root: Path) -> dict:
    """Read a step's static declaration from its actual claim callsite."""
    if (root / source).suffix != ".py":
        return {}
    declaration = _case_declarations(source, root).get(line)
    if declaration is None:
        raise ValueError(f"journey claim at {source}:{line} has no declared step call with cases")
    return declaration


def _source_step_declarations(sources: set[str], root: Path) -> dict[str, dict]:
    """Index declarations reachable from the executable journey entry points."""
    entrypoints = {source for runner in RUNNERS.values() for source in runner.journey_sources}
    expanded = _imported_journey_sources(sources | entrypoints, root)
    return _source_step_declarations_cached(tuple(sorted(expanded)), root)


def fixture_group_declarations(groups, selector: str, root: Path) -> dict[str, dict[str, tuple[str, ...]]]:
    """Project registered fixture claims and step names into outer graph metadata.

    Claim ownership is extracted here; the shared resolver supplies prerequisite step
    names, and FlowGraph remains the sole selection gate and skipped-flow writer.
    """
    if selector and selector not in RUNNERS:
        raise ValueError(f"unknown registered journey runner {selector!r}")
    modes = {RUNNERS[selector].mode} if selector else {runner.mode for runner in RUNNERS.values()}

    def declaration_runners(declaration: dict, source: str) -> set[str]:
        declared = set(declaration["runners"])
        if declared:
            return declared
        return set().union(*(runners_for_source(source, mode) for mode in modes))

    declarations_by_group: dict[str, dict[str, set[str]]] = {}
    for group in groups:
        source_path = Path(group.__code__.co_filename).resolve()
        try:
            source = source_path.relative_to(root.resolve()).as_posix()
        except ValueError as error:
            raise ValueError(f"fixture group {group.__name__!r} is outside the journey source tree") from error
        tree = _source_tree(source, root)
        owner = next((node for node in ast.walk(tree)
                      if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                      and node.name == group.__name__), None)
        if owner is None:
            raise ValueError(f"fixture group {group.__name__!r} has no registered source function")
        source_registry = _source_step_declarations({source}, root)
        steps = set()
        for declaration in source_registry.values():
            runners = declaration_runners(declaration, source)
            if (selector and selector not in runners):
                continue
            if any(registered_source == source and owner.lineno <= line <= owner.end_lineno
                   for registered_source, line, _ in declaration.get("locations", ())):
                steps.add(declaration["name"])
        claims = set()
        for line, declaration in _case_declarations(source, root).items():
            runners = declaration_runners(declaration, source)
            if owner.lineno <= line <= owner.end_lineno and (not selector or selector in runners):
                claims.update(declaration.get("cases") or ())
        declarations_by_group[group.__name__] = {"cases": claims, "steps": steps}

    result = {}
    for group_name, declarations in declarations_by_group.items():
        result[group_name] = {
            "cases": tuple(sorted(declarations["cases"])),
            "steps": tuple(sorted(declarations["steps"])),
        }
    return result


def _imported_journey_sources(sources: set[str], root: Path) -> set[str]:
    """Follow local imports from the claim registry to find shared step declarations."""
    return set(_imported_journey_sources_cached(tuple(sorted(sources)), root))


def journey_source_group_declaration(source: str, root: Path,
                                     selector: str = "") -> dict[str, tuple[str, ...]]:
    """Resolve every step and claim registered by a journey module and its local imports."""
    sources = _imported_journey_sources({source}, root)
    registrations = _source_step_declarations(sources, root)
    cases: set[str] = set()
    steps: set[str] = set()
    mode = RUNNERS[selector].mode if selector else ""
    for declaration in registrations.values():
        name = declaration.get("name")
        if name is None:
            continue
        declared_runners = declaration.get("runners", ())
        if selector:
            if declared_runners and selector not in declared_runners:
                continue
            if not declared_runners and RUNNERS[selector].lane:
                continue
        steps.add(str(name))
    for registered_source in sources:
        for declaration in _case_declarations(registered_source, root).values():
            declared_runners = declaration.get("runners") or ()
            if selector:
                if declared_runners and selector not in declared_runners:
                    continue
                if not declared_runners and RUNNERS[selector].lane:
                    continue
            cases.update(str(case) for case in declaration.get("cases") or ())
    return {"cases": tuple(sorted(cases)), "steps": tuple(sorted(steps))}


def _validate_recorder_attribute_references(source: str, tree: ast.Module) -> None:
    """Require recorder attributes to be called directly so dependencies stay visible."""
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute) or node.attr not in {"step", "flow"}:
            continue
        parent = parents.get(node)
        if not isinstance(parent, ast.Call) or parent.func is not node:
            raise ValueError(
                f"{source}:{node.lineno}: recorder must be called directly so its dependencies are statically visible"
            )


@lru_cache(maxsize=None)
def _imported_journey_sources_cached(sources: tuple[str, ...], root: Path) -> frozenset[str]:
    found = set(sources)
    pending = list(sources)
    while pending:
        source = pending.pop()
        path = root / source
        if not path.is_file() or path.suffix != ".py":
            continue
        tree = _source_tree(source, root)
        imports: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module)
        for module in imports:
            parts = module.split(".")
            candidates = [path.parent.joinpath(*parts).with_suffix(".py"),
                          root.joinpath("e2e/journey", *parts).with_suffix(".py")]
            for candidate in candidates:
                if candidate.is_file():
                    discovered = candidate.relative_to(root).as_posix()
                    if discovered not in found:
                        found.add(discovered)
                        pending.append(discovered)
                    break
    return frozenset(found)


@lru_cache(maxsize=None)
def _source_step_declarations_cached(sources: tuple[str, ...], root: Path) -> dict[str, dict]:
    declarations: dict[str, dict] = {}
    trees = {source: _source_tree(source, root) for source in sources
             if (root / source).is_file() and (root / source).suffix == ".py"}
    for source, tree in trees.items():
        _validate_recorder_attribute_references(source, tree)
    forwarding: list[tuple[str, ast.FunctionDef | ast.AsyncFunctionDef,
                           ast.Call, str, str]] = []

    def enclosing_function(tree: ast.Module, target: ast.AST):
        parents: dict[ast.AST, ast.AST] = {}
        for parent in ast.walk(tree):
            for child in ast.iter_child_nodes(parent):
                parents[child] = parent
        current = parents.get(target)
        while current is not None:
            if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return current
            current = parents.get(current)
        return None

    def call_name(call: ast.Call) -> str:
        function = call.func
        return function.id if isinstance(function, ast.Name) else (
            function.attr if isinstance(function, ast.Attribute) else "")

    def literal_references(value: ast.AST, source: str, line: int) -> list[str]:
        if not isinstance(value, ast.Tuple):
            raise ValueError(f"{source}:{line}: dependency declaration is not statically resolvable")
        required: list[str] = []
        for item in value.elts:
            if not isinstance(item, ast.Constant) or not isinstance(item.value, str):
                raise ValueError(f"{source}:{line}: dependency declaration is not statically resolvable")
            try:
                required.append(str(Dependency.parse(item.value)))
            except ValueError as error:
                raise ValueError(f"{source}:{line}: {error}") from error
        return required

    # Find functions that forward their own `requires` parameter to a journey
    # recorder. Their call sites, rather than the wrapper body, are declarations.
    for source, tree in trees.items():
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or call_name(node) not in {"step", "flow"}:
                continue
            required = next((keyword.value for keyword in node.keywords if keyword.arg == "requires"), None)
            if not isinstance(required, ast.Name):
                continue
            function = enclosing_function(tree, node)
            if function is None:
                continue
            parameters = {argument.arg for argument in
                          [*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs]}
            if required.id in parameters:
                rebound = any(isinstance(candidate, ast.Name) and candidate.id == required.id
                              and isinstance(candidate.ctx, ast.Store)
                              for candidate in ast.walk(function))
                if rebound:
                    raise ValueError(f"{source}:{node.lineno}: dependency declaration is not statically resolvable")
                forwarding.append((source, function, node, required.id, call_name(node)))

    forwarding_names = {function.name for _, function, _, _, _ in forwarding}
    for name in forwarding_names:
        definitions = [(source, node) for source, tree in trees.items() for node in ast.walk(tree)
                       if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name]
        if len(definitions) != 1:
            source, _, call, _, _ = next(item for item in forwarding if item[1].name == name)
            raise ValueError(f"{source}:{call.lineno}: dependency declaration is not statically resolvable")
    forwarding_call_sites: dict[str, list[tuple[str, ast.Call]]] = {name: [] for name in forwarding_names}
    for source, tree in trees.items():
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and call_name(node) in forwarding_names:
                forwarding_call_sites[call_name(node)].append((source, node))

    def add_declaration(source: str, line: int, kind: str, name: str | None,
                        required: list[str], role: str | None, runners: list[str],
                        plan_after_phase: str | None = None, plan_phase: str | None = None) -> None:
        # Dynamic step names can carry checked edges, but are not selector
        # producers. Only a literal name or a statically resolved wrapper
        # call site can enter the producer graph.
        if name is None:
            key = f"@dynamic:{source}:{line}"
            declarations[key] = {"name": None, "kind": kind, "requires": required,
                                 "sources": {source}, "role": role, "runners": runners,
                                 "plan_after_phase": plan_after_phase, "plan_phase": plan_phase,
                                 "locations": [(source, line, required)],
                                 "producer": False}
            return
        key = str(Dependency(kind, name))
        declaration = declarations.setdefault(key, {"name": name, "kind": kind, "requires": [],
                                                    "sources": set(), "role": role, "runners": [],
                                                    "locations": []})
        declaration["requires"] = sorted(set(declaration["requires"]) | set(required))
        declaration["sources"].add(source)
        declaration["locations"].append((source, line, required))
        for field, value in (("plan_after_phase", plan_after_phase), ("plan_phase", plan_phase)):
            if value is not None:
                existing = declaration.get(field)
                if existing is not None and existing != value:
                    raise ValueError(f"{source}:{line}: conflicting plan ordering for {name!r}")
                declaration[field] = value
        if role is not None:
            declaration["role"] = role
        declaration["runners"] = sorted(set(declaration.get("runners", [])) | set(runners))

    for source in sources:
        tree = trees.get(source)
        if tree is None:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or call_name(node) not in {"step", "flow", "service_check"}:
                continue
            if any(keyword.arg is None for keyword in node.keywords):
                raise ValueError(f"{source}:{node.lineno}: dependency declaration is not statically resolvable")
            keywords = {keyword.arg: keyword.value for keyword in node.keywords}
            required_node = keywords.get("requires")
            if required_node is None:
                required: list[str] = []
            elif isinstance(required_node, ast.Tuple):
                required = literal_references(required_node, source, node.lineno)
            elif isinstance(required_node, ast.Name):
                function = enclosing_function(tree, node)
                parameters = ({argument.arg for argument in
                               [*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs]}
                              if function is not None else set())
                if required_node.id not in parameters:
                    raise ValueError(f"{source}:{node.lineno}: dependency declaration is not statically resolvable")
                wrapper_name = function.name
                matches = [(owner, definition, inner, parameter, kind)
                           for owner, definition, inner, parameter, kind in forwarding
                           if owner == source and definition is function and parameter == required_node.id]
                if not matches:
                    raise ValueError(f"{source}:{node.lineno}: dependency declaration is not statically resolvable")
                _, _, _, parameter, kind = matches[0]
                call_sites = forwarding_call_sites.get(wrapper_name, [])
                if not call_sites:
                    raise ValueError(f"{source}:{node.lineno}: dependency declaration is not statically resolvable")
                for call_source, call_site in call_sites:
                    if any(keyword.arg is None for keyword in call_site.keywords):
                        raise ValueError(f"{call_source}:{call_site.lineno}: dependency declaration is not statically resolvable")
                    call_keywords = {keyword.arg: keyword.value for keyword in call_site.keywords}
                    forwarded_value = call_keywords.get(parameter)
                    if forwarded_value is None:
                        kwonly_names = [argument.arg for argument in function.args.kwonlyargs]
                        if parameter in kwonly_names:
                            forwarded_value = function.args.kw_defaults[kwonly_names.index(parameter)]
                        else:
                            parameter_args = [*function.args.posonlyargs, *function.args.args]
                            parameter_index = next(index for index, argument in enumerate(parameter_args)
                                                   if argument.arg == parameter)
                            defaults_start = len(parameter_args) - len(function.args.defaults)
                            forwarded_value = (function.args.defaults[parameter_index - defaults_start]
                                               if parameter_index >= defaults_start else None)
                        if forwarded_value is None:
                            raise ValueError(f"{call_source}:{call_site.lineno}: dependency declaration is not statically resolvable")
                    call_required = literal_references(forwarded_value, call_source, call_site.lineno)
                    inner_name = node.args[0] if node.args else None
                    call_name_node = None
                    if isinstance(inner_name, ast.Name):
                        parameter_names = [argument.arg for argument in
                                           [*function.args.posonlyargs, *function.args.args]]
                        if inner_name.id in parameter_names:
                            parameter_index = parameter_names.index(inner_name.id)
                            call_name_node = call_keywords.get(inner_name.id)
                            if call_name_node is None and parameter_index < len(call_site.args):
                                call_name_node = call_site.args[parameter_index]
                    call_name_value = (call_name_node.value if isinstance(call_name_node, ast.Constant)
                                       and isinstance(call_name_node.value, str) else None)
                    if call_name_value is None:
                        raise ValueError(f"{call_source}:{call_site.lineno}: dependency declaration is not statically resolvable")
                    add_declaration(call_source, call_site.lineno, kind, call_name_value,
                                    call_required, None, [])
                continue
            else:
                raise ValueError(f"{source}:{node.lineno}: dependency declaration is not statically resolvable")
            name_node = node.args[0] if node.args else keywords.get("name")
            name = name_node.value if isinstance(name_node, ast.Constant) and isinstance(name_node.value, str) else None
            kind = "flow" if call_name(node) == "flow" else "step"
            role_node = keywords.get("role")
            role = role_node.value if isinstance(role_node, ast.Constant) else None
            plan_after_node = keywords.get("plan_after_phase")
            plan_after_phase = (plan_after_node.value if isinstance(plan_after_node, ast.Constant)
                                else None)
            plan_phase_node = keywords.get("plan_phase")
            plan_phase = (plan_phase_node.value if isinstance(plan_phase_node, ast.Constant)
                          else None)
            runners_node = keywords.get("runners")
            runners = [item.value for item in runners_node.elts
                       if isinstance(item, ast.Constant) and isinstance(item.value, str)] \
                if isinstance(runners_node, (ast.Tuple, ast.List)) else []
            add_declaration(source, node.lineno, kind, name, required, role, runners,
                            plan_after_phase, plan_phase)
    return declarations


def validate_dependency_declarations(sources: set[str], root: Path) -> dict[str, dict]:
    """Reject unresolved edges against the declarations reachable by either journey runner."""
    return _validate_dependency_declarations_cached(tuple(sorted(sources)), root)


@lru_cache(maxsize=None)
def _validate_dependency_declarations_cached(sources: tuple[str, ...], root: Path) -> dict[str, dict]:
    entrypoints = sorted({source for runner in RUNNERS.values() for source in runner.journey_sources})
    reachable = {entry: _imported_journey_sources({entry}, root) for entry in entrypoints}
    declarations = _source_step_declarations(set(sources), root)
    graphs = {entry: _source_step_declarations_cached(tuple(sorted(graph)), root)
              for entry, graph in reachable.items()}
    validate_dependency_edges(declarations, reachable, graphs, root)
    reachable_sources = set().union(*reachable.values()) if reachable else set()
    lint_direct_module_global_state_handoffs(reachable_sources, root)
    validate_journey_environment_reads(reachable_sources, root)
    validate_runner_conditions(reachable_sources, root)
    return declarations


def lint_direct_module_global_state_handoffs(sources: set[str], root: Path) -> None:
    """Lint recognized direct callback/helper handoffs through mutable module globals.

    This AST lint recognizes module-level dict/list/set/comprehension values and
    non-whitelisted constructor calls, then follows direct callback references
    and statically named helpers. It is not a complete state ownership check.
    """
    for source in sorted(sources):
        if not source.endswith(".py"):
            continue
        tree = _source_tree(source, root)
        functions = {node.name: node for node in ast.walk(tree)
                     if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        mutable_globals: set[str] = set()
        for node in tree.body:
            value = None
            targets = []
            annotation = ""
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                value = node.value
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if isinstance(node, ast.AnnAssign) and node.annotation is not None:
                    annotation = ast.unparse(node.annotation).replace(" ", "")
            if annotation in {"dict[str,str]", "dict[str,float]", "dict[str,str]|None"}:
                continue
            if value is None:
                continue
            mutable = (isinstance(value, (ast.Dict, ast.List, ast.Set, ast.ListComp,
                                          ast.DictComp, ast.SetComp))
                       or isinstance(value, ast.Call)
                       and not (isinstance(value.func, ast.Name)
                                and value.func.id in {"journey_value", "str", "int", "float", "bool",
                                                      "tuple", "frozenset", "Path", "MappingProxyType"}
                                or isinstance(value.func, ast.Attribute)
                                and value.func.attr in {"rstrip", "strip", "lower", "upper", "casefold"})
                       and (not isinstance(value.func, ast.Name)
                            or value.func.id not in {"bytes"}))
            if mutable:
                mutable_globals.update(target.id for target in targets if isinstance(target, ast.Name))

        parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
        state_accesses: dict[str, dict[int, bool]] = {}
        for call in ast.walk(tree):
            if not isinstance(call, ast.Call) or _call_name(call) not in {"step", "flow", "service_check"}:
                continue
            case_declaration = next((keyword.value for keyword in call.keywords if keyword.arg == "cases"), None)
            if case_declaration is not None and not isinstance(case_declaration, (ast.List, ast.Tuple)):
                continue
            callback_keyword = next((keyword.value for keyword in call.keywords
                                     if keyword.arg == "case_action"), None)
            callback_index = (3 if _call_name(call) == "flow" or len(call.args) >= 4 else 2)
            if callback_keyword is not None:
                callback_node = callback_keyword
            elif len(call.args) > callback_index:
                callback_node = call.args[callback_index]
            else:
                continue
            callback_reference = callback_node
            if isinstance(callback_node, ast.Name):
                callback_node = functions.get(callback_node.id)
                if callback_node is None:
                    owner = parents.get(call)
                    while owner is not None and not isinstance(owner, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        owner = parents.get(owner)
                    if owner is not None:
                        local_values = []
                        for local_node in ast.walk(owner):
                            if isinstance(local_node, ast.Assign):
                                assigned = [target.id for target in local_node.targets if isinstance(target, ast.Name)]
                                if (isinstance(callback_reference, ast.Name)
                                        and callback_reference.id in assigned):
                                    local_values.append(local_node.value)
                            elif (isinstance(local_node, ast.AnnAssign)
                                  and isinstance(local_node.target, ast.Name)
                                  and isinstance(callback_reference, ast.Name)
                                  and local_node.target.id == callback_reference.id):
                                local_values.append(local_node.value)
                        if local_values:
                            forwarded_callbacks = []
                            for value in local_values:
                                if isinstance(value, ast.Name):
                                    value = functions.get(value.id, value)
                                if isinstance(value, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef)):
                                    forwarded_callbacks.append(value)
                                else:
                                    raise ValueError(
                                        f"{source}:{call.lineno}: registered callback capture is not statically resolvable")
                            callback_node = forwarded_callbacks[0]
                            forwarded_callbacks = forwarded_callbacks[1:]
                        else:
                            forwarded_callbacks = []
                        parameters = [argument.arg for argument in
                                      [*owner.args.posonlyargs, *owner.args.args, *owner.args.kwonlyargs]]
                        if (not local_values and isinstance(callback_reference, ast.Name)
                                and callback_reference.id in parameters):
                            parameter = callback_reference.id
                            parameter_index = parameters.index(parameter)
                            forwarded = []
                            for site in ast.walk(tree):
                                if not isinstance(site, ast.Call) or _call_name(site) != owner.name:
                                    continue
                                site_keywords = {keyword.arg: keyword.value for keyword in site.keywords}
                                value = site_keywords.get(parameter)
                                if value is None and parameter_index < len(site.args):
                                    value = site.args[parameter_index]
                                if value is None:
                                    raise ValueError(
                                        f"{source}:{site.lineno}: registered callback capture is not statically resolvable")
                                if isinstance(value, ast.Name):
                                    value = functions.get(value.id, value)
                                if isinstance(value, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef)):
                                    forwarded.append(value)
                                else:
                                    raise ValueError(
                                        f"{source}:{site.lineno}: registered callback capture is not statically resolvable")
                            if not forwarded:
                                raise ValueError(
                                    f"{source}:{call.lineno}: registered callback capture is not statically resolvable")
                            callback_node = forwarded[0]
                            forwarded_callbacks = forwarded[1:]
                        elif not local_values:
                            forwarded_callbacks = []
                    else:
                        forwarded_callbacks = []
                else:
                    forwarded_callbacks = []
            else:
                forwarded_callbacks = []
            if not isinstance(callback_node, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef)):
                raise ValueError(f"{source}:{call.lineno}: registered callback capture is not statically resolvable")
            callback_name = callback_node.name if isinstance(callback_node, (ast.FunctionDef, ast.AsyncFunctionDef)) else "<lambda>"
            pending = [callback_node, *forwarded_callbacks]
            visited: set[ast.AST] = set()
            while pending:
                callback = pending.pop()
                if callback in visited:
                    continue
                visited.add(callback)
                for item in ast.walk(callback):
                    if isinstance(item, ast.Name):
                        if item.id in mutable_globals:
                            writes = isinstance(item.ctx, (ast.Store, ast.Del))
                            parent = parents.get(item)
                            cursor = parent
                            while cursor is not None and cursor is not callback:
                                if (isinstance(cursor, (ast.Subscript, ast.Attribute))
                                        and isinstance(cursor.ctx, (ast.Store, ast.Del))):
                                    writes = True
                                    break
                                cursor = parents.get(cursor)
                            if isinstance(parent, ast.Call) and isinstance(parent.func, ast.Attribute):
                                writes = writes or parent.func.attr in {
                                    "append", "extend", "insert", "pop", "remove", "clear",
                                    "update", "setdefault", "add", "discard",
                                }
                            accesses = state_accesses.setdefault(item.id, {})
                            accesses[call.lineno] = accesses.get(call.lineno, False) or writes
                        helper = functions.get(item.id)
                        if isinstance(item.ctx, ast.Load) and helper is not None and helper is not callback:
                            pending.append(helper)
        for state_name, registrations in state_accesses.items():
            if len(registrations) > 1 and any(registrations.values()):
                lines = ", ".join(str(line) for line in sorted(registrations))
                raise ValueError(
                    f"{source}:{lines}: module-global-state lint detected registered callbacks "
                    f"sharing recognized mutable global {state_name!r}; route shared state "
                    "through journey memory with provides= and requires= when applicable")


def validate_journey_environment_reads(sources: set[str], root: Path) -> None:
    """Lint direct os environment lookups; journey inputs must use the accessor."""
    for source in sorted(sources):
        if not source.endswith(".py") or source == "e2e/journey/journey_values.py":
            continue
        tree = _source_tree(source, root)
        parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}

        def literal_key(expression: ast.expr) -> str | None:
            if isinstance(expression, ast.Constant) and isinstance(expression.value, str):
                return expression.value
            if isinstance(expression, ast.Name):
                owner = parents.get(expression)
                while owner is not None and not isinstance(owner, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    owner = parents.get(owner)
                if owner is not None:
                    values = []
                    for candidate in ast.walk(owner):
                        if isinstance(candidate, ast.Assign) and any(
                                isinstance(target, ast.Name) and target.id == expression.id
                                for target in candidate.targets):
                            values.append(candidate.value)
                        elif (isinstance(candidate, ast.AnnAssign)
                              and isinstance(candidate.target, ast.Name)
                              and candidate.target.id == expression.id and candidate.value is not None):
                            values.append(candidate.value)
                    if values and all(isinstance(value, ast.Constant) and isinstance(value.value, str)
                                      for value in values):
                        keys = {value.value for value in values if isinstance(value, ast.Constant)}
                        return next(iter(keys)) if len(keys) == 1 else None
            return None

        def check_key(expression: ast.expr, node: ast.AST) -> None:
            key = literal_key(expression)
            if key is None:
                raise ValueError(
                    f"{source}:{node.lineno}: computed environment keys are outside the journey input "
                    "lint; use journey_values.journey_value for harness inputs or a literal process key")
            if key.startswith("KB_JOURNEY_"):
                raise ValueError(
                    f"{source}:{node.lineno}: {key} must be read through journey_values.journey_value")

        for node in ast.walk(tree):
            if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute)
                    and node.value.attr == "environ" and isinstance(node.value.value, ast.Name)
                    and node.value.value.id == "os" and isinstance(node.ctx, ast.Load)):
                check_key(node.slice, node)
            if not isinstance(node, ast.Call):
                continue
            function = _call_name(node)
            if function not in {"get", "getenv"}:
                continue
            is_os_getenv = (isinstance(node.func, ast.Attribute) and node.func.attr == "getenv"
                            and isinstance(node.func.value, ast.Name) and node.func.value.id == "os")
            is_os_environ_get = (isinstance(node.func, ast.Attribute) and node.func.attr == "get"
                                 and isinstance(node.func.value, ast.Attribute)
                                 and node.func.value.attr == "environ"
                                 and isinstance(node.func.value.value, ast.Name)
                                 and node.func.value.value.id == "os")
            if is_os_getenv or is_os_environ_get:
                if not node.args:
                    raise ValueError(f"{source}:{node.lineno}: environment read has no literal key")
                check_key(node.args[0], node)


def full_runner_plans(root: Path) -> dict[str, list[str]]:
    plans = {}
    for selector, runner in RUNNERS.items():
        sources = set().union(*(_imported_journey_sources({source}, root)
                                for source in runner.journey_sources))
        registrations = _source_step_declarations(sources, root)
        selected = [
            declaration for declaration in registrations.values()
            if declaration.get("name") is not None
            and (not declaration.get("runners") or selector in declaration["runners"])
        ]
        barriers = [declaration for declaration in selected
                    if declaration.get("plan_after_phase") == "all-steps"]
        teardowns = [declaration for declaration in selected
                     if declaration.get("plan_phase") == "teardown"]
        if len(barriers) != 1 or len(teardowns) != 1:
            raise ValueError(
                f"{selector}: expected exactly one plan_after_phase='all-steps' barrier "
                f"(found {len(barriers)}) and exactly one plan_phase='teardown' step "
                f"(found {len(teardowns)}). Correct the journey declarations, then run "
                "python3 e2e/journey/select_from_cases.py --write-plan-baseline")
        barrier, teardown = barriers[0], teardowns[0]
        if barrier is teardown or teardown.get("role") != "lifecycle":
            raise ValueError(f"{selector}: plan barrier and teardown must be distinct, with lifecycle teardown")
        ordered = [declaration for declaration in selected
                   if declaration is not barrier and declaration is not teardown]
        ordered.extend((barrier, teardown))
        if ordered[-2] is not barrier or ordered[-1] is not teardown:
            raise ValueError(f"{selector}: lifecycle plan barrier was not placed before teardown")
        selected = ordered
        plans[selector] = [declaration["name"] for declaration in selected]
    return plans


def write_full_runner_plan_baseline(root: Path) -> Path:
    path = root / "e2e/journey/full-plan-baseline.json"
    path.write_text(json.dumps(full_runner_plans(root), indent=2) + "\n", encoding="utf-8")
    return path


def validate_runner_conditions(sources: set[str], root: Path) -> None:
    """Require variant ownership on registrations nested under runner-context branches."""
    for source in sorted(sources):
        if not source.endswith(".py"):
            continue
        tree = _source_tree(source, root)
        parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
        for call in ast.walk(tree):
            if not isinstance(call, ast.Call):
                continue
            keywords = {keyword.arg: keyword.value for keyword in call.keywords}
            cases = keywords.get("cases")
            if not isinstance(cases, (ast.List, ast.Tuple)) or not any(
                    isinstance(item, ast.Constant) and isinstance(item.value, str) for item in cases.elts):
                continue
            if keywords.get("runners") is not None:
                continue
            current = parents.get(call)
            while current is not None:
                if isinstance(current, ast.If):
                    referenced = {node.id for node in ast.walk(current.test) if isinstance(node, ast.Name)}
                    if referenced.intersection(RUNNER_CONTEXT_NAMES):
                        raise ValueError(
                            f"{source}:{call.lineno}: claim registration is conditional on runner context; "
                            "declare its executable runners= variants"
                        )
                current = parents.get(current)


def validate_dependency_edges(declarations: dict[str, dict], reachable: dict[str, set[str]],
                              graphs: dict[str, dict[str, dict]], root: Path) -> None:
    required_step_names = {
        dependency.name
        for declaration in declarations.values()
        for _source, _line, references in declaration["locations"]
        for reference in references
        if (dependency := Dependency.parse(reference)).kind == "step"
    }
    for source in sorted(set().union(*reachable.values()) if reachable else set()):
        if not source.endswith(".py"):
            continue
        tree = _source_tree(source, root)
        parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
        for call in ast.walk(tree):
            if not isinstance(call, ast.Call) or _call_name(call) not in {"step", "claim_step"}:
                continue
            name_node = call.args[0] if call.args else None
            if not isinstance(name_node, ast.Constant) or name_node.value not in required_step_names:
                continue
            current = parents.get(call)
            conditional = False
            while current is not None:
                if isinstance(current, ast.If) and RUNNER_CONTEXT_NAMES.intersection(
                        node.id for node in ast.walk(current.test) if isinstance(node, ast.Name)):
                    conditional = True
                    break
                current = parents.get(current)
            if conditional and not any(keyword.arg == "runners" for keyword in call.keywords):
                raise ValueError(
                    f"{source}:{call.lineno}: step prerequisite {name_node.value!r} is registered only "
                    "under a runner condition; declare its executable runners= variants or depend on its state")

    for dependency_key, declaration in declarations.items():
        for source, line, references in declaration["locations"]:
            owners = [entry for entry, source_set in reachable.items()
                      if source in source_set and (declaration.get("producer") is False
                                                   or dependency_key in graphs[entry])]
            for reference in references:
                dependency = Dependency.parse(reference)
                key = str(dependency)
                if dependency.kind == "state":
                    if dependency.name not in FLOW_GRAPH_STATE_PRODUCERS:
                        raise ValueError(
                            f"{source}:{line}: {reference!r} does not resolve to a registered FlowGraph state")
                    if not owners:
                        raise ValueError(f"{source}:{line}: {reference!r} has no runner that can execute its owner")
                    continue
                resolved = [(entry, graphs[entry].get(key)) for entry in owners]
                if not owners or not any(target is not None for _entry, target in resolved):
                    raise ValueError(f"{source}:{line}: {reference!r} does not resolve to a declared, reachable step or flow")


def resolve_selection(selected_steps: list[str], sources_by_step: dict[str, set[str]],
                      declarations_by_step: dict[str, list[dict]], declarations_by_name: dict[str, dict],
                      owners_by_step: dict[str, dict[str, set[str]]], only: str = "",
                      ineligible_by_step: dict[str, set[str]] | None = None) -> dict:
    """Resolve selected claims to their runner and transitive declared prerequisites."""
    selected = set(selected_steps)
    names: set[str] = set()
    sources: set[str] = set()
    capabilities: set[str] = set()
    pending: list[str] = []
    for step_id in selected:
        sources.update(sources_by_step.get(step_id, set()))
        for declaration in declarations_by_step.get(step_id, []):
            capability = declaration.get("capability")
            if isinstance(capability, str):
                capabilities.add(capability)
            name = declaration.get("name") or step_id
            names.add(str(Dependency(declaration.get("kind", "step"), name)))
            pending.extend(declaration.get("requires", []))
    prerequisites: set[str] = set()
    while pending:
        name = pending.pop()
        dependency = Dependency.parse(name)
        if dependency.kind == "state":
            continue
        key = str(dependency)
        if key in names:
            continue
        names.add(key)
        prerequisites.add(key)
        declaration = declarations_by_name.get(key, {})
        sources.update(declaration.get("sources", set()))
        pending.extend(declaration.get("requires", []))
    owners: dict[str, set[str]] = {}
    for step_id in selected:
        for runner, claims in owners_by_step.get(step_id, {}).items():
            owners.setdefault(runner, set()).update(claims)
    ineligible_by_step = ineligible_by_step or {}
    unowned = sorted(step_id for step_id in selected
                     if not any(step_id in claims for claims in owners.values()))
    if unowned:
        routes = []
        for step_id in unowned:
            candidates = sorted(ineligible_by_step.get(step_id, set()))
            if candidates:
                routes.extend(f"{step_id} is registered on {selector} ({RUNNERS[selector].mode} mode): "
                              f"KB_JOURNEY_CASES={step_id} KB_JOURNEY_ONLY={selector} e2e/journey/run.sh --no-build"
                              for selector in candidates)
            else:
                routes.append(f"{step_id} has no eligible runner variant; register the claim on its executable step")
        raise ValueError("selected claims have no executable registration for the requested mode: "
                         + ", ".join(unowned) + ". Available registrations: " + "; ".join(routes))
    requested_selectors = set(filter(None, only.split(",")))
    requested_runners = {
        runner
        for selector in requested_selectors
        for runner in RUNNER_GROUPS.get(selector, (selector,))
    }
    unknown_runners = requested_runners - RUNNERS.keys()
    if unknown_runners:
        unknown_selectors = requested_selectors - RUNNERS.keys() - RUNNER_GROUPS.keys()
        raise ValueError(f"unknown KB_JOURNEY_ONLY runner(s): {', '.join(sorted(unknown_selectors))}")
    runners = set(owners)
    if requested_runners:
        runners.intersection_update(requested_runners)
        covered = {claim for runner in runners for claim in owners[runner]}
        uncovered = set(selected) - covered
        if uncovered:
            routes = "; ".join(
                f"{runner} owns {', '.join(sorted(uncovered.intersection(claims)))}: "
                f"KB_JOURNEY_CASES={','.join(sorted(uncovered.intersection(claims)))} "
                f"KB_JOURNEY_ONLY={runner} e2e/journey/run.sh --no-build"
                for runner, claims in sorted(owners.items())
                if runner not in runners and uncovered.intersection(claims)
            )
            raise ValueError(
                "KB_JOURNEY_ONLY leaves selected claims without a runner: "
                + ", ".join(sorted(uncovered)) + ". Run the owning selectors: " + routes
            )
    step_prerequisites = sorted(Dependency.parse(item).name for item in prerequisites
                                if Dependency.parse(item).kind == "step")
    flow_prerequisites = sorted(Dependency.parse(item).name for item in prerequisites
                                if Dependency.parse(item).kind == "flow")
    selected_owners: dict[str, set[str]] = {}
    for step_id in selected:
        for declaration in declarations_by_step.get(step_id, []):
            if declaration.get("kind", "step") == "step":
                selected_owners.setdefault(str(declaration.get("name") or step_id), set()).add(step_id)
    for name in step_prerequisites:
        selected_owners.setdefault(name, set()).update(selected)
    return {"runners": sorted(runners), "owners": {key: sorted(value) for key, value in sorted(owners.items())},
            "steps": sorted(selected),
            "prerequisiteSteps": step_prerequisites, "prerequisiteFlows": flow_prerequisites,
            "stepSources": sorted(sources), "capabilities": sorted(capabilities),
            "composeProfiles": lanes_for_runners(runners),
            "selectedOwningSteps": {key: sorted(value) for key, value in sorted(selected_owners.items())}}


def read_coverage_result(result: CompletedProcess[str]) -> dict:
    payload = decode_ux_success_result(read_ux_cli_result(result))
    if not isinstance(payload, dict):
        raise ValueError("QA coverage result data is not an object")
    return payload


def selectors_from_coverage(results: list[dict]) -> list[str]:
    selected: set[str] = set()
    for coverage in results:
        mode = coverage.get("mode")
        if mode not in {"local", "secured"}:
            raise ValueError(f"unsupported QA coverage mode: {mode!r}")
        for case in coverage.get("cases", []):
            if case.get("status") != "active" or case.get("release") is not True:
                continue
            for step in case.get("steps", []):
                for claim in step.get("claims", []):
                    if claim.get("kind") not in {"journey", "e2e"}:
                        continue
                    selected.update(runners_for_source(str(claim.get("source", "")), mode))
    return sorted(selected)


def selection_from_coverage(results: list[dict], requested: str, *, mode: str | None = None,
                            requested_runners: str | None = None) -> dict:
    """Resolve requested cases/steps against the QA coverage claim registry."""
    if mode is not None and mode not in {"local", "secured"}:
        raise ValueError(f"unsupported QA coverage mode: {mode!r}")
    registry: dict[str, set[str]] = {}
    sources_by_step: dict[str, set[str]] = {}
    declarations_by_step: dict[str, dict] = {}
    owners_by_step: dict[str, dict[str, set[str]]] = {}
    ineligible_by_step: dict[str, set[str]] = {}
    unclaimed_by_case: dict[str, set[str]] = {}
    root = resource_root()
    for coverage in results:
        for case in coverage.get("cases", []):
            if case.get("status") != "active":
                continue
            case_id = case.get("id")
            if not isinstance(case_id, str):
                continue
            for step in case.get("steps", []):
                step_id = step.get("stepId")
                journey_claimed = any(
                    claim.get("kind") in {"journey", "e2e"}
                    and str(claim.get("source", "")).startswith(("e2e/journey/", "e2e/studio/", "e2e/"))
                    for claim in step.get("claims", [])
                )
                if isinstance(step_id, str) and not journey_claimed:
                    unclaimed_by_case.setdefault(case_id, set()).add(step_id)
                if journey_claimed and isinstance(step_id, str):
                    registry.setdefault(case_id, set()).add(step_id)
                    for claim in step.get("claims", []):
                        if claim.get("kind") not in {"journey", "e2e"}:
                            continue
                        source = str(claim.get("source", ""))
                        if not source.startswith(("e2e/journey/", "e2e/studio/", "e2e/")):
                            continue
                        sources_by_step.setdefault(step_id, set()).add(source)
                        declaration = _step_declaration(source, int(claim.get("line", 0)), root)
                        coverage_mode = str(coverage.get("mode", ""))
                        selectors = declaration.get("runners") or runners_for_source(source, coverage_mode)
                        if declaration.get("runners"):
                            for selector in selectors:
                                if RUNNERS[selector].mode != coverage_mode:
                                    ineligible_by_step.setdefault(step_id, set()).add(selector)
                            selectors = [selector for selector in selectors
                                         if RUNNERS[selector].mode == coverage_mode]
                        for selector in selectors:
                            owners_by_step.setdefault(step_id, {}).setdefault(selector, set()).add(step_id)
                        if declaration:
                            declarations = declarations_by_step.setdefault(step_id, [])
                            if declaration not in declarations:
                                declarations.append(declaration)

    if mode is not None:
        for step_id, owners in owners_by_step.items():
            ineligible_by_step.setdefault(step_id, set()).update(
                selector for selector in owners if RUNNERS[selector].mode != mode)
            owners_by_step[step_id] = {
                selector: claims for selector, claims in owners.items()
                if RUNNERS[selector].mode == mode
            }

    case_ids = set(registry)
    step_ids = set().union(*registry.values()) if registry else set()
    tokens = [item.strip() for item in requested.split(",") if item.strip()]
    if not tokens:
        raise ValueError("KB_JOURNEY_CASES must contain at least one case or step ID")
    selected: set[str] = set()
    for token in tokens:
        if token in case_ids:
            unclaimed = sorted(unclaimed_by_case.get(token, set()))
            if unclaimed:
                claimed = ",".join(sorted(registry[token]))
                raise ValueError(
                    f"case {token} includes unclaimed steps that no journey runner can prove: "
                    + ", ".join(unclaimed)
                    + f". To resolve its claimed rows only, run `KB_JOURNEY_CASES={claimed} e2e/journey/run.sh --resolve-only`; "
                    + "to prove the full case, add a journey claim for each unclaimed step."
                )
            selected.update(registry[token])
        elif token in step_ids:
            selected.add(token)
        else:
            raise ValueError(
                f"unknown or unclaimed journey case/step ID: {token}. "
                "Check available IDs with `node ./cli/bin/dist/bin.js qa cases list --json`, then rerun the journey."
            )
    if mode is not None:
        selected_mode_steps = {step_id for step_id in selected if owners_by_step.get(step_id)}
        selected_other_mode_steps = {
            step_id for step_id in selected
            if not owners_by_step.get(step_id) and ineligible_by_step.get(step_id)
        }
        if len(selected_mode_steps | selected_other_mode_steps) == len(selected):
            if selected_mode_steps:
                selected = selected_mode_steps
            else:
                return {"selection": sorted(set(tokens)), "steps": [], "owners": {}, "runners": [],
                        "prerequisiteSteps": [], "prerequisiteFlows": [], "stepSources": [],
                        "capabilities": [], "composeProfiles": [], "selectedOwningSteps": {}}
    claim_sources = set().union(*sources_by_step.values()) if sources_by_step else set()
    declarations_by_name = validate_dependency_declarations(claim_sources, root)
    resolved = resolve_selection(sorted(selected), sources_by_step, declarations_by_step, declarations_by_name,
                                 owners_by_step, (read_journey_selection(
                                     os.environ, default_runner_selector="").requested_runners
                                     if requested_runners is None else requested_runners),
                                 ineligible_by_step)
    return {"selection": sorted(set(tokens)), **resolved}


def runners_for_case_selection(results: list[dict], requested: str, mode: str) -> list[str]:
    """Return registered owners for selected claims in one execution mode."""
    if mode not in {"local", "secured"}:
        raise ValueError(f"unsupported QA coverage mode: {mode!r}")
    selected = selection_from_coverage(results, requested, mode=mode, requested_runners="")
    return selected["runners"]


def main() -> int:
    if sys.argv[1:] == ["--write-plan-baseline"]:
        root = resource_root()
        print_report_text(str(write_full_runner_plan_baseline(root)), flush=True)
        return 0
    if len(sys.argv) == 4 and sys.argv[1] == "--runners-for-mode":
        results = coverage_results()
        print_report_text(json.dumps(runners_for_case_selection(results, sys.argv[3], sys.argv[2])), flush=True)
        return 0
    results = coverage_results()
    requested = ",".join(read_requested_cases(os.environ))
    if requested:
        mode = journey_value("KB_JOURNEY_SELECTION_MODE")
        print_report_text(json.dumps(selection_from_coverage(
            results, requested, mode=mode, requested_runners="" if mode else None)), flush=True)
    else:
        print_report_text(json.dumps(selectors_from_coverage(results)), flush=True)
    return 0


def coverage_results(root: Path | None = None) -> list[dict]:
    """Read the QA coverage of both modes from the workspace CLI; a failed run names its typed error."""
    root = Path.cwd() if root is None else root
    results = []
    for mode in ("local", "secured"):
        command = ["node", "./cli/bin/dist/bin.js", "qa", "coverage", "show",
                   "--level", "all", "--mode", mode, "--json"]
        with invocation_context(step_id="journey.case-selection"):
            result = run_hermetic_cli(command, cwd=root, env=os.environ, timeout=120,
                                      workspace_root=root)
        if result.returncode != 0:
            raise ValueError(describe_cli_failure(" ".join(command), result.stdout, result.stderr, result.returncode))
        results.append(read_coverage_result(result))
    return results


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print_report_text(str(error), stream=sys.stderr, flush=True)
        raise SystemExit(2)
    except Exception as error:
        print_report_text(f"Journey case selection failed: {error.__class__.__name__}: {error}",
                          stream=sys.stderr, flush=True)
        raise SystemExit(1)
