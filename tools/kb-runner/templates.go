//go:build darwin || linux

package main

import (
	"embed"
	"fmt"
	"io/fs"
	"path"
)

//go:embed templates/*.md
var schedulerTemplates embed.FS

const (
	runnerReviewTemplate   = "review-template.md"
	runnerMergeTemplate    = "merge-template.md"
	runnerDefinitionOfDone = "definition-of-done.md"
)

func readRunnerTemplate(name string) ([]byte, error) {
	if !fs.ValidPath(name) {
		return nil, fmt.Errorf("invalid embedded template name %q", name)
	}
	data, err := schedulerTemplates.ReadFile(path.Join("templates", name))
	if err != nil {
		return nil, fmt.Errorf("read embedded template %q: %w", name, err)
	}
	return data, nil
}
