package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/resolve"
	"github.com/kb-labs/create/v2/versionroot"
)

type candidatePackage struct {
	Name     string
	Version  string
	Path     string
	SHA256   string
	SHA1     string
	Manifest map[string]any
}

type packageRegistry struct {
	packages map[string]map[string]candidatePackage
	archives map[string]candidatePackage
}

func main() {
	indexPath := flag.String("index", "", "sealed candidate release index")
	packageDirectory := flag.String("packages", "", "candidate package tarball directory")
	installRoot := flag.String("root", "", "temporary installer root")
	registryURL := flag.String("registry", "", "required shared package registry URL")
	flag.Parse()
	if err := run(*indexPath, *packageDirectory, *installRoot, *registryURL); err != nil {
		command.Exit(diag.ExitCode(diag.FromError(err)))
	}
}

func run(indexPath, packageDirectory, installRoot, sharedRegistryURL string) (runErr error) {
	if indexPath == "" || packageDirectory == "" || installRoot == "" || sharedRegistryURL == "" {
		return errors.New("index, packages, root, and registry are required")
	}
	source, err := catalog.LoadFile(indexPath)
	if err != nil {
		return fmt.Errorf("load candidate release index: %w", err)
	}
	registry, err := readCandidatePackages(packageDirectory)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("start candidate package registry: %w", err)
	}
	server := &http.Server{Handler: registry}
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.Serve(listener) }()
	defer func() {
		closeErr := server.Close()
		serveErr := <-serveErrors
		if closeErr != nil && !errors.Is(closeErr, http.ErrServerClosed) {
			runErr = errors.Join(runErr, fmt.Errorf("close candidate package registry: %w", closeErr))
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			runErr = errors.Join(runErr, fmt.Errorf("serve candidate package registry: %w", serveErr))
		}
	}()
	registryURL := "http://" + listener.Addr().String()

	layout := versionroot.Layout{Root: installRoot}
	stage, err := layout.StageInitial()
	if err != nil {
		return fmt.Errorf("create installer staging root: %w", err)
	}
	if err := os.WriteFile(filepath.Join(stage, ".npmrc"), []byte("@kb-labs:registry="+registryURL+"/\n"), 0o600); err != nil {
		return fmt.Errorf("configure candidate package registry: %w", err)
	}
	plugins := make([]contracts.ComponentRequest, 0, len(source.Plugins))
	for _, plugin := range source.Plugins {
		plugins = append(plugins, contracts.ComponentRequest{
			ID: plugin.ID, Version: contracts.VersionSelector{Version: plugin.Version},
		})
	}
	platformVersion := source.Channels[contracts.ChannelStable]
	sdkVersion := catalog.PlatformSDKVersion(source, platformVersion)
	if sdkVersion == "" {
		if len(source.SDKs) != 1 {
			return fmt.Errorf("candidate has %d SDK artifacts and no platform SDK selection", len(source.SDKs))
		}
		sdkVersion = source.SDKs[0].Version
	}
	plan, err := resolve.PlanWith(contracts.InstallRequest{
		Platform:       contracts.VersionSelector{Version: platformVersion},
		SDK:            contracts.VersionSelector{Version: sdkVersion},
		ServiceProfile: "default",
		Plugins:        plugins,
		Policy:         contracts.PolicyCompatible,
		Source:         contracts.SourceRegistry,
		PlatformRoot:   stage,
	}, source, resolve.Options{OS: "linux", Arch: "amd64"})
	if err != nil {
		return fmt.Errorf("resolve candidate runtime artifacts: %w", err)
	}
	baseURL := registryURL
	for index := range plan.Artifacts {
		item := &plan.Artifacts[index]
		if item.Package == "" || item.Kind == "binary" {
			continue
		}
		if _, ok := registry.packageFor(item.Package, item.Version); !ok {
			return fmt.Errorf("candidate artifact %s@%s has no matching package tarball", item.Package, item.Version)
		}
		item.Tarball = baseURL + "/artifact?package=" + url.QueryEscape(item.Package) + "&version=" + url.QueryEscape(item.Version)
	}
	installer, err := candidatePackageInstaller(layout, stage, sharedRegistryURL)
	if err != nil {
		return fmt.Errorf("resolve candidate package-manager paths: %w", err)
	}
	if err := installer.Install(plan.Artifacts); err != nil {
		return fmt.Errorf("install candidate artifacts with kb-create's package installer: %w", err)
	}
	if err := receipt.Write(stage, contracts.InstallReceipt{ID: "candidate-runtime-import-check", Plan: plan}); err != nil {
		return fmt.Errorf("write candidate install receipt: %w", err)
	}
	fmt.Println(stage)
	return nil
}

func candidatePackageInstaller(layout versionroot.Layout, stage, registryURL string) (artifacts.Pnpm, error) {
	cacheRoot, err := layout.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		return artifacts.Pnpm{}, err
	}
	return artifacts.Pnpm{
		Root:               stage,
		CacheRoot:          cacheRoot,
		PackageManagerRoot: layout.PackageManagerStateDir(),
		Registry:           registryURL,
		Log:                os.Stderr,
	}, nil
}

func readCandidatePackages(directory string) (*packageRegistry, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("read candidate package directory: %w", err)
	}
	result := &packageRegistry{packages: make(map[string]map[string]candidatePackage), archives: make(map[string]candidatePackage)}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".tgz" {
			continue
		}
		packagePath := filepath.Join(directory, entry.Name())
		packageFile, err := readPackageJSON(packagePath)
		if err != nil {
			return nil, fmt.Errorf("read package manifest from %s: %w", entry.Name(), err)
		}
		name, _ := packageFile["name"].(string)
		version, _ := packageFile["version"].(string)
		if name == "" || version == "" {
			return nil, fmt.Errorf("candidate tarball %s has no package name or version", entry.Name())
		}
		archive, err := os.Open(packagePath)
		if err != nil {
			return nil, err
		}
		sha256Hash, sha1Hash := sha256.New(), sha1.New()
		if _, err := io.Copy(io.MultiWriter(sha256Hash, sha1Hash), archive); err != nil {
			archive.Close()
			return nil, fmt.Errorf("hash candidate tarball %s: %w", entry.Name(), err)
		}
		if err := archive.Close(); err != nil {
			return nil, err
		}
		item := candidatePackage{
			Name: name, Version: version, Path: packagePath,
			SHA256: hex.EncodeToString(sha256Hash.Sum(nil)), SHA1: hex.EncodeToString(sha1Hash.Sum(nil)),
			Manifest: packageFile,
		}
		if result.packages[name] == nil {
			result.packages[name] = make(map[string]candidatePackage)
		}
		result.packages[name][version] = item
		result.archives[item.SHA256] = item
	}
	return result, nil
}

func readPackageJSON(path string) (map[string]any, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return nil, err
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if header.Name != "package/package.json" {
			continue
		}
		var manifest map[string]any
		if err := json.NewDecoder(reader).Decode(&manifest); err != nil {
			return nil, err
		}
		return manifest, nil
	}
	return nil, errors.New("tarball has no package/package.json")
}

func (registry *packageRegistry) packageFor(name, version string) (candidatePackage, bool) {
	versions := registry.packages[name]
	item, ok := versions[version]
	return item, ok
}

func (registry *packageRegistry) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	switch {
	case request.URL.Path == "/artifact":
		item, ok := registry.packageFor(request.URL.Query().Get("package"), request.URL.Query().Get("version"))
		if !ok {
			http.NotFound(writer, request)
			return
		}
		http.ServeFile(writer, request, item.Path)
	case strings.HasPrefix(request.URL.Path, "/tarballs/"):
		key := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, "/tarballs/"), ".tgz")
		item, ok := registry.archives[key]
		if !ok {
			http.NotFound(writer, request)
			return
		}
		http.ServeFile(writer, request, item.Path)
	default:
		name, err := url.PathUnescape(strings.TrimPrefix(request.URL.EscapedPath(), "/"))
		if err != nil {
			http.Error(writer, "invalid package name", http.StatusBadRequest)
			return
		}
		versions := registry.packages[name]
		if len(versions) == 0 {
			http.NotFound(writer, request)
			return
		}
		versionNames := make([]string, 0, len(versions))
		for version := range versions {
			versionNames = append(versionNames, version)
		}
		sort.Strings(versionNames)
		versionData := make(map[string]map[string]any, len(versionNames))
		for _, version := range versionNames {
			item := versions[version]
			manifest := make(map[string]any, len(item.Manifest)+1)
			for key, value := range item.Manifest {
				manifest[key] = value
			}
			manifest["dist"] = map[string]any{
				"tarball": requestURL(request, "/tarballs/"+item.SHA256+".tgz"),
				"shasum":  item.SHA1,
			}
			versionData[version] = manifest
		}
		payload := map[string]any{
			"name":      name,
			"dist-tags": map[string]string{"latest": versionNames[len(versionNames)-1]},
			"versions":  versionData,
		}
		writeRegistryJSON(writer, payload)
	}
}

func writeRegistryJSON(writer http.ResponseWriter, payload any) {
	var encoded bytes.Buffer
	if err := json.NewEncoder(&encoded).Encode(payload); err != nil {
		log.Printf("encode candidate package metadata: %v", err)
		http.Error(writer, "unable to encode candidate package metadata", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	if _, err := writer.Write(encoded.Bytes()); err != nil {
		log.Printf("write candidate package metadata response: %v", err)
	}
}

func requestURL(request *http.Request, path string) string {
	return "http://" + request.Host + path
}
