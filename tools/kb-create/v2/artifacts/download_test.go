package artifacts

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

type timeoutTransport struct {
	attempts int
	failures int
}

func (t *timeoutTransport) RoundTrip(*http.Request) (*http.Response, error) {
	t.attempts++
	if t.attempts <= t.failures {
		return nil, &timeoutError{}
	}
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("binary")), Header: make(http.Header)}, nil
}

type timeoutError struct{}

func (*timeoutError) Error() string   { return "timeout" }
func (*timeoutError) Timeout() bool   { return true }
func (*timeoutError) Temporary() bool { return true }

// case: S-284.21
func TestDownloadRetriesTimeoutAndBoundsAttempts(t *testing.T) {
	for _, tc := range []struct {
		failures, attempts int
		wantError          bool
	}{{1, 2, false}, {10, 3, true}} {
		transport := &timeoutTransport{failures: tc.failures}
		data, err := fetchArtifact(&http.Client{Transport: transport}, contracts.Artifact{ID: "kb-create", Kind: "binary"}, "https://fixture.invalid/binary")
		if (err != nil) != tc.wantError || transport.attempts != tc.attempts {
			t.Fatalf("failures=%d: attempts=%d error=%v", tc.failures, transport.attempts, err)
		}
		if !tc.wantError && string(data) != "binary" {
			t.Fatalf("data=%q", data)
		}
		if tc.wantError && !errors.As(err, new(*timeoutError)) {
			t.Fatalf("timeout cause lost: %v", err)
		}
	}
}

func TestDownloadFailureNamesReleaseIndexWhenItOwnsTheURL(t *testing.T) {
	item := contracts.Artifact{ID: "platform", ResolvedFrom: "release-index"}
	err := downloadFailure(item, "https://producer.invalid/platform.tgz", errors.New("unreachable"))
	if !strings.Contains(err.Error(), "release index tarball URL") || strings.Contains(err.Error(), "--registry or npm_config_registry") {
		t.Fatalf("diagnostic does not identify URL owner: %v", err)
	}
}
