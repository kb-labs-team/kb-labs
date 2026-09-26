package contracts

import "time"

const (
	ResolvedPlanSchema = "kb.create.resolved-plan/v2"
	ReceiptSchema      = "kb.create.receipt/v2"
	SnapshotSchema     = "kb.create.snapshot/v2"
)

type Artifact struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Package string `json:"package"`
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
	URL     string `json:"url,omitempty"`
	Tarball string `json:"tarball,omitempty"`
	Target  string `json:"target,omitempty"`
	// Registry names the discovery kind ("plugin" or "adapter") of an artifact
	// that is installed under another Kind, e.g. a platform member that is also
	// a catalog plugin/adapter. Empty for artifacts that are not registry entities.
	Registry string `json:"registry,omitempty"`
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
	Request          InstallRequest    `json:"request"`
	Artifacts        []Artifact        `json:"artifacts"`
	ServiceGraph     ServiceGraph      `json:"serviceGraph"`
	ProviderBindings []ProviderBinding `json:"providerBindings,omitempty"`
	// Host, when declared, makes the launcher supervise the host process
	// directly instead of driving the service graph through kb-dev.
	Host                *HostSpec     `json:"host,omitempty"`
	ConfigPatches       []ConfigPatch `json:"configPatches,omitempty"`
	PlanHash            string        `json:"planHash"`
	ReleaseDigest       string        `json:"releaseDigest,omitempty"`
	ScenarioStateDigest string        `json:"scenarioStateDigest,omitempty"`
}

type ConfigPatch struct {
	Path        string   `json:"path,omitempty"`
	Value       string   `json:"value,omitempty"`
	JSON        string   `json:"json,omitempty"`
	Owner       string   `json:"owner"`
	Environment string   `json:"environment,omitempty"`
	Services    []string `json:"services,omitempty"`
}

type Verification struct {
	ConfigSHA256       string    `json:"configSha256"`
	DevservicesSHA256  string    `json:"devservicesSha256"`
	ServiceStatus      []string  `json:"serviceStatus"`
	ReadinessCheckedAt time.Time `json:"readinessCheckedAt"`
}

// InstallReceipt is written only after the renderer and verifier succeed.
// It is the authoritative input for update, doctor and rollback.
type InstallReceipt struct {
	Schema        string              `json:"schema"`
	ID            string              `json:"id"`
	CreatedAt     time.Time           `json:"createdAt"`
	CorrelationID string              `json:"correlationId"`
	Plan          ResolvedInstallPlan `json:"plan"`
	Verification  Verification        `json:"verification"`
	SnapshotID    string              `json:"snapshotId,omitempty"`
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
