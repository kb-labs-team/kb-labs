package artifacts

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
	"gopkg.in/yaml.v3"
)

const DistDigestVersion = "kb-dist-digest/v1"
const PackageDigestVersion = "kb-package-digest/v1"

type InstalledPackageProvenance struct {
	Name           string `json:"name"`
	Version        string `json:"version"`
	Integrity      string `json:"integrity"`
	InstalledPath  string `json:"installedPath"`
	SourceRevision string `json:"sourceRevision"`
	ContentDigest  string `json:"contentDigest"`
}

type InstalledProvenanceManifest struct {
	Schema   string                       `json:"schema"`
	Packages []InstalledPackageProvenance `json:"packages"`
}

type PackageManifestInput struct {
	Package string `json:"name"`
	Version string `json:"version"`
	Tarball string `json:"tarball"`
}

type PackageSealedProvenance struct {
	Package        string `json:"package"`
	Version        string `json:"version"`
	SourceRevision string `json:"sourceRevision"`
	Integrity      string `json:"integrity"`
	DistSHA256     string `json:"distSha256"`
	ContentScope   string `json:"contentScope"`
	PackageSHA256  string `json:"packageSha256,omitempty"`
}

type VerifiedArtifactSet struct {
	manifest InstalledProvenanceManifest
}

func (set VerifiedArtifactSet) Manifest() InstalledProvenanceManifest {
	return set.manifest
}

// VerifyInstalledProvenance compares every installed package's identity, lock
// integrity and dist files with sealed provenance, then returns the evidence
// persisted by the installer and copied into journey reports.
func VerifyInstalledProvenance(root string, items []contracts.Artifact) (VerifiedArtifactSet, error) {
	result := InstalledProvenanceManifest{Schema: "kb.create.installed-provenance/v1", Packages: []InstalledPackageProvenance{}}
	lockBytes, lockErr := os.ReadFile(filepath.Join(root, "pnpm-lock.yaml"))
	var lock struct {
		Packages map[string]lockPackage `yaml:"packages"`
	}
	if lockErr == nil {
		lockErr = yaml.Unmarshal(lockBytes, &lock)
	}
	for _, item := range items {
		if item.IsBinary() {
			continue
		}
		packagePath := filepath.ToSlash(filepath.Join("node_modules", filepath.FromSlash(item.Package)))
		if err := ValidatePackageProvenance(item, packagePath); err != nil {
			return VerifiedArtifactSet{}, err
		}
		if lockErr != nil {
			return VerifiedArtifactSet{}, provenanceMismatch(item, packagePath, contracts.ProvenanceIntegrityField,
				item.Provenance.Integrity, contracts.MissingProvenanceValue("pnpm-lock.yaml: "+lockErr.Error()))
		}
		packageRoot := filepath.Join(root, "node_modules", filepath.FromSlash(item.Package))
		manifestBytes, err := os.ReadFile(filepath.Join(packageRoot, "package.json"))
		if err != nil {
			return VerifiedArtifactSet{}, provenanceMismatch(item, packagePath, contracts.ProvenanceIdentityField,
				packageIdentity(item.Package, item.Version), contracts.MissingProvenanceValue(filepath.Join(packagePath, "package.json")))
		}
		var identity struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		}
		if err := json.Unmarshal(manifestBytes, &identity); err != nil {
			return VerifiedArtifactSet{}, provenanceMismatch(item, packagePath, contracts.ProvenanceIdentityField,
				packageIdentity(item.Package, item.Version), contracts.PresentProvenanceValue("invalid package.json: "+err.Error()))
		}
		actualIdentity := packageIdentity(identity.Name, identity.Version)
		expectedIdentity := packageIdentity(item.Package, item.Version)
		if identity.Name != item.Package || identity.Version != item.Version {
			return VerifiedArtifactSet{}, provenanceMismatch(item, packagePath, contracts.ProvenanceIdentityField, expectedIdentity, contracts.PresentProvenanceValue(actualIdentity))
		}
		var actual string
		var digestErr error
		switch item.Provenance.ContentScope {
		case contracts.ProvenanceScopeDist:
			actual, digestErr = PackageDistDigest(filepath.Join(packageRoot, "dist"))
		case contracts.ProvenanceScopePackage:
			actual, digestErr = PackageContentDigest(packageRoot)
		default:
			digestErr = fmt.Errorf("unsupported package content scope %q", item.Provenance.ContentScope)
		}
		if digestErr != nil {
			return VerifiedArtifactSet{}, provenanceMismatch(item, packagePath, contracts.ProvenanceDigestField,
				provenanceContentDigest(item.Provenance), contracts.MissingProvenanceValue("installed package content: "+digestErr.Error()))
		}
		integrity := lockIntegrity(lock.Packages, item.Package, item.Version)
		if !integrity.Present() || integrity.Value() != item.Provenance.Integrity {
			return VerifiedArtifactSet{}, provenanceMismatch(item, packagePath, contracts.ProvenanceIntegrityField, item.Provenance.Integrity, integrity)
		}
		if actual != provenanceContentDigest(item.Provenance) {
			return VerifiedArtifactSet{}, provenanceMismatch(item, packagePath, contracts.ProvenanceDigestField,
				provenanceContentDigest(item.Provenance), contracts.PresentProvenanceValue(actual))
		}
		result.Packages = append(result.Packages, InstalledPackageProvenance{
			Name: item.Package, Version: item.Version, Integrity: integrity.Value(),
			InstalledPath:  filepath.Join("node_modules", filepath.FromSlash(item.Package)),
			SourceRevision: item.Provenance.SourceRevision, ContentDigest: actual,
		})
	}
	sort.Slice(result.Packages, func(i, j int) bool { return result.Packages[i].Name < result.Packages[j].Name })
	return VerifiedArtifactSet{manifest: result}, nil
}

// ValidatePackageProvenance rejects package artifacts without a complete
// sealed identity. It is shared by release resolution and installed-byte
// verification so package provenance cannot enter an accepted artifact set
// without the same field-level diagnostic contract.
func ValidatePackageProvenance(item contracts.Artifact, packagePath string) error {
	if item.IsBinary() {
		return nil
	}
	if item.Package == "" {
		return provenanceMismatch(item, packagePath, contracts.ProvenanceIdentityField,
			"package identity in artifact manifest", contracts.MissingProvenanceValue("artifact manifest: package"))
	}
	provenance := item.Provenance
	if provenance.SourceRevision == "" && provenance.Integrity == "" && !provenance.HasContentDigest() {
		return provenanceMismatch(item, packagePath, contracts.ProvenanceDigestField, "sealed dist digest", contracts.MissingProvenanceValue("sealed provenance record"))
	}
	if provenance.SourceRevision == "" {
		return provenanceMismatch(item, packagePath, contracts.ProvenanceIdentityField, "source revision in sealed provenance", contracts.MissingProvenanceValue("sealed provenance: sourceRevision"))
	}
	if provenance.Integrity == "" {
		return provenanceMismatch(item, packagePath, contracts.ProvenanceIntegrityField, "sealed tarball integrity", contracts.MissingProvenanceValue("sealed provenance: integrity"))
	}
	if !provenance.HasContentDigest() {
		return provenanceMismatch(item, packagePath, contracts.ProvenanceDigestField, "scoped package content digest", contracts.MissingProvenanceValue("sealed provenance: contentScope and matching digest"))
	}
	return nil
}

func provenanceMismatch(item contracts.Artifact, packagePath string, field contracts.ProvenanceField, expected string, actual contracts.ObservedProvenanceValue) error {
	return contracts.ProvenanceMismatch(item.Package, field, expected, actual, packagePath, provenanceDigestVersion(item.Provenance.ContentScope))
}

func provenanceContentDigest(provenance contracts.ArtifactProvenance) string {
	if provenance.ContentScope == contracts.ProvenanceScopePackage {
		return provenance.PackageSHA256
	}
	return provenance.DistSHA256
}

func provenanceDigestVersion(scope string) string {
	if scope == contracts.ProvenanceScopePackage {
		return PackageDigestVersion
	}
	return DistDigestVersion
}

func packageIdentity(name, version string) string {
	if name == "" {
		name = "<missing name>"
	}
	if version == "" {
		version = "<missing version>"
	}
	return name + "@" + version
}

type lockPackage struct {
	Version    string `yaml:"version"`
	Resolution *struct {
		Integrity *string `yaml:"integrity"`
	} `yaml:"resolution"`
}

func lockIntegrity(packages map[string]lockPackage, name, version string) contracts.ObservedProvenanceValue {
	identity := name + "@" + version
	for key, item := range packages {
		registryIdentity := key == identity || strings.HasPrefix(key, identity+"(")
		fileOverrideIdentity := lockFileOverridePackage(key) == name
		if fileOverrideIdentity && item.Version != version {
			return contracts.PresentProvenanceValue("pnpm-lock version " + item.Version)
		}
		if registryIdentity || fileOverrideIdentity {
			if item.Resolution != nil && item.Resolution.Integrity != nil {
				return contracts.PresentProvenanceValue(*item.Resolution.Integrity)
			}
			return contracts.MissingProvenanceValue("pnpm-lock: packages/" + key + "/resolution/integrity")
		}
	}
	return contracts.MissingProvenanceValue("pnpm-lock: packages/" + identity)
}

func lockFileOverridePackage(key string) string {
	packageName, _, fileOverride := strings.Cut(key, "@file:")
	if !fileOverride {
		return ""
	}
	return packageName
}

func WriteInstalledProvenance(root string, manifest InstalledProvenanceManifest) error {
	path := filepath.Join(root, ".kb", "v2", "installed-provenance.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

// DistDigest returns SHA-256 over the canonical `kb-dist-digest/v1` stream.
// Files and symlinks are entries; directories are structural only. Entries
// sort by slash-separated relative path bytes. Each stream record is a type
// byte (1=file, 2=symlink), uint64 big-endian path length, path bytes, one
// executable-mode byte, uint64 big-endian payload length, and payload bytes
// (file contents or the literal symlink target). The stream begins with the
// versioned `kb-dist-digest/v1\x00` domain separator. Other file mode bits do
// not affect package identity.
func DistDigest(root string) (string, error) {
	return canonicalTreeDigest(root, DistDigestVersion)
}

// PackageContentDigest hashes a static package tree when its package manifest
// declares no compiled dist entrypoints.
func PackageContentDigest(root string) (string, error) {
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("static package contains symlink: %s", path)
		}
		return nil
	}); err != nil {
		return "", err
	}
	return canonicalTreeDigest(root, PackageDigestVersion)
}

func canonicalTreeDigest(root, version string) (string, error) {
	entries := make([]distEntry, 0)
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return "", err
	}
	if !rootInfo.IsDir() {
		return "", fmt.Errorf("dist root is not a directory: %s", root)
	}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		payloadPath := filepath.ToSlash(relative)
		if strings.ContainsRune(payloadPath, '\\') {
			return fmt.Errorf("dist path cannot be represented with slash separators: %q", payloadPath)
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			entries = append(entries, distEntry{path: payloadPath, kind: 2, payload: []byte(target)})
		case info.Mode().IsRegular():
			content, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			executable := byte(0)
			if info.Mode().Perm()&0o111 != 0 {
				executable = 1
			}
			entries = append(entries, distEntry{path: payloadPath, kind: 1, mode: executable, payload: content})
		default:
			return fmt.Errorf("dist contains unsupported entry %s", path)
		}
		return nil
	}); err != nil {
		return "", err
	}
	return digestEntries(entries, version)
}

func digestEntries(entries []distEntry, version string) (string, error) {
	sort.Slice(entries, func(i, j int) bool {
		return bytes.Compare([]byte(entries[i].path), []byte(entries[j].path)) < 0
	})
	hash := sha256.New()
	if _, err := io.WriteString(hash, version+"\x00"); err != nil {
		return "", err
	}
	for _, entry := range entries {
		if _, err := hash.Write([]byte{entry.kind}); err != nil {
			return "", err
		}
		if err := writeDigestField(hash, []byte(entry.path)); err != nil {
			return "", err
		}
		if _, err := hash.Write([]byte{entry.mode}); err != nil {
			return "", err
		}
		if err := writeDigestField(hash, entry.payload); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// SealPackageProvenance derives package identity, source revision, archive
// integrity, and the declared content-scope digest from packed package
// tarballs. Release preparation and test fixtures use this same function.
func SealPackageProvenance(packagesDir string, packages []PackageManifestInput, sourceRevision string) ([]PackageSealedProvenance, error) {
	if sourceRevision == "" {
		return nil, fmt.Errorf("source revision is required for package provenance")
	}
	sealed := make([]PackageSealedProvenance, 0, len(packages))
	for _, item := range packages {
		if item.Package == "" || item.Version == "" || item.Tarball == "" {
			return nil, fmt.Errorf("package provenance requires package, version, and tarball for every entry")
		}
		archivePath := filepath.Join(packagesDir, filepath.FromSlash(item.Tarball))
		identity, scope, entries, err := packageTarballContentEntries(archivePath)
		if err != nil {
			return nil, fmt.Errorf("inspect package tarball %s: %w", item.Tarball, err)
		}
		if identity.Name != item.Package || identity.Version != item.Version {
			return nil, fmt.Errorf("package tarball %s contains %s@%s, expected %s@%s", item.Tarball, identity.Name, identity.Version, item.Package, item.Version)
		}
		digestVersion := DistDigestVersion
		if scope == contracts.ProvenanceScopePackage {
			digestVersion = PackageDigestVersion
		}
		contentDigest, err := digestEntries(entries, digestVersion)
		if err != nil {
			return nil, err
		}
		integrity, err := TarballIntegrity(archivePath)
		if err != nil {
			return nil, err
		}
		sealed = append(sealed, PackageSealedProvenance{
			Package: item.Package, Version: item.Version, SourceRevision: sourceRevision,
			Integrity: integrity, ContentScope: scope,
			DistSHA256:    chooseScopeDigest(scope, contentDigest, contracts.ProvenanceScopeDist),
			PackageSHA256: chooseScopeDigest(scope, contentDigest, contracts.ProvenanceScopePackage),
		})
	}
	return sealed, nil
}

// PackageSetContentDigest derives candidate identity from the scoped content
// of packed packages by calling the same tarball inspector as the sealer.
func PackageSetContentDigest(packagesDir string, packages []PackageManifestInput) (string, error) {
	inputs := make([]PackageDigestInput, 0, len(packages))
	for _, item := range packages {
		if item.Package == "" || item.Version == "" || item.Tarball == "" {
			return "", fmt.Errorf("package set digest requires package, version, and tarball for every entry")
		}
		archivePath := filepath.Join(packagesDir, filepath.FromSlash(item.Tarball))
		identity, scope, entries, err := packageTarballContentEntries(archivePath)
		if err != nil {
			return "", fmt.Errorf("inspect package tarball %s: %w", item.Tarball, err)
		}
		if identity.Name != item.Package || identity.Version != item.Version {
			return "", fmt.Errorf("package tarball %s contains %s@%s, expected %s@%s", item.Tarball, identity.Name, identity.Version, item.Package, item.Version)
		}
		digestVersion := DistDigestVersion
		if scope == contracts.ProvenanceScopePackage {
			digestVersion = PackageDigestVersion
		}
		digest, err := digestEntries(entries, digestVersion)
		if err != nil {
			return "", err
		}
		inputs = append(inputs, PackageDigestInput{Package: item.Package, Digest: scope + ":" + digest})
	}
	return PackageSetDigest(inputs)
}

func packageTarballContentEntries(archivePath string) (struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}, string, []distEntry, error) {
	var identity struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	scope := ""
	file, err := os.Open(archivePath)
	if err != nil {
		return identity, scope, nil, err
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return identity, scope, nil, err
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	var distEntries []distEntry
	var packageEntries []distEntry
	var manifestBytes []byte
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return identity, scope, nil, err
		}
		name := strings.TrimPrefix(header.Name, "./")
		clean := path.Clean(name)
		if path.IsAbs(name) || clean == ".." || strings.HasPrefix(clean, "../") {
			return identity, scope, nil, fmt.Errorf("package tarball contains unsafe path %q", header.Name)
		}
		if clean == "package" || !strings.HasPrefix(clean, "package/") {
			continue
		}
		if clean == "package/package.json" {
			manifestBytes, err = io.ReadAll(reader)
			if err != nil {
				return identity, scope, nil, err
			}
			if err := json.Unmarshal(manifestBytes, &identity); err != nil {
				return identity, scope, nil, fmt.Errorf("invalid package.json: %w", err)
			}
			packageEntries = append(packageEntries, distEntry{path: "package.json", kind: 1, payload: manifestBytes})
			continue
		}
		if header.Typeflag == tar.TypeDir {
			continue
		}
		relative := strings.TrimPrefix(clean, "package/")
		if relative == "" || strings.ContainsRune(relative, '\\') {
			return identity, scope, nil, fmt.Errorf("package path cannot be represented with slash separators: %q", header.Name)
		}
		switch header.Typeflag {
		case tar.TypeReg, tar.TypeRegA:
			content, err := io.ReadAll(reader)
			if err != nil {
				return identity, scope, nil, err
			}
			mode := byte(0)
			if header.Mode&0o111 != 0 {
				mode = 1
			}
			entry := distEntry{path: relative, kind: 1, mode: mode, payload: content}
			packageEntries = append(packageEntries, entry)
			if strings.HasPrefix(relative, "dist/") {
				distEntries = append(distEntries, distEntry{path: strings.TrimPrefix(relative, "dist/"), kind: 1, mode: mode, payload: content})
			}
		case tar.TypeSymlink, tar.TypeLink:
			return identity, scope, nil, fmt.Errorf("package tarball contains symlink: %s", relative)
		default:
			return identity, scope, nil, fmt.Errorf("package tarball contains unsupported entry %s", relative)
		}
	}
	if len(manifestBytes) == 0 || identity.Name == "" || identity.Version == "" {
		return identity, scope, nil, fmt.Errorf("package tarball is missing a valid package/package.json")
	}
	if len(distEntries) > 0 {
		scope = contracts.ProvenanceScopeDist
		return identity, scope, distEntries, nil
	}
	if packageManifestDeclaresDist(manifestBytes) {
		return identity, scope, nil, fmt.Errorf("package manifest declares dist entrypoints but package tarball has no files under package/dist")
	}
	scope = contracts.ProvenanceScopePackage
	return identity, scope, packageEntries, nil
}

func packageManifestDeclaresDist(manifest []byte) bool {
	var metadata struct {
		Exports any    `json:"exports"`
		Main    string `json:"main"`
		Module  string `json:"module"`
		Types   string `json:"types"`
		Typings string `json:"typings"`
	}
	if json.Unmarshal(manifest, &metadata) != nil {
		return true
	}
	if exportTargetsDist(metadata.Exports) {
		return true
	}
	for _, target := range []string{metadata.Main, metadata.Module, metadata.Types, metadata.Typings} {
		if strings.HasPrefix(strings.TrimPrefix(target, "./"), "dist/") {
			return true
		}
	}
	return false
}

func exportTargetsDist(value any) bool {
	switch target := value.(type) {
	case string:
		return strings.HasPrefix(strings.TrimPrefix(target, "./"), "dist/")
	case []any:
		for _, entry := range target {
			if exportTargetsDist(entry) {
				return true
			}
		}
	case map[string]any:
		for _, entry := range target {
			if exportTargetsDist(entry) {
				return true
			}
		}
	}
	return false
}

func chooseScopeDigest(scope, digest, selectedScope string) string {
	if scope == selectedScope {
		return digest
	}
	return ""
}

// PackageDistDigest hashes exactly the installed package/dist tree. Only
// regular files beneath dist contribute; directories are structural, only
// executable mode matters, and symlinks and other entry types are refused.
// The tarball sealer selects the same package/dist relative paths and applies
// this encoder, so pnpm metadata, package.json, lockfiles, and node_modules do
// not participate in dist identity. Both sides use the kb-dist-digest/v1
// length-prefixed encoding defined by DistDigest.
func PackageDistDigest(root string) (string, error) {
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("package dist contains symlink: %s", path)
		}
		return nil
	}); err != nil {
		return "", err
	}
	return DistDigest(root)
}

type distEntry struct {
	path    string
	kind    byte
	mode    byte
	payload []byte
}

func writeDigestField(writer io.Writer, value []byte) error {
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(value)))
	if _, err := writer.Write(length[:]); err != nil {
		return err
	}
	_, err := writer.Write(value)
	return err
}

type PackageDigestInput struct {
	Package string `json:"package"`
	Digest  string `json:"digest"`
}

// PackageSetDigest returns the canonical content identity for a sorted set of
// package names and scoped content digests. The caller must provide one digest
// per package; each pair is length-prefixed after the
// `kb-package-set-digest/v1` domain separator.
func PackageSetDigest(packages []PackageDigestInput) (string, error) {
	rows := append([]PackageDigestInput(nil), packages...)
	sort.Slice(rows, func(i, j int) bool { return rows[i].Package < rows[j].Package })
	for index, item := range rows {
		if item.Package == "" || item.Digest == "" {
			return "", fmt.Errorf("package set digest requires package and digest for every entry")
		}
		if index > 0 && rows[index-1].Package == item.Package {
			return "", fmt.Errorf("package set digest contains duplicate package %q", item.Package)
		}
	}
	hash := sha256.New()
	if _, err := io.WriteString(hash, "kb-package-set-digest/v1\x00"); err != nil {
		return "", err
	}
	for _, item := range rows {
		if err := writeDigestField(hash, []byte(item.Package)); err != nil {
			return "", err
		}
		if err := writeDigestField(hash, []byte(item.Digest)); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// TarballIntegrity returns the package-manager SRI representation for a
// packed artifact. It is kept separate from the canonical dist identity.
func TarballIntegrity(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha512.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return "sha512-" + base64.StdEncoding.EncodeToString(hash.Sum(nil)), nil
}

func SHA256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
