package resolve

import (
	"fmt"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/semrange"
)

type UpdateDisposition uint8

const (
	UpdateRequired UpdateDisposition = iota
	UpdateAlreadyUpToDate
)

// ValidateUpdate checks downgrade and installed extension compatibility before
// an update can create a snapshot, stop the host, or write package/config state.
func ValidateUpdate(active contracts.InstallReceipt, target contracts.ResolvedInstallPlan, source catalog.Catalog) (UpdateDisposition, error) {
	if err := contracts.ValidatePlanArtifactIdentities(active.Plan); err != nil {
		return UpdateRequired, err
	}
	if err := contracts.ValidatePlanArtifactIdentities(target); err != nil {
		return UpdateRequired, err
	}
	installedVersion := active.Plan.ServiceGraph.PlatformVersion
	targetVersion := target.ServiceGraph.PlatformVersion
	comparison, err := semrange.Compare(targetVersion, installedVersion)
	if err != nil {
		return UpdateRequired, contracts.NewDiag(contracts.CodeOperationFailed,
			"the selected platform version could not be compared with the installed version",
			"check the selected release index and rerun `kb-create update`", err)
	}
	if comparison < 0 {
		failure := contracts.NewDiag(contracts.CodeUpdateDowngradeRefused,
			fmt.Sprintf("The requested platform version %s is older than installed version %s.", targetVersion, installedVersion),
			"use `kb-create rollback`", nil)
		failure.Meta = map[string]any{"installed": installedVersion, "target": targetVersion}
		return UpdateRequired, failure
	}
	if comparison == 0 {
		return UpdateAlreadyUpToDate, nil
	}
	targetSDK := sdkVersion(target, source)
	for _, artifact := range active.Plan.Artifacts {
		// Bundled platform members can also be discoverable registry entities.
		// Their exact package versions are owned by the selected platform release;
		// only independently installed plugin/adapter artifacts need separate
		// manifest-range checks here.
		if artifact.Kind != "plugin" && artifact.Kind != "adapter" {
			continue
		}
		kind := artifact.Kind
		compatibilityRange := artifact.PlatformRange
		if compatibilityRange != "" {
			if err := compatible(compatibilityRange, targetVersion, kind, artifact.ID, kind+" "+artifact.ID+" platform", OperationUpdate); err != nil {
				return UpdateRequired, err
			}
		}
		if artifact.SDKRange != "" && targetSDK != "" {
			if err := compatible(artifact.SDKRange, targetSDK, kind, artifact.ID, kind+" "+artifact.ID+" SDK", OperationUpdate); err != nil {
				return UpdateRequired, err
			}
		}
	}
	return UpdateRequired, nil
}

func sdkVersion(target contracts.ResolvedInstallPlan, source catalog.Catalog) string {
	for _, artifact := range target.Artifacts {
		if artifact.Kind == "sdk" {
			return artifact.Version
		}
	}
	if target.Request.SDK.Version != "" {
		return target.Request.SDK.Version
	}
	if target.Request.SDK.Channel != "" {
		return source.Channels[target.Request.SDK.Channel]
	}
	return ""
}
