package contracts

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/kb-labs/clikit/diag"
)

const (
	ResolvedPlanSchema          = "kb.create.resolved-plan/v2"
	ReceiptSchema               = "kb.create.receipt/v3"
	SnapshotSchema              = "kb.create.snapshot/v2"
	CodeArtifactIdentityInvalid = "KB_INSTALL_PLAN_ARTIFACT_IDENTITY_INVALID"
)

type Artifact struct {
	ID            string              `json:"id"`
	Kind          string              `json:"kind"`
	Package       string              `json:"package"`
	Version       string              `json:"version"`
	SHA256        string              `json:"sha256"`
	SizeBytes     int64               `json:"sizeBytes,omitempty"`
	URL           string              `json:"url,omitempty"`
	Tarball       string              `json:"tarball,omitempty"`
	Target        string              `json:"target,omitempty"`
	ResolvedFrom  string              `json:"resolvedFrom"`
	ResolvedURL   string              `json:"resolvedUrl,omitempty"`
	PlatformRange string              `json:"platformRange,omitempty"`
	SDKRange      string              `json:"sdkRange,omitempty"`
	Config        []ConfigRequirement `json:"config,omitempty"`
	// Registry names the discovery kind ("plugin" or "adapter") of an artifact
	// that is installed under another Kind, e.g. a platform member that is also
	// a catalog plugin/adapter. Empty for artifacts that are not registry entities.
	Registry   string             `json:"registry,omitempty"`
	Provenance ArtifactProvenance `json:"provenance"`
}

type ArtifactProvenance struct {
	SourceRevision string `json:"sourceRevision"`
	Integrity      string `json:"integrity"`
	DistSHA256     string `json:"distSha256"`
	ContentScope   string `json:"contentScope"`
	PackageSHA256  string `json:"packageSha256,omitempty"`
}

const (
	ProvenanceScopeDist    = "dist"
	ProvenanceScopePackage = "package"
)

// HasContentDigest accepts only the provenance shape produced by the sealer:
// a compiled package records a dist digest, while a static package records a
// whole-package digest.
func (p ArtifactProvenance) HasContentDigest() bool {
	switch p.ContentScope {
	case ProvenanceScopeDist:
		return p.DistSHA256 != "" && p.PackageSHA256 == ""
	case ProvenanceScopePackage:
		return p.PackageSHA256 != "" && p.DistSHA256 == ""
	default:
		return false
	}
}

// Identity is the single installed-unit identity shared by plan producers and
// consumers. Package artifacts are identified by their package name; binaries
// have no package and are identified by their target and ID.
func (a Artifact) Identity() string {
	if a.Package != "" {
		return a.Package
	}
	return "binary:" + a.ID + ":" + a.Target
}

// DuplicateArtifactIdentity returns the first identity that the artifacts list
// more than once, regardless of the artifact's discovery or installation role.
func DuplicateArtifactIdentity(artifacts []Artifact) (string, bool) {
	seen := make(map[string]struct{}, len(artifacts))
	for _, artifact := range artifacts {
		identity := artifact.Identity()
		if _, exists := seen[identity]; exists {
			return identity, true
		}
		seen[identity] = struct{}{}
	}
	return "", false
}

// ValidateArtifactIdentities rejects plan artifacts that represent one
// installed unit more than once with the catalogued plan diagnostic, and
// requires every artifact to declare an identity.
func ValidateArtifactIdentities(artifacts []Artifact) error {
	for _, artifact := range artifacts {
		compatibilityChecked := artifact.Kind == "plugin" || artifact.Kind == "adapter" ||
			artifact.Registry == "plugin" || artifact.Registry == "adapter"
		if compatibilityChecked && artifact.ID == "" {
			return ArtifactMissingIdentityDiagnostic("the plan contains", artifact)
		}
		if artifact.Package == "" && artifact.ID == "" {
			return ArtifactMissingIdentityDiagnostic("the plan contains", artifact)
		}
	}
	if identity, duplicated := DuplicateArtifactIdentity(artifacts); duplicated {
		return PlanArtifactIdentityFailure(identity)
	}
	return nil
}

// IsBinary reports whether this artifact is an executable rather than an
// installed package with a manifest projection.
func (a Artifact) IsBinary() bool { return a.Kind == "binary" }

// IsFetchBinary rejects kinds outside the release artifact contract.
func (a Artifact) IsFetchBinary() (bool, error) {
	if a.IsBinary() {
		return true, nil
	}
	switch a.Kind {
	case "platform", "platform-member", "sdk", "plugin", "adapter":
		return false, nil
	default:
		return false, fmt.Errorf("unknown artifact kind %q", a.Kind)
	}
}

type Service struct {
	ID          string   `json:"id"`
	Command     string   `json:"command"`
	Port        int      `json:"port,omitempty"`
	HealthCheck string   `json:"healthCheck,omitempty"`
	DependsOn   []string `json:"dependsOn,omitempty"`
	Required    bool     `json:"required"`
}

type ServiceGraph struct {
	PlatformVersion string    `json:"platformVersion"`
	Profile         string    `json:"profile"`
	Services        []Service `json:"services"`
}

type ProviderBinding struct {
	Capability string `json:"capability"`
	AdapterID  string `json:"adapterId"`
	Package    string `json:"package"`
	Version    string `json:"version"`
}

// ResolvedInstallPlan is the only product decision passed to the V2 runtime.
// The runtime converts its artifacts/config/variables to actions; it must not
// re-resolve versions or discover unplanned services.
type ResolvedInstallPlan struct {
	Schema           string            `json:"schema"`
	BinarySource     string            `json:"binarySource,omitempty"`
	Registry         string            `json:"registry,omitempty"`
	Request          InstallRequest    `json:"request"`
	Artifacts        []Artifact        `json:"artifacts"`
	ReleaseCatalog   json.RawMessage   `json:"releaseCatalog"`
	ServiceGraph     ServiceGraph      `json:"serviceGraph"`
	PlatformChannel  string            `json:"platformChannel"`
	ProviderBindings []ProviderBinding `json:"providerBindings,omitempty"`
	// Host is how the launcher runs this platform: one supervised process. The
	// resolver copies it from the platform bundle; a plan without it is invalid.
	Host                *HostSpec     `json:"host,omitempty"`
	ConfigPatches       []ConfigPatch `json:"configPatches,omitempty"`
	PlanHash            string        `json:"planHash"`
	ReleaseDigest       string        `json:"releaseDigest,omitempty"`
	ScenarioStateDigest string        `json:"scenarioStateDigest,omitempty"`
}

// ValidatePlanArtifactIdentities enforces the plan boundary invariant that
// each installable package or binary target appears once, independent of role.
func ValidatePlanArtifactIdentities(plan ResolvedInstallPlan) error {
	return ValidateArtifactIdentities(plan.Artifacts)
}

// PlanArtifactIdentityFailure is the diagnostic for a resolved plan that lists
// identity more than once. It is an internal contract break, not a user error.
func PlanArtifactIdentityFailure(identity string) *diag.Diag {
	return ArtifactIdentityDiagnostic("the resolved plan contains", identity,
		"Use a current sealed release index and kb-create launcher; if the error persists, report the correlationId.")
}

// ArtifactIdentityDiagnostic renders a plan/receipt identity violation with
// the shared catalogued error code and the context-specific next step.
func ArtifactIdentityDiagnostic(subject string, identity string, hint string) *diag.Diag {
	failure := diag.New(CodeArtifactIdentityInvalid,
		subject+" more than one record for artifact "+identity,
		diag.WithMeta(map[string]any{"artifact": identity}))
	failure.Hint = hint
	return failure
}

// ArtifactMissingIdentityDiagnostic renders a plan/receipt identity violation
// when an artifact lacks kind or id.
func ArtifactMissingIdentityDiagnostic(subject string, artifact Artifact) *diag.Diag {
	failure := diag.New(CodeArtifactIdentityInvalid,
		subject+" an artifact with missing identity (kind: "+artifact.Kind+", id: "+artifact.ID+")",
		diag.WithMeta(map[string]any{"kind": artifact.Kind, "id": artifact.ID}))
	failure.Hint = "Use a current sealed release index and kb-create launcher; if the error persists, report the correlationId."
	return failure
}

type ConfigPatch struct {
	Path        string   `json:"path,omitempty"`
	Value       string   `json:"value,omitempty"`
	JSON        string   `json:"json,omitempty"`
	Owner       string   `json:"owner"`
	Environment string   `json:"environment,omitempty"`
	Services    []string `json:"services,omitempty"`
}

// Verification is what the installer checked before committing a receipt: the
// generated config on disk and the host spec the launcher will run.
type Verification struct {
	ConfigSHA256       string    `json:"configSha256"`
	HostHealthURL      string    `json:"hostHealthUrl"`
	ReadinessCheckedAt time.Time `json:"readinessCheckedAt"`
}

// InstallReceipt is written only after the renderer and verifier succeed.
// It is the authoritative input for update, doctor and rollback.
type InstallReceipt struct {
	Schema               string                     `json:"schema"`
	ID                   string                     `json:"id"`
	InstallationID       string                     `json:"installationId"`
	ProjectSelectedPath  string                     `json:"projectSelectedPath,omitempty"`
	ProjectID            string                     `json:"projectId,omitempty"`
	ProjectCanonicalPath string                     `json:"projectCanonicalPath,omitempty"`
	CreatedAt            time.Time                  `json:"createdAt"`
	CorrelationID        string                     `json:"correlationId"`
	Plan                 ResolvedInstallPlan        `json:"plan"`
	Verification         Verification               `json:"verification"`
	MarketplaceInstalls  []MarketplaceInstallRecord `json:"marketplaceInstalls,omitempty"`
	SnapshotID           string                     `json:"snapshotId,omitempty"`
}

type Snapshot struct {
	Schema        string    `json:"schema"`
	ID            string    `json:"id"`
	CreatedAt     time.Time `json:"createdAt"`
	ParentID      string    `json:"parentId,omitempty"`
	ReceiptID     string    `json:"receiptId"`
	ArtifactState string    `json:"artifactState"`
	ConfigState   string    `json:"configState"`
	// Files are managed projections captured before a lifecycle mutation. They
	// are bytes rather than paths so restore never reaches outside platformRoot.
	Files map[string][]byte `json:"files"`
}
