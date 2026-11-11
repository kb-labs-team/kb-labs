//go:build darwin || linux

package main

import (
	"strings"
	"testing"
)

func TestReadGitObjectIDTrimsAndValidatesCommandOutput(t *testing.T) {
	valid := strings.Repeat("a", 40)
	id, err := readGitObjectID(valid + "\n")
	if err != nil {
		t.Fatal(err)
	}
	if id.String() != valid {
		t.Fatalf("object ID=%q want %q", id, valid)
	}

	for _, output := range []string{strings.Repeat("a", 39), strings.Repeat("g", 40), strings.Repeat("a", 40) + "\n" + strings.Repeat("b", 40)} {
		if id, err := readGitObjectID(output); err == nil {
			t.Errorf("readGitObjectID(%q) accepted invalid object ID %q", output, id)
		}
	}
}
