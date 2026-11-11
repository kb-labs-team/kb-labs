// Package gateway tracks installed host roots and their Gateway origins.
package gateway

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/versionroot"
)

const registrySchema = 2

const (
	// AllocatedGatewayPortMin is the first automatically allocated Gateway port.
	AllocatedGatewayPortMin = 4000
	// AllocatedGatewayPortMax is the last automatically allocated Gateway port.
	AllocatedGatewayPortMax = 9900
	// AllocatedGatewayPortStep is the fixed allocation increment.
	AllocatedGatewayPortStep = 100
)

// The lower conventional ephemeral boundary is shared by Linux and macOS;
// derived service ports must remain below it.
const firstEphemeralPort = 32768

type Root struct {
	PlatformRoot   string `json:"platformRoot"`
	InstallationID string `json:"installationId"`
	URL            string `json:"url"`
}

type file struct {
	Schema int    `json:"schema"`
	Roots  []Root `json:"roots"`
}

// Registry is the machine-level index of installed host roots. Each receipt is
// still authoritative; this index lets a fresh root find receipts belonging to
// roots whose paths are otherwise unknown to the launcher.
type Registry struct {
	Path          string
	OperationRoot string
}

// DataDir is the launcher-owned data directory shared by the saved index and registry.
func DataDir(home string) string {
	if data := os.Getenv("XDG_DATA_HOME"); data != "" {
		return filepath.Join(data, "kb-create")
	}
	return filepath.Join(home, ".local", "share", "kb-create")
}

func (r Registry) resolved() (Registry, error) {
	if r.Path != "" {
		return r, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return r, fmt.Errorf("resolve launcher data directory: %w", err)
	}
	r.Path = RegistryPath(home)
	return r, nil
}

func RegistryPath(home string) string { return filepath.Join(DataDir(home), "gateway-roots.json") }

// Mutation identifies a user-invoked operation permitted to change the registry.
type Mutation uint8

const (
	Apply Mutation = iota + 1
	Install
	Update
	Rollback
	DoctorFix
	Uninstall
)

// Writer exposes registry changes only with an explicit mutation capability.
type Writer struct {
	Registry
	mutation Mutation
}

func (r Registry) Writer(mutation Mutation) Writer { return Writer{Registry: r, mutation: mutation} }

func (w Writer) authorize() error {
	if w.mutation < Apply || w.mutation > Uninstall {
		return fmt.Errorf("invalid Gateway registry mutation")
	}
	return nil
}

func (r Registry) Read() ([]Root, error) {
	roots, err := r.readFile()
	if err != nil {
		return nil, err
	}
	return r.removeMissingRoots(roots)
}

func (r Registry) readFile() ([]Root, error) {
	r, err := r.resolved()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(r.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, r.unavailable(err)
	}
	var value file
	if err := json.Unmarshal(data, &value); err != nil || value.Schema != registrySchema || value.Roots == nil {
		if err == nil {
			err = fmt.Errorf("unsupported schema %d (this launcher requires schema %d)", value.Schema, registrySchema)
		}
		return nil, r.unavailable(err)
	}
	for index, root := range value.Roots {
		if !filepath.IsAbs(root.PlatformRoot) || !validOrigin(root.URL) || !validInstallationID(root.InstallationID) {
			return nil, r.unavailable(fmt.Errorf("root %d has an invalid platform root, installation identity, or Gateway origin", index))
		}
		for _, previous := range value.Roots[:index] {
			if previous.InstallationID == root.InstallationID {
				return nil, r.unavailable(fmt.Errorf("duplicate installation identity for root %s", root.PlatformRoot))
			}
		}
	}
	return value.Roots, nil
}

func (r Registry) unavailable(reason error) error {
	return r.Unavailable(reason.Error(), reason, "", "")
}

// Unavailable constructs the canonical diagnostic for an unusable Gateway index.
// Callers may provide a more specific message and hint when the failure is
// discovered through another lifecycle operation.
func (r Registry) Unavailable(reason string, cause error, message, hint string) *diag.Diag {
	root := r.OperationRoot
	if root == "" {
		root = "<affected-platform-root>"
	}
	remove := contracts.ShellCommand("rm", "--", r.Path)
	repair := contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", root)
	if message == "" {
		message = fmt.Sprintf("The Gateway address index at %s cannot be used: %s.", r.Path, reason)
	}
	if hint == "" {
		hint = fmt.Sprintf("Remove the derived index with `%s`, then run `%s` to rebuild it from the installation receipt.", remove, repair)
	}
	failure := contracts.NewDiag(contracts.CodeGatewayIndexUnavailable, message, hint, cause)
	failure.Meta = map[string]any{
		"path":          r.Path,
		"reason":        reason,
		"removeCommand": remove,
		"repairCommand": repair,
	}
	return failure
}

func OriginFromHealthURL(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || !validOriginParts(parsed) {
		return "", fmt.Errorf("Gateway health URL %q has no valid loopback origin", value)
	}
	parsed.Path, parsed.RawPath, parsed.RawQuery, parsed.Fragment = "", "", "", ""
	return parsed.String(), nil
}

// Allocate keeps a root's registered address, honors an explicit URL, and
// otherwise advances in 100-port offsets until no installed root claims it.
func (r Registry) Allocate(platformRoot, defaultURL, explicitURL string, graph contracts.ServiceGraph) (string, error) {
	return r.AllocateWithKnown(platformRoot, defaultURL, explicitURL, nil, graph)
}

func (r Registry) AllocateWithKnown(platformRoot, defaultURL, explicitURL string, known []Root, graph contracts.ServiceGraph) (string, error) {
	if explicitURL != "" {
		return explicitURL, nil
	}
	r.OperationRoot = platformRoot
	roots, err := r.Read()
	if err != nil {
		return "", err
	}
	installationID, err := allocationInstallationID(platformRoot)
	if err != nil {
		return "", err
	}
	roots = append(roots, known...)
	claimed := make(map[string]struct{}, len(roots))
	for _, root := range roots {
		if !validInstallationID(root.InstallationID) || !validOrigin(root.URL) {
			return "", fmt.Errorf("known Gateway root %s has no validated installation identity or origin", root.PlatformRoot)
		}
		if root.InstallationID == installationID {
			return root.URL, nil
		}
		claimed[root.URL] = struct{}{}
	}
	parsed, err := url.Parse(defaultURL)
	if err != nil || !validOrigin(defaultURL) {
		return "", fmt.Errorf("release Gateway origin %q is invalid", defaultURL)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		return "", fmt.Errorf("release Gateway origin %q has no valid port", defaultURL)
	}
	baseGatewayPort := 0
	for _, service := range graph.Services {
		if service.ID == "gateway" {
			baseGatewayPort = service.Port
			break
		}
	}
	if baseGatewayPort < 1 {
		return "", fmt.Errorf("service graph has no valid Gateway port for allocation")
	}
	if !inAllocatedGatewayDomain(port) || !derivedServicePortsAreAllocatable(port, baseGatewayPort, graph.Services) {
		port = AllocatedGatewayPortMin
	}
	for ; port <= AllocatedGatewayPortMax; port += AllocatedGatewayPortStep {
		if !derivedServicePortsAreAllocatable(port, baseGatewayPort, graph.Services) {
			continue
		}
		candidate := *parsed
		candidate.Host = strings.TrimSuffix(parsed.Host, ":"+parsed.Port()) + ":" + strconv.Itoa(port)
		origin := candidate.String()
		if _, exists := claimed[origin]; !exists {
			return origin, nil
		}
	}
	return "", fmt.Errorf("no Gateway port remains in the allocated port domain after release port %s", parsed.Port())
}

func inAllocatedGatewayDomain(port int) bool {
	return port >= AllocatedGatewayPortMin && port <= AllocatedGatewayPortMax &&
		(port-AllocatedGatewayPortMin)%AllocatedGatewayPortStep == 0
}

func derivedServicePortsAreAllocatable(gatewayPort, baseGatewayPort int, services []contracts.Service) bool {
	for _, service := range services {
		if service.Port == 0 {
			continue
		}
		port := gatewayPort + service.Port - baseGatewayPort
		if port < 1 || port > 65535 || port >= firstEphemeralPort {
			return false
		}
	}
	return true
}

func (r Registry) Claimant(platformRoot, gatewayURL string) (Root, bool, error) {
	return r.ClaimantAmong(platformRoot, gatewayURL, nil)
}

func (r Registry) ClaimantAmong(platformRoot, gatewayURL string, known []Root) (Root, bool, error) {
	r.OperationRoot = platformRoot
	roots, err := r.Read()
	if err != nil {
		return Root{}, false, err
	}
	installationID, err := allocationInstallationID(platformRoot)
	if err != nil {
		return Root{}, false, err
	}
	for _, root := range append(roots, known...) {
		if !validInstallationID(root.InstallationID) || !validOrigin(root.URL) {
			return Root{}, false, fmt.Errorf("known Gateway root %s has no validated installation identity or origin", root.PlatformRoot)
		}
		if root.InstallationID != installationID && root.URL == gatewayURL {
			return root, true, nil
		}
	}
	return Root{}, false, nil
}

// removeMissingRoots filters allocations whose active receipt is absent without
// mutating the index during planning.
func (r Registry) removeMissingRoots(roots []Root) ([]Root, error) {
	kept := make([]Root, 0, len(roots))
	for _, root := range roots {
		layout, err := versionroot.ForPlatformPath(root.PlatformRoot)
		if err != nil {
			return nil, err
		}
		active, err := layout.ExistingPlatformRoot()
		if errors.Is(err, versionroot.ErrPlatformNotInstalled) || errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(receipt.Path(active)); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return nil, err
		}
		kept = append(kept, root)
	}
	return kept, nil
}

func (r Writer) RegisterMany(values []Root) error {
	if err := r.authorize(); err != nil {
		return err
	}
	if r.OperationRoot == "" && len(values) > 0 {
		r.OperationRoot = values[0].PlatformRoot
	}
	roots, err := r.Read()
	if err != nil {
		return err
	}
	byRoot := append([]Root(nil), roots...)
	for _, root := range values {
		if !filepath.IsAbs(root.PlatformRoot) || !validOrigin(root.URL) {
			return fmt.Errorf("platform root and Gateway URL must be absolute and valid")
		}
		canonicalRoot, installationID, err := validatedPlatformIdentity(root.PlatformRoot)
		if err != nil {
			return err
		}
		root.PlatformRoot = canonicalRoot
		root.InstallationID = installationID
		replaced := false
		for index := range byRoot {
			if byRoot[index].InstallationID == root.InstallationID {
				byRoot[index] = root
				replaced = true
				break
			}
		}
		if !replaced {
			byRoot = append(byRoot, root)
		}
	}
	return r.write(byRoot)
}

func (r Writer) Register(platformRoot, gatewayURL string) error {
	if err := r.authorize(); err != nil {
		return err
	}
	r.OperationRoot = platformRoot
	if !filepath.IsAbs(platformRoot) || !validOrigin(gatewayURL) {
		return fmt.Errorf("platform root and Gateway URL must be absolute and valid")
	}
	canonicalRoot, installationID, err := validatedPlatformIdentity(platformRoot)
	if err != nil {
		return err
	}
	roots, err := r.Read()
	if err != nil {
		return err
	}
	updated := false
	for index := range roots {
		if roots[index].InstallationID == installationID {
			roots[index].PlatformRoot = canonicalRoot
			roots[index].URL = gatewayURL
			updated = true
			break
		}
	}
	if !updated {
		roots = append(roots, Root{PlatformRoot: canonicalRoot, InstallationID: installationID, URL: gatewayURL})
	}
	return r.write(roots)
}

// RegisterForTransaction publishes a root registration only for the duration of
// a caller-owned commit. If the commit fails, the exact prior registry bytes (or
// prior absence) are restored before the error is returned.
func (r Writer) RegisterForTransaction(platformRoot, gatewayURL string, commit func() error) error {
	if err := r.authorize(); err != nil {
		return err
	}
	if commit == nil {
		return fmt.Errorf("Gateway registration transaction requires a commit operation")
	}
	resolved, err := r.Registry.resolved()
	if err != nil {
		return err
	}
	r.Registry = resolved
	previous, err := os.ReadFile(r.Path)
	previousExists := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return r.unavailable(err)
	}
	if err := r.Register(platformRoot, gatewayURL); err != nil {
		return err
	}
	if err := commit(); err != nil {
		if restoreErr := r.restoreBytes(previous, previousExists); restoreErr != nil {
			return errors.Join(err, fmt.Errorf("restore Gateway registry after failed update commit: %w", restoreErr))
		}
		return err
	}
	return nil
}

func (r Registry) restoreBytes(data []byte, existed bool) error {
	if !existed {
		if err := os.Remove(r.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(r.Path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(r.Path), ".gateway-roots-restore-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, r.Path)
}

func (r Writer) Remove(platformRoot string) error {
	if err := r.authorize(); err != nil {
		return err
	}
	r.OperationRoot = platformRoot
	installationID, err := validatedInstallationID(platformRoot)
	if err != nil {
		return err
	}
	return r.RemoveInstallation(installationID)
}

// RemoveInstallation releases the Gateway row for an identity captured while
// its installation was still validated, including after uninstall removed it.
func (r Writer) RemoveInstallation(installationID string) error {
	if err := r.authorize(); err != nil {
		return err
	}
	if !validInstallationID(installationID) {
		return fmt.Errorf("installation identity is invalid")
	}
	roots, err := r.Read()
	if err != nil {
		return err
	}
	filtered := roots[:0]
	for _, entry := range roots {
		if entry.InstallationID != installationID {
			filtered = append(filtered, entry)
		}
	}
	return r.write(filtered)
}

// SameInstallation reports whether two validated platform paths belong to the
// same installation identity.
func SameInstallation(left, right string) bool {
	leftID, err := validatedInstallationID(left)
	if err != nil {
		return false
	}
	rightID, err := validatedInstallationID(right)
	return err == nil && leftID == rightID
}

func validatedInstallationID(platformRoot string) (string, error) {
	_, installationID, err := validatedPlatformIdentity(platformRoot)
	return installationID, err
}

// A path with no installed layout is a new allocation request, not an
// installation identity. It may allocate around existing rows, but cannot
// claim that any row belongs to it until the installation validates.
func allocationInstallationID(platformRoot string) (string, error) {
	layout, err := versionroot.ForPlatformPath(platformRoot)
	if err != nil {
		return "", err
	}
	activeRoot, err := layout.ExistingPlatformRoot()
	if errors.Is(err, versionroot.ErrPlatformNotInstalled) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return validatedInstallationID(activeRoot)
}

func validatedPlatformIdentity(platformRoot string) (string, string, error) {
	layout, err := versionroot.ForPlatformPath(platformRoot)
	if err != nil {
		return "", "", err
	}
	if err := layout.Validate(); err != nil {
		return "", "", err
	}
	installationID, err := versionroot.InstallationIDForPath(platformRoot)
	if err != nil {
		return "", "", err
	}
	return filepath.Clean(layout.PlatformRoot()), installationID, nil
}

func validInstallationID(value string) bool {
	if len(value) != 32 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func (r Registry) write(roots []Root) error {
	var err error
	r, err = r.resolved()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.Path), 0o700); err != nil {
		return fmt.Errorf("create installed Gateway root index directory: %w", err)
	}
	sort.Slice(roots, func(i, j int) bool { return roots[i].PlatformRoot < roots[j].PlatformRoot })
	if roots == nil {
		roots = []Root{}
	}
	data, err := json.MarshalIndent(file{Schema: registrySchema, Roots: roots}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temp, err := os.CreateTemp(filepath.Dir(r.Path), ".gateway-roots-*.tmp")
	if err != nil {
		return fmt.Errorf("stage installed Gateway root index: %w", err)
	}
	name := temp.Name()
	defer os.Remove(name)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("protect installed Gateway root index: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write installed Gateway root index: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("sync installed Gateway root index: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close installed Gateway root index: %w", err)
	}
	if err := os.Rename(name, r.Path); err != nil {
		return fmt.Errorf("commit installed Gateway root index: %w", err)
	}
	return nil
}

func validOrigin(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && validOriginParts(parsed) && parsed.Path == "" && parsed.RawQuery == "" && parsed.Fragment == ""
}

func validOriginParts(parsed *url.URL) bool {
	return parsed != nil && parsed.Scheme == "http" && parsed.User == nil && parsed.Hostname() == "127.0.0.1" && parsed.Port() != ""
}
