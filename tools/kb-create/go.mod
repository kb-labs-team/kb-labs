module github.com/kb-labs/create

go 1.24.2

toolchain go1.25.13

require (
	github.com/kb-labs/clikit v0.0.0
	golang.org/x/sys v0.30.0
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/charmbracelet/x/term v0.2.1 // indirect
)

// clikit is a workspace-local module (shared launcher diagnostics). Builds rely
// on this replace, not on go.work (which stays non-authoritative).
replace github.com/kb-labs/clikit => ../clikit
