//go:build darwin || linux

package main

import (
	"fmt"
	"regexp"
	"strings"
)

var gitObjectIDPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// gitObjectID is a validated full SHA-1 object ID returned by Git.
type gitObjectID string

func (id gitObjectID) String() string { return string(id) }

// readGitObjectID trims Git's line terminator and rejects anything that is
// not exactly one full SHA-1 object ID.
func readGitObjectID(output string) (gitObjectID, error) {
	id := strings.TrimSpace(output)
	if !gitObjectIDPattern.MatchString(id) {
		return "", fmt.Errorf("git returned invalid full SHA-1 object ID %q", output)
	}
	return gitObjectID(id), nil
}

func readGitObjectIDCommand(directory string, args ...string) (gitObjectID, error) {
	output, err := schedulerCommandOutput(directory, "git", args...)
	if err != nil {
		return "", err
	}
	return readGitObjectID(output)
}

func readGitObjectIDMutation(stateIO runnerStateStore, directory string, environment []string, args ...string) (gitObjectID, error) {
	output, err := stateIO.GitMutation(directory, environment, args...)
	if err != nil {
		return "", err
	}
	return readGitObjectID(output)
}

func storedGitObjectID(value string) (gitObjectID, error) {
	return readGitObjectID(value)
}
