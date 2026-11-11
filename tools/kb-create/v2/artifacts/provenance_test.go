package artifacts

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
)

func TestStaticPackageProvenanceCoversWholePackageAndDetectsChanges(t *testing.T) {
	archivePath := filepath.Join(t.TempDir(), "static.tgz")
	manifest := []byte(`{"name":"@kb-labs/static-config","version":"1.0.0","exports":{"./config.json":"./config.json"},"files":["config.json"]}`)
	var archive bytes.Buffer
	compressed := gzip.NewWriter(&archive)
	tarWriter := tar.NewWriter(compressed)
	for _, entry := range []struct {
		name string
		data []byte
	}{{"package/package.json", manifest}, {"package/config.json", []byte(`{"mode":"safe"}`)}} {
		if err := tarWriter.WriteHeader(&tar.Header{Name: entry.name, Mode: 0o644, Size: int64(len(entry.data))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write(entry.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archivePath, archive.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	sealed, err := SealPackageProvenance(filepath.Dir(archivePath), []PackageManifestInput{{Package: "@kb-labs/static-config", Version: "1.0.0", Tarball: filepath.Base(archivePath)}}, "revision-1")
	if err != nil {
		t.Fatalf("seal static package: %v", err)
	}
	if len(sealed) != 1 || sealed[0].ContentScope != "package" || sealed[0].PackageSHA256 == "" || sealed[0].DistSHA256 != "" {
		t.Fatalf("static package provenance = %#v", sealed)
	}
	root := t.TempDir()
	packageRoot := filepath.Join(root, "node_modules", "@kb-labs", "static-config")
	if err := os.MkdirAll(packageRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), manifest, 0o644); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(packageRoot, "config.json")
	if err := os.WriteFile(config, []byte(`{"mode":"safe"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	item := contracts.Artifact{Package: "@kb-labs/static-config", Version: "1.0.0", Provenance: contracts.ArtifactProvenance{
		SourceRevision: sealed[0].SourceRevision, Integrity: sealed[0].Integrity,
		ContentScope: sealed[0].ContentScope, PackageSHA256: sealed[0].PackageSHA256,
	}}
	if err := os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte("lockfileVersion: '9.0'\npackages:\n  '@kb-labs/static-config@1.0.0':\n    resolution:\n      integrity: "+item.Provenance.Integrity+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyInstalledProvenance(root, []contracts.Artifact{item}); err != nil {
		t.Fatalf("verify unchanged static package: %v", err)
	}
	if err := os.WriteFile(config, []byte(`{"mode":"unsafe"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyInstalledProvenance(root, []contracts.Artifact{item}); err == nil {
		t.Fatal("changed static package file passed provenance verification")
	}
}

func TestVerifyInstalledProvenanceRejectsChangedDist(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte("lockfileVersion: '9.0'\npackages:\n  '@kb-labs/sample@1.0.0':\n    resolution:\n      integrity: sha512-expected\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	packageRoot := filepath.Join(root, "node_modules", "@kb-labs", "sample")
	if err := os.MkdirAll(filepath.Join(packageRoot, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), []byte(`{"name":"@kb-labs/sample","version":"1.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(packageRoot, "dist", "index.js")
	if err := os.WriteFile(file, []byte("source bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	digest, err := DistDigest(filepath.Join(packageRoot, "dist"))
	if err != nil {
		t.Fatal(err)
	}
	item := contracts.Artifact{ID: "sample", Package: "@kb-labs/sample", Version: "1.0.0", Provenance: contracts.ArtifactProvenance{
		SourceRevision: "revision-1", Integrity: "sha512-expected", DistSHA256: digest, ContentScope: contracts.ProvenanceScopeDist,
	}}
	manifest, err := VerifyInstalledProvenance(root, []contracts.Artifact{item})
	if err != nil {
		t.Fatalf("matching package refused: %v", err)
	}
	if len(manifest.Manifest().Packages) != 1 || manifest.Manifest().Packages[0].ContentDigest != digest || manifest.Manifest().Packages[0].Integrity != item.Provenance.Integrity {
		t.Fatalf("verifier evidence = %#v", manifest.Manifest().Packages)
	}
	if err := os.WriteFile(file, []byte("mutated bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	actual, err := DistDigest(filepath.Join(packageRoot, "dist"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = VerifyInstalledProvenance(root, []contracts.Artifact{item})
	if err == nil {
		t.Fatal("changed dist passed provenance verification")
	}
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeProvenanceMismatch ||
		!strings.Contains(failure.Reason, digest) || !strings.Contains(failure.Reason, actual) {
		t.Fatalf("mismatch diagnostic does not identify both digests: %#v, %v", failure, err)
	}
}

func TestVerifyInstalledProvenanceRejectsMissingRecord(t *testing.T) {
	root := t.TempDir()
	_, err := VerifyInstalledProvenance(root, []contracts.Artifact{{Package: "@kb-labs/sample", Version: "1.0.0"}})
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeProvenanceMismatch ||
		failure.Meta["field"] != contracts.ProvenanceDigestField || failure.Meta["actual"] != "<missing in sealed provenance record>" {
		t.Fatalf("missing package provenance was not refused: %#v, %v", failure, err)
	}
}

func TestVerifyInstalledProvenanceMatchesPnpmFileOverrideByPackageVersion(t *testing.T) {
	root := t.TempDir()
	const integrity = "sha512-file-override-integrity"
	lock := "lockfileVersion: '9.0'\npackages:\n  '@kb-labs/sample@file:../../state/cache/packages/archive.tgz':\n    resolution: {integrity: " + integrity + ", tarball: file:../../state/cache/packages/archive.tgz}\n    version: 1.0.0\n"
	if err := os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte(lock), 0o600); err != nil {
		t.Fatal(err)
	}
	packageRoot := filepath.Join(root, "node_modules", "@kb-labs", "sample")
	if err := os.MkdirAll(filepath.Join(packageRoot, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), []byte(`{"name":"@kb-labs/sample","version":"1.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "dist", "index.js"), []byte("sealed bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	digest, err := DistDigest(filepath.Join(packageRoot, "dist"))
	if err != nil {
		t.Fatal(err)
	}
	item := contracts.Artifact{Package: "@kb-labs/sample", Version: "1.0.0", Provenance: contracts.ArtifactProvenance{
		SourceRevision: "test-revision", Integrity: integrity, DistSHA256: digest, ContentScope: contracts.ProvenanceScopeDist,
	}}
	if _, err := VerifyInstalledProvenance(root, []contracts.Artifact{item}); err != nil {
		t.Fatalf("installed package with pnpm file override was refused: %v", err)
	}
}

// case: PC-001.19
func TestVerifyInstalledProvenanceReportsStructuredMismatchFields(t *testing.T) {
	tests := []struct {
		name          string
		field         string
		installedName string
		installedVer  string
		lockIntegrity string
		sealedBytes   string
		actualBytes   string
		expected      string
		actual        string
	}{
		{
			name: "identity", field: "identity",
			installedName: "@kb-labs/other", installedVer: "1.0.0",
			lockIntegrity: "sha512-sealed", sealedBytes: "same dist", actualBytes: "same dist",
			expected: "@kb-labs/sample@1.0.0", actual: "@kb-labs/other@1.0.0",
		},
		{
			name: "integrity", field: "integrity",
			installedName: "@kb-labs/sample", installedVer: "1.0.0",
			lockIntegrity: "sha512-installed", sealedBytes: "same dist", actualBytes: "same dist",
			expected: "sha512-sealed", actual: "sha512-installed",
		},
		{
			name: "digest", field: "digest",
			installedName: "@kb-labs/sample", installedVer: "1.0.0",
			lockIntegrity: "sha512-sealed", sealedBytes: "sealed dist", actualBytes: "installed dist",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			packagePath := filepath.Join("node_modules", "@kb-labs", "sample")
			packageRoot := filepath.Join(root, packagePath)
			dist := filepath.Join(packageRoot, "dist")
			if err := os.MkdirAll(dist, 0o755); err != nil {
				t.Fatal(err)
			}
			manifest, err := json.Marshal(map[string]string{"name": test.installedName, "version": test.installedVer})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), manifest, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dist, "index.js"), []byte(test.actualBytes), 0o644); err != nil {
				t.Fatal(err)
			}
			sealedDist := t.TempDir()
			if err := os.WriteFile(filepath.Join(sealedDist, "index.js"), []byte(test.sealedBytes), 0o644); err != nil {
				t.Fatal(err)
			}
			expectedDigest, err := DistDigest(sealedDist)
			if err != nil {
				t.Fatal(err)
			}
			actualDigest, err := DistDigest(dist)
			if err != nil {
				t.Fatal(err)
			}
			if test.field == "digest" {
				test.expected, test.actual = expectedDigest, actualDigest
			}
			lock := "lockfileVersion: '9.0'\npackages:\n  '@kb-labs/sample@1.0.0':\n    resolution:\n      integrity: " + test.lockIntegrity + "\n"
			if err := os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte(lock), 0o600); err != nil {
				t.Fatal(err)
			}
			item := contracts.Artifact{Package: "@kb-labs/sample", Version: "1.0.0", Provenance: contracts.ArtifactProvenance{
				SourceRevision: "revision-1", Integrity: "sha512-sealed", DistSHA256: expectedDigest, ContentScope: contracts.ProvenanceScopeDist,
			}}
			_, err = VerifyInstalledProvenance(root, []contracts.Artifact{item})
			var failure *diag.Diag
			if !errors.As(err, &failure) {
				t.Fatalf("mismatch error = %v, want structured diagnostic", err)
			}
			for label, value := range map[string]string{
				"field": test.field, "expected": test.expected, "actual": test.actual,
				"package path": packagePath, "digest version": "kb-dist-digest/v1",
			} {
				if !strings.Contains(failure.Message, value) || !strings.Contains(failure.Hint, value) {
					t.Errorf("%s %q missing from message %q or hint %q", label, value, failure.Message, failure.Hint)
				}
			}
			envelope, err := diag.ToEnvelope(failure)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(envelope)
			if err != nil {
				t.Fatal(err)
			}
			var output struct {
				Details map[string]any `json:"details"`
			}
			if err := json.Unmarshal(encoded, &output); err != nil {
				t.Fatal(err)
			}
			for key, value := range map[string]string{
				"field": test.field, "expected": test.expected, "actual": test.actual,
				"packagePath": packagePath, "digestVersion": "kb-dist-digest/v1",
			} {
				if output.Details[key] != value {
					t.Errorf("JSON details[%q] = %q, want %q; full envelope: %s", key, output.Details[key], value, encoded)
				}
			}
		})
	}
}

func TestVerifyInstalledProvenanceReportsAbsentLockIntegrity(t *testing.T) {
	tests := []struct {
		name      string
		lock      string
		missingAt string
	}{
		{
			name:      "package entry is absent",
			lock:      "lockfileVersion: '9.0'\npackages: {}\n",
			missingAt: "pnpm-lock: packages/@kb-labs/sample@1.0.0",
		},
		{
			name:      "resolution integrity is absent",
			lock:      "lockfileVersion: '9.0'\npackages:\n  '@kb-labs/sample@1.0.0':\n    resolution:\n      tarball: https://registry.invalid/sample.tgz\n",
			missingAt: "pnpm-lock: packages/@kb-labs/sample@1.0.0/resolution/integrity",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			packagePath := filepath.Join("node_modules", "@kb-labs", "sample")
			packageRoot := filepath.Join(root, packagePath)
			if err := os.MkdirAll(filepath.Join(packageRoot, "dist"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), []byte(`{"name":"@kb-labs/sample","version":"1.0.0"}`), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte(test.lock), 0o600); err != nil {
				t.Fatal(err)
			}
			item := contracts.Artifact{Package: "@kb-labs/sample", Version: "1.0.0", Provenance: contracts.ArtifactProvenance{
				SourceRevision: "revision-1", Integrity: "sha512-sealed", DistSHA256: strings.Repeat("a", 64), ContentScope: contracts.ProvenanceScopeDist,
			}}
			_, err := VerifyInstalledProvenance(root, []contracts.Artifact{item})
			var failure *diag.Diag
			if !errors.As(err, &failure) || failure.Code != contracts.CodeProvenanceMismatch {
				t.Fatalf("missing lock integrity error = %#v, want catalogued provenance diagnostic: %v", failure, err)
			}
			if failure.Meta["actualPresent"] != false {
				t.Errorf("actualPresent = %#v, want false", failure.Meta["actualPresent"])
			}
			actual := "<missing in " + test.missingAt + ">"
			for label, value := range map[string]string{
				"field": "integrity", "expected": "sha512-sealed", "actual": actual,
				"package path": packagePath, "digest version": DistDigestVersion,
			} {
				if !strings.Contains(failure.Message, value) || !strings.Contains(failure.Hint, value) {
					t.Errorf("%s %q missing from message %q or hint %q", label, value, failure.Message, failure.Hint)
				}
			}
			envelope, err := diag.ToEnvelope(failure)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(envelope)
			if err != nil {
				t.Fatal(err)
			}
			var output struct {
				Details map[string]any `json:"details"`
			}
			if err := json.Unmarshal(encoded, &output); err != nil {
				t.Fatal(err)
			}
			for key, value := range map[string]any{
				"field": "integrity", "expected": "sha512-sealed", "actual": actual,
				"actualPresent": false, "packagePath": packagePath, "digestVersion": DistDigestVersion,
			} {
				if output.Details[key] != value {
					t.Errorf("JSON details[%q] = %#v, want %#v; envelope: %s", key, output.Details[key], value, encoded)
				}
			}
		})
	}
}

func TestVerifyInstalledProvenanceRejectsDistSymlink(t *testing.T) {
	root := t.TempDir()
	packageRoot := filepath.Join(root, "node_modules", "@kb-labs", "sample")
	dist := filepath.Join(packageRoot, "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), []byte(`{"name":"@kb-labs/sample","version":"1.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "target.js"), []byte("same symlink fixture bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target.js", filepath.Join(dist, "index.js")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte("lockfileVersion: '9.0'\npackages:\n  '@kb-labs/sample@1.0.0':\n    resolution:\n      integrity: sha512-expected\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	item := contracts.Artifact{ID: "sample", Package: "@kb-labs/sample", Version: "1.0.0", Provenance: contracts.ArtifactProvenance{
		SourceRevision: "revision-1", Integrity: "sha512-expected", DistSHA256: strings.Repeat("0", 64), ContentScope: contracts.ProvenanceScopeDist,
	}}
	_, err := VerifyInstalledProvenance(root, []contracts.Artifact{item})
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeProvenanceMismatch ||
		failure.Meta["field"] != contracts.ProvenanceDigestField || !strings.Contains(failure.Meta["actual"].(string), "symlink") {
		t.Fatalf("dist symlink was not refused: %#v, %v", failure, err)
	}
}

func TestRestoreRejectsChangedDistBeforeAcceptingRestoredPackages(t *testing.T) {
	root := t.TempDir()
	packageRoot := filepath.Join(root, "node_modules", "@kb-labs", "sample")
	dist := filepath.Join(packageRoot, "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "index.js"), []byte("changed restored bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), []byte(`{"name":"@kb-labs/sample","version":"1.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	wanted := t.TempDir()
	if err := os.MkdirAll(filepath.Join(wanted, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wanted, "dist", "index.js"), []byte("sealed restored bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	expected, err := DistDigest(filepath.Join(wanted, "dist"))
	if err != nil {
		t.Fatal(err)
	}
	item := contracts.Artifact{ID: "sample", Package: "@kb-labs/sample", Version: "1.0.0", Provenance: contracts.ArtifactProvenance{
		SourceRevision: "revision-1", Integrity: "sha512-expected", DistSHA256: expected, ContentScope: contracts.ProvenanceScopeDist,
	}}
	if err := os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte("lockfileVersion: '9.0'\npackages:\n  '@kb-labs/sample@1.0.0':\n    resolution:\n      integrity: sha512-expected\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err = (mustPnpm(t, PnpmConfig{Root: root, Runner: &fakeRunner{}, ReleaseCatalog: testReleaseCatalog(t, item)})).Restore([]contracts.Artifact{item})
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeProvenanceMismatch ||
		!strings.Contains(failure.Reason, expected) {
		t.Fatalf("restore accepted a package whose dist differed from sealed provenance: %#v, %v", failure, err)
	}
}

func TestDistDigestUsedByInstalledVerifier(t *testing.T) {
	installRoot := t.TempDir()
	packageRoot := filepath.Join(installRoot, "node_modules", "@kb-labs", "sample")
	if err := os.MkdirAll(filepath.Join(packageRoot, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), []byte(`{"name":"@kb-labs/sample","version":"1.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "dist", "index.js"), []byte("canonical bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	digest, err := DistDigest(filepath.Join(packageRoot, "dist"))
	if err != nil {
		t.Fatal(err)
	}
	integrity := "sha512-test-fixture-integrity"
	lock := "lockfileVersion: '9.0'\npackages:\n  '@kb-labs/sample@1.0.0':\n    resolution:\n      integrity: " + integrity + "\n"
	if err := os.WriteFile(filepath.Join(installRoot, "pnpm-lock.yaml"), []byte(lock), 0o600); err != nil {
		t.Fatal(err)
	}
	item := contracts.Artifact{Package: "@kb-labs/sample", Version: "1.0.0", Provenance: contracts.ArtifactProvenance{
		SourceRevision: "test-revision", Integrity: integrity, DistSHA256: digest, ContentScope: contracts.ProvenanceScopeDist,
	}}
	verified, err := VerifyInstalledProvenance(installRoot, []contracts.Artifact{item})
	if err != nil {
		t.Fatalf("installed verifier rejected Go-owned digest: %v", err)
	}
	if len(verified.Manifest().Packages) != 1 || verified.Manifest().Packages[0].ContentDigest != digest {
		t.Fatalf("Go owner and verifier digests differ: owner=%s verified=%#v", digest, verified.Manifest().Packages)
	}
}
