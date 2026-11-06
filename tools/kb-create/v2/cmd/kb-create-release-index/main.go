// kb-create-release-index is the publish-time release-index sealer. It
// turns a normalized manifest export into a sealed immutable release index;
// it is not an installer and never reads a user's platform directory.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/release"
	"github.com/kb-labs/create/v2/scenario"
	"gopkg.in/yaml.v3"
)

func main() {
	command.Exit(executeCommand())
}

func executeCommand() diag.ExitStatus {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "targets":
			if err := runTargets(os.Args[2:], os.Stdout); err != nil {
				return digestFailure(err)
			}
			return diag.SuccessStatus()
		case "digest":
			return executeDigest(os.Args[2:])
		case "provenance":
			return executeProvenance(os.Args[2:])
		}
	}
	return execute()
}

// runTargets projects the declared GoReleaser matrix, including missing artifacts.
func runTargets(args []string, output io.Writer) error {
	if len(args) != 2 {
		return fmt.Errorf("usage: kb-create-release-index targets <goreleaser-config> <build-id>")
	}
	data, err := os.ReadFile(args[0])
	if err != nil {
		return err
	}
	var config struct {
		Builds []struct {
			ID     string   `yaml:"id"`
			OS     []string `yaml:"goos"`
			Arch   []string `yaml:"goarch"`
			Ignore []struct {
				OS   string `yaml:"goos"`
				Arch string `yaml:"goarch"`
			} `yaml:"ignore"`
		} `yaml:"builds"`
	}
	if err := yaml.Unmarshal(data, &config); err != nil {
		return err
	}
	for _, build := range config.Builds {
		if build.ID == args[1] {
			if len(build.OS) == 0 || len(build.Arch) == 0 {
				return fmt.Errorf("build %q must explicitly declare goos and goarch", build.ID)
			}
			targets := []catalog.BinaryTarget{}
			for _, osname := range build.OS {
				for _, arch := range build.Arch {
					ignored := false
					for _, item := range build.Ignore {
						if (item.OS == "" || item.OS == osname) && (item.Arch == "" || item.Arch == arch) {
							ignored = true
							break
						}
					}
					if !ignored {
						targets = append(targets, catalog.BinaryTarget{OS: osname, Arch: arch})
					}
				}
			}
			return json.NewEncoder(output).Encode(targets)
		}
	}
	return fmt.Errorf("GoReleaser build %q not found", args[1])
}

func executeProvenance(args []string) diag.ExitStatus {
	if err := runProvenance(args, os.Stdin, os.Stdout); err == nil {
		return diag.SuccessStatus()
	} else {
		return digestFailure(err)
	}
}

func runProvenance(args []string, input io.Reader, output io.Writer) error {
	if len(args) != 2 || args[0] == "" || args[1] == "" {
		return fmt.Errorf("usage: kb-create-release-index provenance <packages-directory> <source-revision>")
	}
	var packages []artifacts.PackageManifestInput
	if err := json.NewDecoder(input).Decode(&packages); err != nil {
		return err
	}
	sealed, err := artifacts.SealPackageProvenance(args[0], packages, args[1])
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(sealed)
}

func executeDigest(args []string) diag.ExitStatus {
	if err := runDigest(args, os.Stdin, os.Stdout); err == nil {
		return diag.SuccessStatus()
	} else {
		return digestFailure(err)
	}
}

func runDigest(args []string, input io.Reader, output io.Writer) error {
	var result any
	var err error
	switch {
	case len(args) == 2 && args[0] == "package-set":
		var packages []artifacts.PackageManifestInput
		if err = json.NewDecoder(input).Decode(&packages); err == nil {
			var digest string
			digest, err = artifacts.PackageSetContentDigest(args[1], packages)
			result = struct {
				Schema string `json:"schema"`
				Digest string `json:"digest"`
			}{Schema: "kb-package-set-digest/v1", Digest: digest}
		}
	case len(args) == 1:
		var digest string
		digest, err = artifacts.DistDigest(args[0])
		result = struct {
			Schema string `json:"schema"`
			Digest string `json:"digest"`
		}{Schema: artifacts.DistDigestVersion, Digest: digest}
	case len(args) == 2 && args[0] == "package":
		var digest string
		digest, err = artifacts.PackageDistDigest(args[1])
		result = struct {
			Schema string `json:"schema"`
			Digest string `json:"digest"`
		}{Schema: artifacts.DistDigestVersion, Digest: digest}
	case len(args) == 2 && args[0] == "integrity":
		var integrity string
		integrity, err = artifacts.TarballIntegrity(args[1])
		result = struct {
			Schema    string `json:"schema"`
			Integrity string `json:"integrity"`
		}{Schema: "kb-tarball-integrity/v1", Integrity: integrity}
	case len(args) == 2 && args[0] == "sha256":
		var digest string
		digest, err = artifacts.SHA256File(args[1])
		result = struct {
			Schema string `json:"schema"`
			Digest string `json:"digest"`
		}{Schema: "kb-file-sha256/v1", Digest: digest}
	default:
		err = fmt.Errorf("usage: kb-create-release-index digest <dist-directory> | digest package <dist-directory> | digest package-set <packages-directory> (package JSON on stdin) | digest integrity <tarball> | digest sha256 <file>")
	}
	if err == nil {
		return json.NewEncoder(output).Encode(result)
	}
	return err
}

func digestFailure(err error) diag.ExitStatus {
	failure, status, envelopeErr := sealingFailureResult(&sealingFailure{
		gate: "package content digest", rule: err.Error(),
		hint: "Fix the packed package input, then rerun release-index preparation.", err: err,
	})
	if envelopeErr != nil {
		fmt.Fprintf(os.Stderr, "kb-create-release-index: failed to format digest diagnostic: %v\n", envelopeErr)
		return diag.ExitCode(diag.New("KB_RUNTIME_UNEXPECTED", "The package digest failure could not be formatted.",
			diag.WithCauseAndReason(envelopeErr.Error()), diag.WithHint("Check the release-index diagnostic and rerun release-index preparation.")))
	}
	_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"ok": false, "error": failure})
	return status
}

func execute() diag.ExitStatus {
	input := flag.String("input", "", "normalized V2 release-index export JSON")
	output := flag.String("output", "", "sealed immutable release-index JSON")
	manifestRoot := flag.String("manifest-root", "", "staging root containing exact V2 package manifests")
	var historyIndexes stringList
	flag.Var(&historyIndexes, "history-index", "previously sealed release index to carry into this candidate")
	flag.Parse()
	if err := run(*input, *output, *manifestRoot, historyIndexes...); err != nil {
		failure, status, envelopeErr := sealingFailureResult(err)
		if envelopeErr != nil {
			fmt.Fprintf(os.Stderr, "kb-create-release-index: failed to format diagnostic: %v\n", envelopeErr)
			return diag.ExitCode(diag.New("KB_RUNTIME_UNEXPECTED", "The release-index failure could not be formatted.",
				diag.WithCauseAndReason(envelopeErr.Error()),
				diag.WithHint("Check the release-index diagnostic and rerun release-index preparation.")))
		}
		_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"ok": false, "error": failure})
		return status
	}
	return diag.SuccessStatus()
}

type sealingFailure struct {
	gate, rule, hint string
	err              error
}

func (failure *sealingFailure) Error() string { return failure.err.Error() }
func (failure *sealingFailure) Unwrap() error { return failure.err }

func sealingFailureEnvelope(err error) (diag.Envelope, error) {
	envelope, _, envelopeErr := sealingFailureResult(err)
	return envelope, envelopeErr
}

func sealingFailureResult(err error) (diag.Envelope, diag.ExitStatus, error) {
	var failure *sealingFailure
	if !errors.As(err, &failure) {
		failure = &sealingFailure{
			gate: "release-index validation", rule: err.Error(),
			hint: "Fix the release inputs named in the cause, then rerun release-index preparation.",
			err:  err,
		}
	}
	diagnostic := contracts.NewDiag(contracts.CodeReleaseIndexSealFailed, "could not seal V2 release index", failure.hint, failure.err)
	diagnostic.Cause = failure.rule
	diagnostic.Meta = map[string]any{"gate": failure.gate, "rule": failure.rule}
	envelope, envelopeErr := diag.ToEnvelope(diagnostic)
	return envelope, diag.ExitCode(diagnostic), envelopeErr
}

type stringList []string

func (values *stringList) String() string { return fmt.Sprint([]string(*values)) }
func (values *stringList) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func run(input, output, manifestRoot string, historyIndexes ...string) error {
	if input == "" || output == "" || manifestRoot == "" {
		return fmt.Errorf("--input, --output and --manifest-root are required")
	}
	data, err := os.ReadFile(input)
	if err != nil {
		return err
	}
	var source catalog.Catalog
	if err := json.Unmarshal(data, &source); err != nil {
		return err
	}
	source, err = release.EnrichWithManifests(source, manifestRoot)
	if err != nil {
		hint := "Fix the manifest named in the cause, then rerun release-index preparation."
		var rule *release.ManifestRuleError
		if errors.As(err, &rule) {
			hint = rule.Hint
		}
		return &sealingFailure{
			gate: "manifest validation", rule: err.Error(),
			hint: hint,
			err:  err,
		}
	}
	if err := scenario.ValidateCatalog(source); err != nil {
		return fmt.Errorf("built-in scenario validation: %w", err)
	}
	for _, historyPath := range historyIndexes {
		history, err := catalog.LoadFile(historyPath)
		if err != nil {
			return fmt.Errorf("load sealed history index %s: %w", historyPath, err)
		}
		source, err = mergeReleaseHistory(source, history)
		if err != nil {
			return err
		}
	}
	// Exports intentionally omit release-controlled fields. Schema and digest
	// are assigned here, after all manifest data has been collected.
	source.Schema, source.Digest = "", ""
	sealed, err := catalog.Seal(source)
	if err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(sealed, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o750); err != nil {
		return err
	}
	temporary := output + ".tmp"
	if err := os.WriteFile(temporary, append(encoded, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, output)
}

func mergeReleaseHistory(target, history catalog.Catalog) (catalog.Catalog, error) {
	platforms := make(map[string]struct{}, len(target.Platforms))
	for _, platform := range target.Platforms {
		platforms[platform.ID+"@"+platform.Version] = struct{}{}
	}
	for _, platform := range history.Platforms {
		key := platform.ID + "@" + platform.Version
		if _, exists := platforms[key]; !exists {
			target.Platforms = append(target.Platforms, platform)
			platforms[key] = struct{}{}
		}
	}

	sdks := make(map[string]struct{}, len(target.SDKs))
	for _, sdk := range target.SDKs {
		sdks[sdk.ID+"@"+sdk.Version] = struct{}{}
	}
	for _, sdk := range history.SDKs {
		key := sdk.ID + "@" + sdk.Version
		if _, exists := sdks[key]; !exists {
			target.SDKs = append(target.SDKs, sdk)
			sdks[key] = struct{}{}
		}
	}
	if history.Compatibility != nil {
		if target.Compatibility == nil {
			target.Compatibility = &catalog.CompatibilityMatrix{Schema: history.Compatibility.Schema}
		}
		labels := make(map[string]int, len(target.Compatibility.Labels))
		for index, label := range target.Compatibility.Labels {
			labels[label.ID] = index
		}
		for _, label := range history.Compatibility.Labels {
			if index, exists := labels[label.ID]; exists {
				target.Compatibility.Labels[index].Requires = mergeCompatibilityRelations(target.Compatibility.Labels[index].Requires, label.Requires)
			} else {
				target.Compatibility.Labels = append(target.Compatibility.Labels, label)
				labels[label.ID] = len(target.Compatibility.Labels) - 1
			}
		}
	}
	return target, nil
}

func mergeCompatibilityRelations(target, history []catalog.CompatibilityRelation) []catalog.CompatibilityRelation {
	seen := make(map[catalog.CompatibilityRelation]struct{}, len(target))
	for _, relation := range target {
		seen[relation] = struct{}{}
	}
	for _, relation := range history {
		if _, exists := seen[relation]; exists {
			continue
		}
		target = append(target, relation)
		seen[relation] = struct{}{}
	}
	return target
}
