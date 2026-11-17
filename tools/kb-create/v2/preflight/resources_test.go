package preflight

import (
	"encoding/json"
	"fmt"
	"github.com/kb-labs/clikit/diag"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

func TestValidateResourcesReportsAvailableMemoryAndMinimum(t *testing.T) {
	available := MinimumAvailableMemory - 8*(1<<20)
	err := validateResources(available, MinimumFreeDisk)
	failure, ok := err.(*diag.Diag)
	if !ok || failure.Code != contracts.CodeMemoryInsufficient ||
		failure.Meta["minimum"] != "1228.80 MiB (1288490188 bytes)" || failure.Meta["available"] != "1220.80 MiB (1280101580 bytes)" ||
		failure.Meta["minimumBytes"] != "1288490188" || failure.Meta["availableBytes"] != "1280101580" {
		t.Fatalf("error = %#v", err)
	}
	if failure.Message == "" || !strings.Contains(failure.Message, "1228.80 MiB (1288490188 bytes)") || !strings.Contains(failure.Message, "1220.80 MiB (1280101580 bytes)") ||
		!strings.Contains(failure.Hint, "Close memory-heavy applications") || !strings.Contains(failure.Hint, "kb-create install") {
		t.Fatalf("message/hint = %q / %q", failure.Message, failure.Hint)
	}
}

// case: S-052.1
func TestValidateResourcesSerializesExactMemoryDetailsInPublicEnvelope(t *testing.T) {
	err := validateResources(MinimumAvailableMemory-8*(1<<20), MinimumFreeDisk)
	failure, ok := err.(*diag.Diag)
	if !ok {
		t.Fatalf("error = %#v", err)
	}
	envelope, err := diag.ToEnvelope(failure)
	if err != nil {
		t.Fatalf("serialize memory diagnostic: %v", err)
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal memory envelope: %v", err)
	}
	var got struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Hint    string         `json:"hint"`
		Details map[string]any `json:"details"`
	}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("decode public envelope: %v", err)
	}
	if got.Code != contracts.CodeMemoryInsufficient ||
		got.Details["availableBytes"] != "1280101580" || got.Details["minimumBytes"] != "1288490188" ||
		!strings.Contains(got.Message, "1220.80 MiB") || !strings.Contains(got.Message, "1228.80 MiB") ||
		!strings.Contains(got.Hint, "Close memory-heavy applications") || !strings.Contains(got.Hint, "kb-create install") {
		t.Fatalf("serialized public envelope = %s", encoded)
	}
}

func TestValidateResourcesComparesAvailableMemoryAtBytePrecision(t *testing.T) {
	err := validateResources(MinimumAvailableMemory-1, MinimumFreeDisk)
	failure, ok := err.(*diag.Diag)
	if !ok || failure.Code != contracts.CodeMemoryInsufficient || failure.Meta["availableBytes"] != "1288490187" {
		t.Fatalf("error = %#v", err)
	}
}

func TestValidateResourcesReportsFreeDiskAndMinimum(t *testing.T) {
	err := validateResources(MinimumAvailableMemory, MinimumFreeDisk-1)
	failure, ok := err.(*diag.Diag)
	if !ok || failure.Code != "KB_INSTALL_NO_DISK_SPACE" || failure.Meta["minimum"] != "2.00 GiB" {
		t.Fatalf("error = %#v", err)
	}
}

func TestValidateResourcesAcceptsInstallBudget(t *testing.T) {
	if err := validateResources(MinimumAvailableMemory, MinimumFreeDisk); err != nil {
		t.Fatalf("error = %v", err)
	}
}

func TestDarwinAvailableMemoryUsesReportedPageSize(t *testing.T) {
	for _, pageSize := range []uint64{4096, 16384} {
		t.Run(fmt.Sprintf("%d-byte-pages", pageSize), func(t *testing.T) {
			output := fmt.Sprintf("Mach Virtual Memory Statistics: (page size of %d bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 3.\nPages purgeable: 2.\nPages wired down: 40.\n", pageSize)
			got, err := darwinAvailableMemory(output)
			want := 35 * pageSize
			if err != nil || got != want {
				t.Fatalf("available memory = %d, %v; want %d", got, err, want)
			}
		})
	}
}
