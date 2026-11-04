package contracts

// PreparedArtifacts owns a sealed artifact set fetched and verified before an
// update snapshot is created. Install must consume those staged bytes without
// resolving the artifacts again. Close releases the staging resources.
type PreparedArtifacts interface {
	Install(progress func(string, bool) error) error
	Close() error
}
