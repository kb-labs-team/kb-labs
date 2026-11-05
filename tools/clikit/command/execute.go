package command

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
	"sync"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

type streamWriterKey struct{}
type argumentsKey struct{}

// Arguments returns the arguments supplied to the current command boundary.
func Arguments(command *cobra.Command) []string {
	if command == nil || command.Context() == nil {
		return nil
	}
	args, _ := command.Context().Value(argumentsKey{}).([]string)
	return append([]string(nil), args...)
}

// FlagValueResetter lets a custom pflag.Value restore its declared default
// without assuming that Set is idempotent or assignment-based.
type FlagValueResetter interface {
	ResetFlagValue(defaultValue string) error
}

type resettableSliceValue struct {
	value    pflag.SliceValue
	firstSet bool
}

func (v *resettableSliceValue) String() string { return v.value.(pflag.Value).String() }
func (v *resettableSliceValue) Type() string   { return v.value.(pflag.Value).Type() }
func (v *resettableSliceValue) Set(value string) error {
	if !v.firstSet {
		if err := v.value.Replace([]string{}); err != nil {
			return err
		}
		v.firstSet = true
	}
	return v.value.(pflag.Value).Set(value)
}
func (v *resettableSliceValue) Append(value string) error { return v.value.Append(value) }
func (v *resettableSliceValue) Replace(values []string) error {
	v.firstSet = true
	return v.value.Replace(values)
}
func (v *resettableSliceValue) GetSlice() []string { return v.value.GetSlice() }
func (v *resettableSliceValue) ResetFlagValue(defaultValue string) error {
	defaults, err := parseSliceDefault(defaultValue)
	if err != nil {
		return err
	}
	if err := v.value.Replace(defaults); err != nil {
		return err
	}
	v.firstSet = false
	return nil
}

type captureBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *captureBuffer) Write(content []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(content)
}

func (b *captureBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

var outputWriter struct {
	sync.RWMutex
	writer io.Writer
}

// SetOutputWriter installs the result boundary's capture writer.
func SetOutputWriter(writer io.Writer) func() {
	outputWriter.Lock()
	previous := outputWriter.writer
	outputWriter.writer = writer
	outputWriter.Unlock()
	return func() {
		outputWriter.Lock()
		outputWriter.writer = previous
		outputWriter.Unlock()
	}
}

// OutputWriter returns the active invocation capture writer.
func OutputWriter() io.Writer {
	outputWriter.RLock()
	writer := outputWriter.writer
	outputWriter.RUnlock()
	if writer == nil {
		return io.Discard
	}
	return writer
}

// Printf records command text for the shared renderer.
func Printf(format string, args ...any) {
	_, _ = fmt.Fprintf(OutputWriter(), format, args...)
}

// Println records command text for the shared renderer.
func Println(args ...any) {
	_, _ = fmt.Fprintln(OutputWriter(), args...)
}

// StreamWriter returns the stdout writer supplied by the top-level dispatcher.
func StreamWriter(command *cobra.Command) io.Writer {
	if command != nil && command.Context() != nil {
		if writer, ok := command.Context().Value(streamWriterKey{}).(io.Writer); ok {
			return writer
		}
	}
	if command == nil {
		return io.Discard
	}
	return command.OutOrStdout()
}

// Execute runs a Cobra tree and renders its outcome exactly once.
func Execute(root *cobra.Command, args []string, stdout, stderr io.Writer) diag.ExitStatus {
	if HandleCobraHelp(root, args, stdout) {
		return diag.SuccessStatus()
	}
	InstallInputBoundary(root)
	_, _, findErr := root.Find(args)
	if status, handled := HandleUnknownCommand(root, args, stdout, stderr, modeForArgs(args), findErr == nil); handled {
		return status
	}
	if err := resetFlags(root); err != nil {
		failure := diag.FromError(err)
		failure.Binary = root.Name()
		return result.RenderDiag(stdout, stderr, failure, modeForArgs(args))
	}
	captured := &captureBuffer{}
	restoreOutput := SetOutputWriter(captured)
	defer restoreOutput()
	root.SetArgs(args)
	root.SetOut(captured)
	root.SetErr(io.Discard)
	root.SilenceUsage = true
	root.SilenceErrors = true
	baseContext := root.Context()
	if baseContext == nil {
		baseContext = context.Background()
	}
	input := root.InOrStdin()
	interaction := &Interaction{in: input, out: stdout, err: stderr, terminal: isTerminalInput(input), machine: modeForArgs(args) != result.ModeHuman}
	baseContext = context.WithValue(baseContext, argumentsKey{}, append([]string(nil), args...))
	baseContext = context.WithValue(baseContext, streamWriterKey{}, stdout)
	root.SetContext(context.WithValue(baseContext, interactionKey{}, interaction))

	_, err := root.ExecuteC()
	mode := modeForArgs(args)
	if exitCode, ok := result.StreamExitCode(err); ok {
		return exitCode
	}
	if data, ok := result.ReturnedData(err); ok {
		human := captured.String()
		if mode == result.ModeHuman && strings.TrimSpace(human) == "" {
			if interaction.hasStreamed() {
				return diag.SuccessStatus()
			}
			encoded, marshalErr := json.MarshalIndent(data, "", "  ")
			if marshalErr != nil {
				failure := diag.FromError(marshalErr)
				failure.Binary = root.Name()
				return result.RenderDiag(stdout, stderr, failure, mode)
			}
			human = string(encoded)
		}
		if failure := result.EmitReturned(err, func() error {
			return result.Render(stdout, result.Success(human, data), mode)
		}); failure != nil {
			failure.Binary = root.Name()
			return result.RenderDiag(stderr, stderr, failure, result.ModeHuman)
		}
		return diag.SuccessStatus()
	}
	if err != nil {
		diagnostic := diag.FromError(err)
		diagnostic.Binary = root.Name()
		if mode == result.ModeHuman {
			if human := captured.String(); human != "" {
				_, _ = io.WriteString(stdout, human)
			}
		}
		return result.RenderDiag(stdout, stderr, diagnostic, mode)
	}
	human := strings.TrimSpace(captured.String())
	var data any
	if human != "" {
		data = human
	}
	result.Render(stdout, result.Success(human, data), mode)
	return diag.SuccessStatus()
}

func modeForArgs(args []string) result.Mode {
	var jsonMode, agentMode bool
	output := ""
	for index, arg := range args {
		switch arg {
		case "--json":
			jsonMode = true
		case "--agent":
			agentMode = true
		case "--output":
			if index+1 < len(args) {
				output = args[index+1]
			}
		default:
			if strings.HasPrefix(arg, "--output=") {
				output = strings.TrimPrefix(arg, "--output=")
			}
		}
	}
	return result.ResolveMode(jsonMode, agentMode, output)
}

func resetFlags(root *cobra.Command) error {
	// Cobra trees are reused as package-level singletons across invocations,
	// so restore defaults before parsing to prevent one call's values leaking into the next.
	var visit func(*cobra.Command)
	var flags []*pflag.Flag
	visit = func(command *cobra.Command) {
		command.Flags().VisitAll(func(flag *pflag.Flag) {
			flags = append(flags, flag)
		})
		command.PersistentFlags().VisitAll(func(flag *pflag.Flag) {
			flags = append(flags, flag)
		})
		for _, child := range command.Commands() {
			visit(child)
		}
	}
	visit(root)
	for _, flag := range flags {
		if err := validateFlagResetContract(flag); err != nil {
			return err
		}
	}
	for _, flag := range flags {
		if err := resetFlag(flag); err != nil {
			return err
		}
	}
	return nil
}

func validateFlagResetContract(flag *pflag.Flag) error {
	if _, ok := flag.Value.(FlagValueResetter); ok {
		return nil
	}
	if _, ok := flag.Value.(pflag.SliceValue); ok {
		return nil
	}
	if isPflagPrimitive(flag.Value) {
		return nil
	}
	return diag.New("KB_RUNTIME_INPUT_INVALID", fmt.Sprintf("Flag --%s uses unsupported value type %q.", flag.Name, flag.Value.Type()),
		diag.WithHint("Implement command.FlagValueResetter on custom flag values used by a reusable command tree."))
}

func resetFlag(flag *pflag.Flag) error {
	if resetter, ok := flag.Value.(FlagValueResetter); ok {
		if err := resetter.ResetFlagValue(flag.DefValue); err != nil {
			return diag.New("KB_RUNTIME_INPUT_INVALID", fmt.Sprintf("Could not reset flag --%s to its declared default.", flag.Name),
				diag.WithHint("Fix its FlagValueResetter implementation, then rerun the command."))
		}
	} else if values, ok := flag.Value.(pflag.SliceValue); ok {
		wrapped := &resettableSliceValue{value: values}
		flag.Value = wrapped
		if err := wrapped.ResetFlagValue(flag.DefValue); err != nil {
			return fmt.Errorf("reset slice flag %q to its default: %w", flag.Name, err)
		}
	} else {
		if err := flag.Value.Set(flag.DefValue); err != nil {
			return fmt.Errorf("reset flag %q to its default: %w", flag.Name, err)
		}
	}
	flag.Changed = false
	return nil
}

func parseSliceDefault(value string) ([]string, error) {
	value = strings.TrimSuffix(strings.TrimPrefix(value, "["), "]")
	if value == "" {
		return []string{}, nil
	}
	reader := csv.NewReader(strings.NewReader(value))
	defaults, err := reader.Read()
	if err != nil {
		return nil, err
	}
	return defaults, nil
}

func isPflagPrimitive(value pflag.Value) bool {
	typeOfValue := reflect.TypeOf(value)
	if typeOfValue == nil || typeOfValue.Kind() != reflect.Ptr || typeOfValue.Elem().PkgPath() != "github.com/spf13/pflag" {
		return false
	}
	switch value.Type() {
	case "bool", "duration", "float32", "float64", "int", "int8", "int16", "int32", "int64",
		"ip", "ipMask", "ipNet", "string", "uint", "uint8", "uint16", "uint32", "uint64":
		return true
	default:
		return false
	}
}
