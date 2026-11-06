package artifacts

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/kb-labs/create/v2/contracts"
)

const BinarySourceEnv = "KB_CREATE_DOWNLOAD_BASE_URL"

// NormalizeSourceURL rejects credentials before a source can be persisted.
func NormalizeSourceURL(source string) (string, error) {
	if source == "" {
		return "", nil
	}
	u, err := url.Parse(source)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("source must be an absolute HTTP(S) base URL without credentials, query or fragment")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

// downloadFailure renders a single source-aware diagnostic for every artifact.
func downloadFailure(item contracts.Artifact, target string, cause error) error {
	sourceHint := "--registry or npm_config_registry"
	if item.IsBinary() {
		sourceHint = "--binary-source or " + BinarySourceEnv
	}
	return contracts.NewDiag(contracts.CodeApplyFailed, fmt.Sprintf("download artifact %s from %s failed: %s", item.ID, target, cause.Error()), "Check "+sourceHint+" and retry the invocation.", cause)
}

// fetchArtifact is the single network download and diagnostic boundary for sealed artifacts.
func fetchArtifact(client *http.Client, item contracts.Artifact, target string) ([]byte, error) {
	if client == nil {
		client = http.DefaultClient
	}
	var response *http.Response
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		response, err = client.Get(target)
		if err == nil {
			break
		}
		var networkError net.Error
		if !errors.As(err, &networkError) || !networkError.Timeout() || attempt == 2 {
			return nil, downloadFailure(item, target, err)
		}
		time.Sleep(time.Duration(1<<attempt) * 100 * time.Millisecond)
	}
	data, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil {
		return nil, downloadFailure(item, target, errors.Join(readErr, closeErr))
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, downloadFailure(item, target, fmt.Errorf("HTTP status %d", response.StatusCode))
	}
	return data, nil
}
