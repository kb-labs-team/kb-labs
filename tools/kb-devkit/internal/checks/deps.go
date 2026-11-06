package checks

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// DepsRule checks dependency link resolution, declaration of imported
// workspace packages, relative package boundaries, version consistency, and
// configured @kb-labs/* boundaries.
type DepsRule struct {
	workspace *workspace.Workspace
}

func (r *DepsRule) SetWorkspace(ws *workspace.Workspace) {
	r.workspace = ws
}

func (r *DepsRule) Name() string { return "deps" }

func (r *DepsRule) Check(pkg workspace.Package, preset config.Preset) []Issue {
	rules := preset.Deps
	hasBoundaryRules := len(rules.AllowedKbDeps) > 0 || len(rules.ForbiddenKbDeps) > 0 || len(rules.AllowedKbImports) > 0 || len(rules.ForbiddenKbImports) > 0

	path := filepath.Join(pkg.Dir, "package.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	var raw struct {
		Name                 string            `json:"name"`
		Dependencies         map[string]string `json:"dependencies"`
		OptionalDependencies map[string]string `json:"optionalDependencies"`
		DevDependencies      map[string]string `json:"devDependencies"`
		PeerDependencies     map[string]string `json:"peerDependencies"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}

	var issues []Issue

	allDeps := make(map[string]string)
	for k, v := range raw.Dependencies {
		allDeps[k] = v
	}
	for k, v := range raw.OptionalDependencies {
		allDeps[k] = v
	}
	for k, v := range raw.DevDependencies {
		allDeps[k] = v
	}
	for k, v := range raw.PeerDependencies {
		allDeps[k] = v
	}

	if rules.CheckLinks {
		issues = append(issues, checkLinkDeps(pkg.Dir, allDeps, r.Name())...)
	}
	if pkg.PnpmMember {
		issues = append(issues, checkWorkspaceDependencyTargets(pkg, r.workspace, allDeps, r.Name())...)
		issues = append(issues, checkDeclaredWorkspaceImports(pkg, r.workspace, raw.Name, allDeps, r.Name())...)
		issues = append(issues, checkRelativeWorkspaceImports(pkg, r.workspace, r.Name())...)
	}

	if hasBoundaryRules {
		issues = append(issues, checkBoundaryDeps(pkg, raw.Name, allDeps, rules, r.Name())...)
		issues = append(issues, checkBoundaryImports(pkg, raw.Name, rules, r.Name())...)
	}

	return issues
}

func checkWorkspaceDependencyTargets(pkg workspace.Package, ws *workspace.Workspace, deps map[string]string, checkName string) []Issue {
	var issues []Issue
	for depName, depVersion := range deps {
		if !strings.HasPrefix(depVersion, "workspace:") {
			continue
		}
		found := false
		if ws != nil {
			for _, member := range ws.Packages {
				if member.PnpmMember && member.Name == depName {
					found = true
					break
				}
			}
		}
		if !found {
			issues = append(issues, Issue{
				Check:    checkName,
				Severity: SeverityError,
				Message:  fmt.Sprintf("workspace dependency %q does not name a pnpm workspace member", depName),
				File:     filepath.Join(pkg.Dir, "package.json"),
			})
		}
	}
	return issues
}

// checkLinkDeps validates that all link: dependencies point to existing directories
// with matching package names.
func checkLinkDeps(pkgDir string, deps map[string]string, checkName string) []Issue {
	var issues []Issue
	for depName, depVer := range deps {
		if !strings.HasPrefix(depVer, "link:") {
			continue
		}
		linkPath := strings.TrimPrefix(depVer, "link:")
		resolved := filepath.Join(pkgDir, linkPath)
		abs, err := filepath.Abs(resolved)
		if err != nil {
			issues = append(issues, Issue{
				Check:    checkName,
				Severity: SeverityError,
				Message:  fmt.Sprintf("cannot resolve link: path %q for %q", linkPath, depName),
			})
			continue
		}

		if _, err := os.Stat(abs); os.IsNotExist(err) {
			issues = append(issues, Issue{
				Check:    checkName,
				Severity: SeverityError,
				Message:  fmt.Sprintf("link: target %q does not exist (dep: %q)", abs, depName),
				Fix:      fmt.Sprintf("check that %s is initialized (git submodule update --init)", linkPath),
			})
			continue
		}

		targetPkgJSON := filepath.Join(abs, "package.json")
		targetData, err := os.ReadFile(targetPkgJSON)
		if err != nil {
			continue
		}
		var targetPkg struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(targetData, &targetPkg); err != nil {
			continue
		}
		if targetPkg.Name != "" && targetPkg.Name != depName {
			issues = append(issues, Issue{
				Check:    checkName,
				Severity: SeverityError,
				Message:  fmt.Sprintf("link: target name %q does not match declared dep %q", targetPkg.Name, depName),
				File:     targetPkgJSON,
			})
		}
	}
	return issues
}

// checkBoundaryDeps enforces allowed/forbidden @kb-labs/* dependencies declared
// in package.json against the preset's lists.
func checkBoundaryDeps(pkg workspace.Package, pkgName string, deps map[string]string, rules config.DepsRules, checkName string) []Issue {
	var issues []Issue
	for depName := range deps {
		if !strings.HasPrefix(depName, "@kb-labs/") {
			continue
		}
		// Self-dependency: a package is allowed to depend on its own
		// subpackages (e.g. monorepo nested packages share scope).
		if depName == pkgName {
			continue
		}
		// AllowedKbDeps takes priority over ForbiddenKbDeps — an explicit
		// allowlist entry is an intentional exception (e.g. gateway-auth in
		// environment-docker).
		if len(rules.AllowedKbDeps) > 0 && matchAny(depName, rules.AllowedKbDeps) {
			continue
		}
		if matchAny(depName, rules.ForbiddenKbDeps) {
			issues = append(issues, Issue{
				Check:    checkName,
				Severity: SeverityError,
				Message: fmt.Sprintf(
					"forbidden dependency %q in package.json — adapters/plugins must depend only on @kb-labs/sdk",
					depName,
				),
				File: filepath.Join(pkg.Dir, "package.json"),
			})
			continue
		}
		if len(rules.AllowedKbDeps) > 0 && !matchAny(depName, rules.AllowedKbDeps) {
			issues = append(issues, Issue{
				Check:    checkName,
				Severity: SeverityError,
				Message: fmt.Sprintf(
					"dependency %q is not in the allowlist — adapters/plugins must depend only on @kb-labs/sdk",
					depName,
				),
				File: filepath.Join(pkg.Dir, "package.json"),
			})
		}
	}
	return issues
}

// checkBoundaryImports walks the package source tree and reports any
// @kb-labs/* import string that violates the allow/forbid lists.
func checkBoundaryImports(pkg workspace.Package, pkgName string, rules config.DepsRules, checkName string) []Issue {
	var issues []Issue
	srcDir := filepath.Join(pkg.Dir, "src")
	forEachSourceFile(srcDir, nil, func(path string, data []byte) {
		for _, spec := range findKbFromImports(data) {
			if spec == pkgName || strings.HasPrefix(spec, pkgName+"/") {
				continue
			}
			if len(rules.AllowedKbDeps) > 0 && matchAny(spec, rules.AllowedKbDeps) {
				continue
			}
			if containsExact(rules.AllowedKbImports, spec) {
				continue
			}
			if containsExact(rules.ForbiddenKbImports, spec) {
				issues = append(issues, Issue{
					Check: checkName, Severity: SeverityError,
					Message: fmt.Sprintf("forbidden import %q", spec), File: path,
				})
				continue
			}
			if matchAny(spec, rules.ForbiddenKbDeps) {
				issues = append(issues, Issue{
					Check:    checkName,
					Severity: SeverityError,
					Message: fmt.Sprintf(
						"forbidden import %q — adapters/plugins must import only from @kb-labs/sdk",
						spec,
					),
					File: path,
				})
				continue
			}
			if len(rules.AllowedKbDeps) > 0 && !matchAny(spec, rules.AllowedKbDeps) {
				issues = append(issues, Issue{
					Check:    checkName,
					Severity: SeverityError,
					Message: fmt.Sprintf(
						"import %q is not in the allowlist — adapters/plugins must import only from @kb-labs/sdk",
						spec,
					),
					File: path,
				})
			}
		}
	})
	return issues
}

func checkDeclaredWorkspaceImports(pkg workspace.Package, ws *workspace.Workspace, pkgName string, deps map[string]string, checkName string) []Issue {
	var issues []Issue
	forEachSourceFile(pkg.Dir, ws, func(path string, data []byte) {
		for _, spec := range findKbFromImports(data) {
			dependency := kbPackageName(spec)
			if dependency == pkgName {
				continue
			}
			if _, declared := deps[dependency]; declared {
				continue
			}
			issues = append(issues, Issue{
				Check:    checkName,
				Severity: SeverityError,
				Message:  fmt.Sprintf("import %q uses undeclared workspace dependency %q", spec, dependency),
				File:     path,
			})
		}
	})
	return issues
}

func checkRelativeWorkspaceImports(pkg workspace.Package, ws *workspace.Workspace, checkName string) []Issue {
	if ws == nil {
		return nil
	}
	var issues []Issue
	forEachSourceFile(pkg.Dir, ws, func(path string, data []byte) {
		for _, spec := range findModuleSpecifiers(data) {
			if !strings.HasPrefix(spec, "./") && !strings.HasPrefix(spec, "../") {
				continue
			}
			resolved, ok := resolveRelativeImport(path, spec)
			if !ok {
				continue
			}
			owner, ok := ws.PackageByPath(resolved)
			if !ok || !owner.PnpmMember || owner.Dir == pkg.Dir {
				continue
			}
			issues = append(issues, Issue{
				Check:    checkName,
				Severity: SeverityError,
				Message:  fmt.Sprintf("relative import %q resolves into workspace package %q; import the package by name", spec, owner.Name),
				File:     path,
			})
		}
	})
	return issues
}

func kbPackageName(spec string) string {
	if !strings.HasPrefix(spec, "@kb-labs/") {
		return ""
	}
	if slash := strings.IndexByte(spec[len("@kb-labs/"):], '/'); slash >= 0 {
		return spec[:len("@kb-labs/")+slash]
	}
	return spec
}

func forEachSourceFile(root string, ws *workspace.Workspace, visit func(path string, data []byte)) {
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			switch info.Name() {
			case "node_modules", "dist", ".git", ".next", ".turbo", "coverage":
				return filepath.SkipDir
			}
			if path != root {
				if _, err := os.Stat(filepath.Join(path, "package.json")); err == nil {
					if ws == nil {
						return filepath.SkipDir
					}
					if owner, ok := ws.PackageByPath(path); !ok || owner.Dir != path {
						return filepath.SkipDir
					}
				}
			}
			return nil
		}
		switch filepath.Ext(path) {
		case ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs":
			if ws != nil {
				if owner, ok := ws.PackageByPath(path); ok && owner.Dir != root {
					return nil
				}
			}
			data, readErr := os.ReadFile(path)
			if readErr == nil {
				visit(path, data)
			}
		}
		return nil
	})
}

func resolveRelativeImport(fromFile, spec string) (string, bool) {
	base := filepath.Clean(filepath.Join(filepath.Dir(fromFile), filepath.FromSlash(spec)))
	if filepath.Ext(base) != "" {
		info, err := os.Stat(base)
		return base, err == nil && !info.IsDir()
	}
	for _, ext := range []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"} {
		candidate := base + ext
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, true
		}
	}
	for _, ext := range []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"} {
		candidate := filepath.Join(base, "index"+ext)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, true
		}
	}
	return "", false
}

func containsExact(values []string, candidate string) bool {
	for _, value := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

// findKbFromImports extracts package specifiers from static `from "..."`
// clauses while ignoring comments, strings, and template literals. A regex
// over the raw source would also match import examples in JSDoc comments.
func findKbFromImports(data []byte) []string {
	var specs []string
	for _, spec := range findModuleSpecifiers(data) {
		if strings.HasPrefix(spec, "@kb-labs/") {
			specs = append(specs, spec)
		}
	}
	return specs
}

func findModuleSpecifiers(data []byte) []string {
	var specs []string

	for i := 0; i < len(data); {
		switch {
		case data[i] == '/' && i+1 < len(data) && data[i+1] == '/':
			i = skipLineComment(data, i+2)
		case data[i] == '/' && i+1 < len(data) && data[i+1] == '*':
			i = skipBlockComment(data, i+2)
		case data[i] == '\'' || data[i] == '"':
			i = skipQuotedString(data, i)
		case data[i] == '`':
			i = skipTemplateLiteral(data, i)
		case isIdentifierStart(data[i]):
			start := i
			i++
			for i < len(data) && isIdentifierPart(data[i]) {
				i++
			}
			word := string(data[start:i])
			if word == "import" || word == "require" {
				next := skipWhitespaceAndComments(data, i)
				if word == "import" && next < len(data) && data[next] == '.' {
					continue
				}
				if word == "import" && next < len(data) && (data[next] == '\'' || data[next] == '"') {
					spec, after := readQuotedString(data, next)
					specs = append(specs, spec)
					i = after
					continue
				}
				if next < len(data) && data[next] == '(' {
					next = skipWhitespaceAndComments(data, next+1)
					if next < len(data) && (data[next] == '\'' || data[next] == '"') {
						spec, after := readQuotedString(data, next)
						specs = append(specs, spec)
						i = after
					}
				}
				continue
			}
			if word != "from" {
				continue
			}

			i = skipWhitespaceAndComments(data, i)
			if i >= len(data) || (data[i] != '\'' && data[i] != '"') {
				continue
			}
			spec, next := readQuotedString(data, i)
			i = next
			specs = append(specs, spec)
		default:
			i++
		}
	}

	return specs
}

func isIdentifierStart(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || b == '_' || b == '$'
}

func isIdentifierPart(b byte) bool {
	return isIdentifierStart(b) || (b >= '0' && b <= '9')
}

func skipWhitespaceAndComments(data []byte, i int) int {
	for i < len(data) {
		if data[i] == ' ' || data[i] == '\t' || data[i] == '\r' || data[i] == '\n' {
			i++
			continue
		}
		if data[i] == '/' && i+1 < len(data) && data[i+1] == '/' {
			i = skipLineComment(data, i+2)
			continue
		}
		if data[i] == '/' && i+1 < len(data) && data[i+1] == '*' {
			i = skipBlockComment(data, i+2)
			continue
		}
		break
	}
	return i
}

func skipLineComment(data []byte, i int) int {
	for i < len(data) && data[i] != '\n' {
		i++
	}
	return i
}

func skipBlockComment(data []byte, i int) int {
	for i+1 < len(data) {
		if data[i] == '*' && data[i+1] == '/' {
			return i + 2
		}
		i++
	}
	return len(data)
}

func skipQuotedString(data []byte, i int) int {
	_, next := readQuotedString(data, i)
	return next
}

func readQuotedString(data []byte, i int) (string, int) {
	quote := data[i]
	i++
	start := i
	var value strings.Builder
	for i < len(data) {
		if data[i] == '\\' {
			if i+1 < len(data) {
				i += 2
			} else {
				i++
			}
			continue
		}
		if data[i] == quote {
			value.Write(data[start:i])
			return value.String(), i + 1
		}
		i++
	}
	value.Write(data[start:])
	return value.String(), len(data)
}

func skipTemplateLiteral(data []byte, i int) int {
	i++
	for i < len(data) {
		if data[i] == '\\' {
			i += 2
			continue
		}
		if data[i] == '`' {
			return i + 1
		}
		i++
	}
	return len(data)
}

// matchAny reports whether s matches any of the glob-style patterns. A pattern
// of "@kb-labs/foo" matches exact + any sub-path ("@kb-labs/foo", "@kb-labs/foo/bar").
// A pattern with "*" is interpreted as a simple glob (* matches any non-slash run).
func matchAny(s string, patterns []string) bool {
	for _, p := range patterns {
		if matchPattern(s, p) {
			return true
		}
	}
	return false
}

func matchPattern(s, pattern string) bool {
	if strings.ContainsAny(pattern, "*?[") {
		// Use filepath.Match for glob semantics. For multi-segment globs like
		// "@kb-labs/core-*", filepath.Match treats "/" as a separator; we want
		// it to be a regular char, so swap to a placeholder.
		const slashPlaceholder = "\x00"
		ps := strings.ReplaceAll(pattern, "/", slashPlaceholder)
		ss := strings.ReplaceAll(s, "/", slashPlaceholder)
		ok, err := filepath.Match(ps, ss)
		if err == nil && ok {
			return true
		}
		// Also allow the pattern to match a prefix followed by an additional
		// sub-path: pattern "@kb-labs/sdk/*" should match "@kb-labs/sdk/adapters".
		// Handle the common "<prefix>/*" trailing form explicitly.
		if strings.HasSuffix(pattern, "/*") {
			prefix := strings.TrimSuffix(pattern, "/*")
			if s == prefix || strings.HasPrefix(s, prefix+"/") {
				return true
			}
		}
		return false
	}
	// Literal pattern: match exact or any sub-path.
	return s == pattern || strings.HasPrefix(s, pattern+"/")
}
