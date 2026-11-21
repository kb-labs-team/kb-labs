package contracts

type UpdateSummary struct {
	Components      []UpdateComponent    `json:"components"`
	AddedPackages   []string             `json:"addedPackages"`
	RemovedPackages []string             `json:"removedPackages"`
	DownloadBytes   int64                `json:"downloadBytes"`
	ReleaseNotes    []UpdateReleaseNotes `json:"releaseNotes"`
}

type PendingRestart struct {
	Services            []PendingRestartService `json:"services"`
	InstalledVersion    string                  `json:"installedVersion"`
	InstalledGeneration string                  `json:"installedGeneration,omitempty"`
	RunningGeneration   string                  `json:"runningGeneration,omitempty"`
	Command             string                  `json:"command"`
}

type PendingRestartService struct {
	ID             string `json:"id"`
	RunningVersion string `json:"runningVersion"`
}

type UpdateComponent struct {
	ID          string `json:"id"`
	Package     string `json:"package"`
	FromVersion string `json:"fromVersion"`
	ToVersion   string `json:"toVersion"`
}

type UpdateReleaseNotes struct {
	Version string `json:"version"`
	Notes   string `json:"notes"`
}
