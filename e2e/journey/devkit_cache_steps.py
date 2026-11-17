"""Real-binary journey probes for DevKit's declared-input cache contract."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from invocations import run_command, run_harness_command
from service_steps import Journey


DEVKIT_CACHE_CLAIMS = tuple(f"S-298.{number}" for number in range(1, 11))


def _fixture(root: Path, packages: dict[str, str], config: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text(
        json.dumps({"name": "cache-journey", "private": True,
                    "workspaces": ["packages/*", "packages/*/*"]}) + "\n", encoding="utf-8")
    for relative, manifest in packages.items():
        package = root / "packages" / relative
        package.mkdir(parents=True, exist_ok=True)
        (package / "package.json").write_text(manifest + "\n", encoding="utf-8")
    (root / "devkit.yaml").write_text(config, encoding="utf-8")
    for args in (("init", "--quiet"), ("config", "user.name", "Cache Journey"),
                 ("config", "user.email", "cache-journey@example.test"),
                 ("add", "--all"), ("commit", "--quiet", "-m", "baseline")):
        result = run_harness_command(["git", *args], cwd=root)
        if result.returncode:
            raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr or result.stdout}")


def _run(binary: Path, root: Path, home: Path, task: str, *args: str) -> dict:
    result = run_command([str(binary), "run", task, *args, "--json"], cwd=root,
                         env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home), "CI": "1"},
                         timeout=60)
    try:
        body = json.loads(result.stdout or "")
    except json.JSONDecodeError as error:
        raise AssertionError(f"kb-devkit run {task} returned non-JSON output: {result.stdout!r}") from error
    if result.returncode or body.get("ok") is not True:
        raise AssertionError(f"kb-devkit run {task} failed: {body}")
    return body


def _tasks(body: dict) -> dict[tuple[str, str], bool]:
    results = body.get("data", {}).get("results")
    if not isinstance(results, list):
        raise AssertionError(f"missing data.results in {body}")
    tasks = {}
    for item in results:
        package = item.get("Package", item.get("package"))
        task = item.get("Task", item.get("task"))
        cached = item.get("Cached", item.get("cached"))
        if not package or not task or not isinstance(cached, bool) or (package, task) in tasks:
            raise AssertionError(f"invalid or duplicate task result: {item}")
        tasks[(package, task)] = cached
    return tasks


def _require(condition: bool, evidence: str) -> None:
    if not condition:
        raise AssertionError(evidence)


def run_devkit_cache_steps(journey: Journey, repo_root: Path) -> None:
    """Exercise cache claims against an isolated Git workspace using the candidate binary."""
    if journey.mode != "local":
        return
    binary = repo_root / "tools" / "kb-devkit" / "kb-devkit"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        reason = f"BLOCKED: candidate kb-devkit binary is unavailable or not executable at {binary}"
        for claim in DEVKIT_CACHE_CLAIMS:
            journey.step(f"candidate kb-devkit is available for {claim}", "workspace-cli",
                         lambda reason=reason: reason, cases=[claim])
        return
    try:
        help_result = run_command([str(binary), "--help"], cwd=repo_root,
                                  env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")}, timeout=30)
        if help_result.returncode != 0:
            reason = (f"BLOCKED: candidate kb-devkit could not execute --help "
                      f"(exit {help_result.returncode}): {help_result.stderr or help_result.stdout}")
        else:
            reason = None
    except (OSError, subprocess.TimeoutExpired) as error:
        reason = f"BLOCKED: candidate kb-devkit is incompatible with this runner: {error}"
    if reason:
        for claim in DEVKIT_CACHE_CLAIMS:
            journey.step(f"candidate kb-devkit is available for {claim}", "workspace-cli",
                         lambda reason=reason: reason, cases=[claim])
        return

    def local_inputs() -> str | None:
        try:
            with tempfile.TemporaryDirectory(prefix="kb-devkit-cache-journey-") as temporary:
                root = Path(temporary) / "workspace"
                home = Path(temporary) / "home"
                home.mkdir()
                app = root / "packages/app"
                (app / "src").mkdir(parents=True)
                (app / "src/known.ts").write_text("known\n")
                (app / "build.js").write_text('const fs=require("fs"); fs.mkdirSync("dist",{recursive:true}); fs.writeFileSync("dist/list.txt", fs.readdirSync("src").filter(x=>x.endsWith(".ts")).sort().join("\\n"));')
                (root / ".gitignore").write_text("packages/app/src/ignored.ts\npackages/app/dist/list.txt\n")
                config = '''schemaVersion: 2\nworkspace:\n  categories:\n    apps:\n      match: ["packages/app"]\n      preset: node-lib\ntasks:\n  build:\n    command: "node build.js"\n    inputs: ["src/**"]\n    outputs: ["dist/list.txt"]\n'''
                _fixture(root, {"app": '{"name":"@fixture/app"}'}, config)
                first = _tasks(_run(binary, root, home, "build"))
                second = _tasks(_run(binary, root, home, "build"))
                key = ("@fixture/app", "build")
                _require(first[key] is False and second[key] is True, "unchanged declared inputs did not hit cache")
                (app / "src/new.ts").write_text("new\n")
                changed = _tasks(_run(binary, root, home, "build"))
                _require(changed[key] is False, "new unstaged declared input did not invalidate cache")
                generated = (app / "dist/list.txt").read_text()
                _require(generated == "known.ts\nnew.ts", f"generated file list was {generated!r}")
                (app / "src/ignored.ts").write_text("ignored\n")
                ignored = _tasks(_run(binary, root, home, "build"))
                _require(ignored[key] is False, "Git-ignored declared input did not invalidate cache")
                generated = (app / "dist/list.txt").read_text()
                _require("ignored.ts" in generated, "output omitted the Git-ignored declared input")
                (app / "README.md").write_text("outside the declared glob\n")
                outside = _tasks(_run(binary, root, home, "build"))
                _require(outside[key] is True, "untracked file outside declared inputs invalidated cache")
            return None
        except (AssertionError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            return str(error)

    journey.step("track only declared local source inputs", "workspace-cli", local_inputs, cases=["S-298.1", "S-298.3", "S-298.6"],
                 runners=("service-local:explore",))

    def output_restore() -> str | None:
        try:
            with tempfile.TemporaryDirectory(prefix="kb-devkit-cache-output-") as temporary:
                root, home = Path(temporary) / "workspace", Path(temporary) / "home"
                home.mkdir()
                app = root / "packages/app"
                (app / "src").mkdir(parents=True)
                (app / "src/in.txt").write_text("generated content\n")
                (app / "generate.js").write_text('const fs=require("fs"); fs.mkdirSync("dist",{recursive:true}); fs.writeFileSync("dist/generated.txt",fs.readFileSync("src/in.txt"));')
                (app / "build.js").write_text('const fs=require("fs"); fs.mkdirSync("dist",{recursive:true}); fs.writeFileSync("dist/built.txt",fs.readFileSync("dist/generated.txt"));')
                (root / ".gitignore").write_text("packages/app/dist/generated.txt\n")
                config = '''schemaVersion: 2\nworkspace:\n  categories:\n    apps:\n      match: ["packages/app"]\n      preset: node-lib\ntasks:\n  generate:\n    command: "node generate.js"\n    inputs: ["src/**", "dist/generated.txt"]\n    outputs: ["dist/generated.txt"]\n  build:\n    command: "node build.js"\n    inputs: ["dist/generated.txt"]\n    outputs: ["dist/built.txt"]\n    deps: ["generate"]\n'''
                _fixture(root, {"app": '{"name":"@fixture/app"}'}, config)
                first = _tasks(_run(binary, root, home, "build"))
                second = _tasks(_run(binary, root, home, "build"))
                _require(first[("@fixture/app", "generate")] is False and first[("@fixture/app", "build")] is False,
                         "first generate/build run was cached")
                _require(second[("@fixture/app", "generate")] is True and second[("@fixture/app", "build")] is True,
                         "unchanged generate/build did not both hit cache")
                (app / "dist/generated.txt").unlink()
                (app / "dist/built.txt").unlink()
                restored = _tasks(_run(binary, root, home, "build"))
                _require(restored[("@fixture/app", "generate")] is True and restored[("@fixture/app", "build")] is True,
                         "deleted ignored output did not restore through two cache hits")
                _require((app / "dist/generated.txt").read_text() == "generated content\n",
                         "cached generate did not restore the ignored output")
                _require((app / "dist/built.txt").read_text() == "generated content\n",
                         "cached consumer did not restore its output")
            return None
        except (AssertionError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            return str(error)

    journey.step("restore ignored generated input from task cache", "workspace-cli", output_restore, cases=["S-298.2"],
                 runners=("service-local:explore",))

    def upstream_source() -> str | None:
        try:
            with tempfile.TemporaryDirectory(prefix="kb-devkit-cache-upstream-") as temporary:
                root, home = Path(temporary) / "workspace", Path(temporary) / "home"
                home.mkdir()
                a, b = root / "packages/a", root / "packages/b"
                (a / "src").mkdir(parents=True); (b / "src").mkdir(parents=True)
                (a / "src/known.ts").write_text("known\n")
                (b / "src/index.ts").write_text("consumer\n")
                (b / "read.js").write_text('const fs=require("fs"); fs.mkdirSync("dist",{recursive:true}); fs.writeFileSync("dist/list.txt",fs.readdirSync("../a/src").filter(x=>x.endsWith(".ts")).sort().join("\\n"));')
                config = '''schemaVersion: 2\nworkspace:\n  categories:\n    sources:\n      match: ["packages/a"]\n      preset: node-lib\n    consumers:\n      match: ["packages/b"]\n      preset: node-lib\ntasks:\n  generate:\n    command: "node read.js"\n    categories: ["consumers"]\n    outputs: ["dist/list.txt"]\n    deps: ["^generate"]\n'''
                _fixture(root, {"a": '{"name":"@fixture/a"}',
                                "b": '{"name":"@fixture/b","dependencies":{"@fixture/a":"workspace:*"}}'}, config)
                first = _tasks(_run(binary, root, home, "generate"))
                _require(first == {("@fixture/b", "generate"): False}, f"expected only the consumer task, got {first}")
                second = _tasks(_run(binary, root, home, "generate"))
                _require(second[("@fixture/b", "generate")] is True, "unchanged consumer did not hit cache")
                (a / "src/new.ts").write_text("new\n")
                third = _tasks(_run(binary, root, home, "generate"))
                _require(third[("@fixture/b", "generate")] is False, "new upstream untracked source left consumer cached")
                _require((b / "dist/list.txt").read_text() == "known.ts\nnew.ts", "consumer output did not include upstream source")
            return None
        except (AssertionError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            return str(error)

    journey.step("invalidate workspace consumers for a source-only dependency", "workspace-cli", upstream_source, cases=["S-298.8"],
                 runners=("service-local:explore",))

    def workspace_build_dependency() -> str | None:
        try:
            with tempfile.TemporaryDirectory(prefix="kb-devkit-cache-build-dep-") as temporary:
                root, home = Path(temporary) / "workspace", Path(temporary) / "home"
                home.mkdir()
                a, b = root / "packages/a", root / "packages/b"
                (a / "src").mkdir(parents=True); (b / "src").mkdir(parents=True)
                (a / "src/known.ts").write_text("known\n"); (b / "src/index.ts").write_text("consumer\n")
                for package, source in ((a, 'const output="built";'),
                                        (b, 'const output=fs.readdirSync("../a/src").filter(x=>x.endsWith(".ts")).sort().join("\\\\n");')):
                    (package / "build.js").write_text('const fs=require("fs"); fs.mkdirSync("dist",{recursive:true}); ' + source + ' fs.writeFileSync("dist/output.txt",output);')
                config = '''schemaVersion: 2\nworkspace:\n  categories:\n    packages:\n      match: ["packages/*"]\n      preset: node-lib\ntasks:\n  build:\n    command: "node build.js"\n    inputs: ["src/**"]\n    outputs: ["dist/**"]\n    deps: ["^build"]\n'''
                _fixture(root, {"a": '{"name":"@fixture/a"}',
                                "b": '{"name":"@fixture/b","dependencies":{"@fixture/a":"workspace:*"}}'}, config)
                first = _tasks(_run(binary, root, home, "build"))
                second = _tasks(_run(binary, root, home, "build"))
                _require(len(first) == 2 and all(not hit for hit in first.values()), f"initial dependency build was {first}")
                _require(len(second) == 2 and all(hit for hit in second.values()), f"unchanged dependency build was {second}")
                (a / "src/new.ts").write_text("new\n")
                third = _tasks(_run(binary, root, home, "build"))
                _require(len(third) == 2 and all(not hit for hit in third.values()), f"upstream change cache state was {third}")
                output = (b / "dist/output.txt").read_text()
                _require(output == "known.ts\\nnew.ts", f"consumer output after upstream change was {output!r}")
            return None
        except (AssertionError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            return str(error)

    journey.step("invalidate dependent build after upstream untracked source", "workspace-cli", workspace_build_dependency, cases=["S-298.4"],
                 runners=("service-local:explore",))

    def no_outputs() -> str | None:
        try:
            with tempfile.TemporaryDirectory(prefix="kb-devkit-cache-no-output-") as temporary:
                root, home = Path(temporary) / "workspace", Path(temporary) / "home"
                home.mkdir(); app = root / "packages/app"; (app / "src").mkdir(parents=True)
                (app / "src/in.txt").write_text("input\n")
                (app / "prepare.js").write_text('require("fs").mkdirSync("dist",{recursive:true}); require("fs").appendFileSync("dist/prepared","p");')
                (app / "build.js").write_text('require("fs").mkdirSync("dist",{recursive:true}); require("fs").appendFileSync("dist/out",require("fs").readFileSync("dist/prepared"));')
                config = '''schemaVersion: 2\nworkspace:\n  categories:\n    apps:\n      match: ["packages/app"]\n      preset: node-lib\ntasks:\n  prepare:\n    command: "node prepare.js"\n    inputs: ["src/**"]\n  build:\n    command: "node build.js"\n    inputs: ["dist/prepared"]\n    outputs: ["dist/out"]\n    deps: ["prepare"]\n'''
                _fixture(root, {"app": '{"name":"@fixture/app"}'}, config)
                for attempt in range(2):
                    result = _tasks(_run(binary, root, home, "build"))
                    _require(result[("@fixture/app", "prepare")] is False and result[("@fixture/app", "build")] is False,
                             f"attempt {attempt + 1}: missing prerequisite outputs unexpectedly permitted cache hit")
                    _require((app / "dist/out").read_text() == ("p", "ppp")[attempt],
                             "prerequisite or consumer did not execute its command on this run")
            return None
        except (AssertionError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            return str(error)

    journey.step("disable cache when prerequisite has no declared outputs", "workspace-cli", no_outputs, cases=["S-298.5"],
                 runners=("service-local:explore",))

    def affected_chain() -> str | None:
        try:
            with tempfile.TemporaryDirectory(prefix="kb-devkit-cache-affected-") as temporary:
                root, home = Path(temporary) / "workspace", Path(temporary) / "home"
                home.mkdir()
                names = ("raw", "generate", "bundle", "test")
                manifests = {}
                for index, name in enumerate(names):
                    deps = "" if not index else f',"dependencies":{{"@fixture/{names[index - 1]}":"workspace:*"}}'
                    manifests[name] = '{"name":"@fixture/' + name + '"' + deps + '}'
                    package = root / "packages" / name
                    (package / "src").mkdir(parents=True)
                (root / "packages/raw/src/one.txt").write_text("one\n")
                (root / "packages/generate/run.sh").write_text('mkdir -p dist; cat ../raw/dist/raw.txt > dist/generated.txt')
                (root / "packages/bundle/run.sh").write_text('mkdir -p dist; cat ../generate/dist/generated.txt > dist/bundle.txt')
                (root / "packages/test/run.sh").write_text('mkdir -p dist; cat ../bundle/dist/bundle.txt > dist/test.txt')
                config = '''schemaVersion: 2\nworkspace:\n  categories:\n    raw:\n      match: ["packages/raw"]\n      preset: node-lib\n    generate:\n      match: ["packages/generate"]\n      preset: node-lib\n    bundle:\n      match: ["packages/bundle"]\n      preset: node-lib\n    test:\n      match: ["packages/test"]\n      preset: node-lib\ntasks:\n  raw:\n    categories: [raw]\n    command: 'sh -c "mkdir -p dist && cat src/*.txt > dist/raw.txt"'\n    inputs: ["src/**"]\n    outputs: ["dist/**"]\n  generate:\n    categories: [generate]\n    command: "sh run.sh"\n    inputs: ["^dist/**"]\n    outputs: ["dist/**"]\n    deps: ["^raw"]\n  bundle:\n    categories: [bundle]\n    command: "sh run.sh"\n    inputs: ["^dist/**"]\n    outputs: ["dist/**"]\n    deps: ["^generate"]\n  test:\n    categories: [test]\n    command: "sh run.sh"\n    inputs: ["^dist/**"]\n    outputs: ["dist/**"]\n    deps: ["^bundle"]\n'''
                _fixture(root, manifests, config)
                first = _tasks(_run(binary, root, home, "test"))
                _require(len(first) == 4, f"initial chain results were {first}")
                _require(not _tasks(_run(binary, root, home, "test", "--affected")),
                         "unchanged workspace chain was selected as affected")
                (root / "packages/raw/src/two.txt").write_text("two\n")
                changed = _tasks(_run(binary, root, home, "test", "--affected"))
                _require(len(changed) == 4 and all(not hit for hit in changed.values()),
                         f"affected run did not rebuild all four tasks: {changed}")
                final = (root / "packages/test/dist/test.txt").read_text()
                _require(final == "one\ntwo\n", f"final affected output was {final!r}")
            return None
        except (AssertionError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            return str(error)

    journey.step("propagate affected source through a deep task chain", "workspace-cli", affected_chain, cases=["S-298.7"],
                 runners=("service-local:explore",))

    # S-298.9 uses the same real affected CLI path but a same-package task chain.
    def same_package_chain() -> str | None:
        try:
            with tempfile.TemporaryDirectory(prefix="kb-devkit-cache-local-chain-") as temporary:
                root, home = Path(temporary) / "workspace", Path(temporary) / "home"
                home.mkdir(); app = root / "packages/app"; (app / "src").mkdir(parents=True)
                (app / "src/one.txt").write_text("one\n")
                config = '''schemaVersion: 2\nworkspace:\n  categories:\n    app:\n      match: ["packages/app"]\n      preset: node-lib\ntasks:\n  raw:\n    categories: [app]\n    command: 'sh -c "mkdir -p dist && cat src/*.txt > dist/raw"'\n    inputs: ["src/**"]\n    outputs: ["dist/raw"]\n  generate:\n    categories: [app]\n    command: 'sh -c "mkdir -p dist && cat dist/raw > dist/generated"'\n    inputs: ["dist/raw"]\n    outputs: ["dist/generated"]\n    deps: [raw]\n  test:\n    categories: [app]\n    command: 'sh -c "mkdir -p dist && cat dist/generated > dist/test"'\n    inputs: ["dist/generated"]\n    outputs: ["dist/test"]\n    deps: [generate]\n'''
                _fixture(root, {"app": '{"name":"@fixture/app"}'}, config)
                _run(binary, root, home, "test")
                _require(not _tasks(_run(binary, root, home, "test", "--affected")),
                         "unchanged same-package chain was selected as affected")
                (app / "src/two.txt").write_text("two\n")
                result = _tasks(_run(binary, root, home, "test", "--affected"))
                _require(len(result) == 3 and all(not hit for hit in result.values()), f"same-package affected chain was {result}")
                _require((app / "dist/test").read_text() == "one\ntwo\n", "same-package final output omitted new input")
            return None
        except (AssertionError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            return str(error)

    journey.step("propagate affected source through same-package prerequisites", "workspace-cli", same_package_chain, cases=["S-298.9"],
                 runners=("service-local:explore",))

    def aggregate_ownership() -> str | None:
        try:
            with tempfile.TemporaryDirectory(prefix="kb-devkit-cache-aggregate-") as temporary:
                root, home = Path(temporary) / "workspace", Path(temporary) / "home"
                home.mkdir()
                group, child, consumer = root / "packages/group", root / "packages/group/child", root / "packages/consumer"
                (group / "src").mkdir(parents=True); (child / "src").mkdir(parents=True)
                (consumer / "src").mkdir(parents=True)
                (consumer / "read.js").write_text('const fs=require("fs"); fs.mkdirSync("dist",{recursive:true}); fs.writeFileSync("dist/list.txt",fs.readdirSync("../group/src").filter(x=>x.endsWith(".ts")).sort().join("\\n"));')
                config = '''schemaVersion: 2\nworkspace:\n  categories:\n    groups:\n      match: ["packages/group"]\n      preset: node-lib\n    children:\n      match: ["packages/group/child"]\n      preset: node-lib\n    consumers:\n      match: ["packages/consumer"]\n      preset: node-lib\ntasks:\n  generate:\n    categories: [consumers]\n    command: "node read.js"\n    outputs: ["dist/list.txt"]\n    deps: ["^generate"]\n'''
                manifests = {"group": '{"name":"@fixture/group"}',
                             "group/child": '{"name":"@fixture/group-child"}',
                             "consumer": '{"name":"@fixture/consumer","dependencies":{"@fixture/group":"workspace:*"}}'}
                _fixture(root, manifests, config)
                _run(binary, root, home, "generate")
                (child / "src/new.ts").write_text("child\n")
                after_child = _tasks(_run(binary, root, home, "generate"))
                _require(after_child[("@fixture/consumer", "generate")] is True,
                         "nested child-owned source changed aggregate dependency digest")
                (group / "src/own.ts").write_text("aggregate\n")
                after_group = _tasks(_run(binary, root, home, "generate"))
                _require(after_group[("@fixture/consumer", "generate")] is False,
                         "aggregate-owned source did not change dependency digest")
                _require((consumer / "dist/list.txt").read_text() == "own.ts", "consumer did not observe aggregate-owned source")
            return None
        except (AssertionError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            return str(error)

    journey.step("respect nested package ownership in aggregate dependency digest", "workspace-cli", aggregate_ownership, cases=["S-298.10"],
                 runners=("service-local:explore",))
