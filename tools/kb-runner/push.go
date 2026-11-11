//go:build darwin || linux

package main

import (
	"fmt"
)

type verificationPushKind uint8

const (
	verificationPushWorker verificationPushKind = iota + 1
	verificationPushCandidate
	verificationPushBisect
)

type verificationPush struct {
	kind   verificationPushKind
	stream string
	sha    string
}

func (push verificationPush) ref() (string, string, error) {
	if push.kind < verificationPushWorker || push.kind > verificationPushBisect {
		return "", "", fmt.Errorf("unsupported verification push kind %d", push.kind)
	}
	if err := validateSchedulerKey(push.stream, "verification stream"); err != nil {
		return "", "", err
	}
	objectID, err := storedGitObjectID(push.sha)
	if err != nil {
		return "", "", fmt.Errorf("verification push requires a full commit SHA, got %q: %w", push.sha, err)
	}
	name := push.stream
	if push.kind == verificationPushCandidate {
		name = "candidate-" + name
	} else if push.kind == verificationPushBisect {
		name = "bisect-" + name
	}
	branch := "verify/" + name + "-" + objectID.String()[:7]
	return branch, objectID.String() + ":refs/heads/" + branch, nil
}

func pushVerificationCommit(repoRoot string, push verificationPush) (string, error) {
	branch, refspec, err := push.ref()
	if err != nil {
		return "", err
	}
	if _, err := schedulerCommandOutput(repoRoot, "git", "check-ref-format", "refs/heads/"+branch); err != nil {
		return "", fmt.Errorf("verification ref is invalid: %w", err)
	}
	if _, err := schedulerCommandOutput(repoRoot, "git", "-C", repoRoot, "push", "backup", refspec); err != nil {
		return "", fmt.Errorf("push verification ref %s: %w", branch, err)
	}
	return branch, nil
}
