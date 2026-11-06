package cmd

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"

	clikitcommand "github.com/kb-labs/clikit/command"
)

func TestPad(t *testing.T) {
	tests := []struct {
		input string
		width int
		want  int
	}{
		{"hello", 10, 10},
		{"hi", 5, 5},
		{"longstring", 3, 10}, // doesn't truncate
	}
	for _, tt := range tests {
		got := Pad(tt.input, tt.width)
		if len(got) < tt.want {
			t.Errorf("Pad(%q, %d) = %q (len %d), want len >= %d", tt.input, tt.width, got, len(got), tt.want)
		}
	}
}

// case: S-278.1, S-278.2, S-278.3
func TestColorPolicyCLIBehavior(t *testing.T) {
	for _, testCase := range generatedColorPolicyCases {
		t.Run(testCase.name, func(t *testing.T) {
			command := colorPolicyHelperCommand(testCase.tty)
			command.Env = colorPolicyEnvironment(testCase.noColor, testCase.forceColorSet, testCase.forceColor, testCase.term)
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("CLI color probe failed: %v: %s", err, output)
			}
			got := strings.Contains(string(output), "\x1b[")
			if got != testCase.want {
				t.Fatalf("CLI output colored = %t, want %t; output=%q", got, testCase.want, output)
			}
		})
	}
}

func TestColorPolicyCLIHelper(t *testing.T) {
	if os.Getenv("KB_COLOR_POLICY_CLI_HELPER") != "1" {
		return
	}
	clikitcommand.SetOutputWriter(os.Stdout)
	newOutput().Err("color-policy-probe")
}

func colorPolicyHelperCommand(tty bool) *exec.Cmd {
	helperArgs := []string{os.Args[0], "-test.run=^TestColorPolicyCLIHelper$"}
	if !tty {
		command := exec.Command(helperArgs[0], helperArgs[1:]...)
		return command
	}
	if runtime.GOOS == "darwin" {
		return exec.Command("script", append([]string{"-q", "/dev/null"}, helperArgs...)...)
	}
	quotedArgs := make([]string, len(helperArgs))
	for index, argument := range helperArgs {
		quotedArgs[index] = shellQuoteColor(argument)
	}
	return exec.Command("script", "-q", "-c", strings.Join(quotedArgs, " "), "/dev/null")
}

func colorPolicyEnvironment(noColor string, forceColorSet bool, forceColor, term string) []string {
	env := make([]string, 0, len(os.Environ())+4)
	for _, item := range os.Environ() {
		if strings.HasPrefix(item, "NO_COLOR=") || strings.HasPrefix(item, "FORCE_COLOR=") || strings.HasPrefix(item, "TERM=") || strings.HasPrefix(item, "KB_COLOR_POLICY_CLI_HELPER=") {
			continue
		}
		env = append(env, item)
	}
	env = append(env, "KB_COLOR_POLICY_CLI_HELPER=1", "NO_COLOR="+noColor, "TERM="+term)
	if forceColorSet {
		env = append(env, "FORCE_COLOR="+forceColor)
	}
	return env
}

func shellQuoteColor(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func TestNewOutput(t *testing.T) {
	// Smoke test — must not panic.
	out := newOutput()
	_ = out.StatusIcon("alive")
	_ = out.StatusIcon("dead")
	_ = out.StatusIcon("failed")
	_ = out.StatusIcon("starting")
	_ = out.StatusIcon("degraded")
	_ = out.StatusIcon("stopping")
	_ = out.StatusIcon("unknown")
	_ = out.StatusColor("alive")
	_ = out.StatusColor("dead")
}
