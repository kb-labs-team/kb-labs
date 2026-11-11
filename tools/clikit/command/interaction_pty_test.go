//go:build !windows

package command

import (
	"fmt"
	"github.com/kb-labs/clikit/internal/testdeadline"
	"io"
	"os"
	"os/exec"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/clikit/internal/testutil"
	"github.com/spf13/cobra"
)

// case: S-050.3
func TestInteractionPromptIsVisibleBeforePTYAnswer(t *testing.T) {
	command := exec.Command("script", ptyScriptArguments(runtime.GOOS, os.Args[0], "-test.run=^TestInteractionPTYChild$")...)
	command.Env = append(os.Environ(), "CLIKIT_INTERACTION_PTY_CHILD=1")
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatalf("start PTY test helper: %v", err)
	}
	readDone := make(chan struct{})
	waited := false
	t.Cleanup(func() {
		_ = input.Close()
		if !waited && command.Process != nil {
			_ = command.Process.Kill()
			_ = testutil.WaitAfterPipeRead(command, readDone)
			waited = true
		}
	})

	bytes := make(chan byte, 256)
	readErrors := make(chan error, 1)
	go func() {
		defer close(readDone)
		for {
			var content [1]byte
			_, readErr := output.Read(content[:])
			if readErr != nil {
				readErrors <- readErr
				return
			}
			bytes <- content[0]
		}
	}()

	var transcript strings.Builder
	timer := time.NewTimer(testdeadline.Budget(t))
	defer timer.Stop()
	for !strings.Contains(transcript.String(), "PTY-CONFIRM> ") {
		select {
		case content := <-bytes:
			transcript.WriteByte(content)
		case readErr := <-readErrors:
			t.Fatalf("PTY closed before prompt: %v; output=%q", readErr, transcript.String())
		case <-timer.C:
			t.Fatalf("prompt did not reach PTY before answer; output=%q", transcript.String())
		}
	}
	if _, err := io.WriteString(input, "y\n"); err != nil {
		t.Fatal(err)
	}
	waitErr := testutil.WaitAfterPipeRead(command, readDone)
	waited = true
	if waitErr != nil {
		t.Fatalf("PTY child failed: %v; output=%q", waitErr, transcript.String())
	}
}

func ptyScriptArguments(goos, executable string, args ...string) []string {
	if goos == "linux" {
		command := shellQuote(executable)
		for _, arg := range args {
			command += " " + shellQuote(arg)
		}
		return []string{"-q", "-c", command, "/dev/null"}
	}
	return append([]string{"-q", "/dev/null", executable}, args...)
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

func TestPTYScriptArgumentFormats(t *testing.T) {
	if got, want := ptyScriptArguments("linux", "/tmp/a b", "-test.run=x"), []string{"-q", "-c", "'/tmp/a b' '-test.run=x'", "/dev/null"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Linux script arguments = %q, want %q", got, want)
	}
	if got, want := ptyScriptArguments("darwin", "/tmp/a b", "-test.run=x"), []string{"-q", "/dev/null", "/tmp/a b", "-test.run=x"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("BSD script arguments = %q, want %q", got, want)
	}
}

func TestInteractionPTYChild(t *testing.T) {
	if os.Getenv("CLIKIT_INTERACTION_PTY_CHILD") != "1" {
		return
	}
	root := &cobra.Command{Use: "root"}
	root.AddCommand(&cobra.Command{Use: "run", RunE: func(command *cobra.Command, _ []string) error {
		_, failure := FromCommand(command).Confirm("PTY-CONFIRM> ", "rerun `kb-create uninstall --yes`")
		if failure != nil {
			return failure
		}
		_, err := fmt.Fprintln(FromCommand(command).ProgressWriter(), "PTY-CONFIRMED")
		return err
	}})
	if code := Execute(root, []string{"run"}, os.Stdout, os.Stderr); code.Code() != 0 {
		t.Fatalf("Execute() = %d", code.Code())
	}
}
