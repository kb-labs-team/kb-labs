package v2cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
	"github.com/kb-labs/clikit/stream"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/shim"
	"github.com/spf13/cobra"
)

type operationDescriptor struct {
	Name       string
	Short      string
	Hidden     bool
	JSONStream bool
	Args       cobra.PositionalArgs
	Flags      []string
	Human      func(any) string
	Handler    func(context.Context, *cobra.Command, *commandFlagReader, commandDependencies) (any, *diag.Diag)
}

type versionCommandInput struct{}
type streamCompletion struct{ ExitStatus diag.ExitStatus }

var operationDescriptors = []operationDescriptor{
	{Name: "install", JSONStream: true, Short: "Install KB Labs interactively", Args: cobra.NoArgs, Flags: []string{"index", "input", "platform-root", "project-root", "platform-version", "platform-channel", "gateway-url", "sdk-version", "service-profile", "plugins", "adapters", "provider", "policy", "offline", "secret-env", "registry", "binary-source", "marketplace-registry-url", "marketplace-registry-public-key-env", "marketplace-registry-token-env", "marketplace-npm-url", "scenario", "scenario-answers", "resume", "telemetry-endpoint", "telemetry-consent"}, Human: renderInstall, Handler: func(ctx context.Context, cmd *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		deps.Command = cmd
		input := installCommandInput{Index: flags.String("index"), RequestFile: flags.String("input"), Direct: readDirectRequest(flags), ScenarioID: flags.String("scenario"), Answers: flags.String("scenario-answers"), Resume: flags.Bool("resume"), SecretEnv: flags.String("secret-env"), Executable: deps.Executable, TelemetryEndpoint: flags.String("telemetry-endpoint"), TelemetryConsent: flags.Bool("telemetry-consent"), Arguments: command.Arguments(cmd)}
		if jsonMode(cmd) {
			return executeInstallStream(ctx, input, deps)
		}
		return executeInstall(ctx, input, deps)
	}},
	{Name: "plan", Short: "Resolve an install request", Args: cobra.NoArgs, Flags: []string{"index", "input", "platform-root", "project-root", "platform-version", "platform-channel", "gateway-url", "sdk-version", "service-profile", "plugins", "adapters", "provider", "policy", "offline", "registry", "binary-source", "marketplace-registry-url", "marketplace-registry-public-key-env", "marketplace-registry-token-env", "marketplace-npm-url", "scenario", "scenario-answers", "resume", "telemetry-endpoint", "telemetry-consent"}, Human: renderPlan, Handler: func(ctx context.Context, cmd *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		invocation, err := flags.Invocation()
		if err != nil {
			return nil, contracts.NewDiag(contracts.CodeOperationFailed, "the plan invocation could not be reconstructed", "rerun the command with its original flags", err)
		}
		input := planCommandInput{Index: flags.String("index"), RequestFile: flags.String("input"), RetryCommand: invocation, Direct: readDirectRequest(flags), ScenarioID: flags.String("scenario"), Answers: flags.String("scenario-answers"), Resume: flags.Bool("resume"), Executable: deps.Executable, KnownGateways: knownGatewayRoots(deps.Executable), TelemetryEndpoint: flags.String("telemetry-endpoint"), TelemetryConsent: flags.Bool("telemetry-consent"), Arguments: command.Arguments(cmd)}
		return executePlan(ctx, input)
	}},
	{Name: "apply", Short: "Apply an install request", Args: cobra.NoArgs, Flags: []string{"index", "input", "platform-root", "project-root", "platform-version", "platform-channel", "gateway-url", "sdk-version", "service-profile", "plugins", "adapters", "provider", "policy", "offline", "secret-env", "registry", "binary-source", "marketplace-registry-url", "marketplace-registry-public-key-env", "marketplace-registry-token-env", "marketplace-npm-url", "scenario", "scenario-answers", "telemetry-endpoint", "telemetry-consent"}, Human: renderApply, Handler: func(ctx context.Context, cmd *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		deps.Command = cmd
		input := applyCommandInput{Plan: planInput{Operation: "apply", Index: flags.String("index"), RequestFile: flags.String("input"), Direct: readDirectRequest(flags), ScenarioID: flags.String("scenario"), Answers: flags.String("scenario-answers"), Executable: deps.Executable, KnownGateways: knownGatewayRoots(deps.Executable), Arguments: command.Arguments(cmd)}, SecretEnv: flags.String("secret-env"), Executable: deps.Executable, TelemetryEndpoint: flags.String("telemetry-endpoint"), TelemetryConsent: flags.Bool("telemetry-consent")}
		return executeApply(ctx, input, deps)
	}},
	{Name: "status", Short: "Show installation status", Args: cobra.NoArgs, Flags: []string{"platform-root"}, Human: renderStatus, Handler: func(ctx context.Context, _ *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		return executeStatus(ctx, statusCommandInput{PlatformRoot: flags.String("platform-root"), Executable: deps.Executable})
	}},
	{Name: "doctor", Short: "Diagnose or repair an installation", Args: cobra.NoArgs, Flags: []string{"platform-root", "doctor-input", "fix", "recover", "email", "tenant", "password-stdin", "generate", "yes", "foreground"}, Human: renderDoctor, Handler: func(ctx context.Context, cmd *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		input := doctorCommandInput{Command: cmd, PlatformRoot: flags.String("platform-root"), Executable: deps.Executable, InputFile: flags.String("doctor-input"), Fix: flags.Bool("fix"), Foreground: flags.Bool("foreground"), Recover: recoverRequest{Enabled: flags.Bool("recover"), Email: flags.String("email"), Tenant: flags.String("tenant"), PasswordStdin: flags.Bool("password-stdin"), Generate: flags.Bool("generate"), Yes: flags.Bool("yes"), JSON: jsonMode(cmd)}}
		return executeDoctor(ctx, input)
	}},
	{Name: "start", Short: "Start the local host", Args: cobra.NoArgs, Flags: []string{"platform-root", "foreground"}, Human: renderStart, Handler: func(ctx context.Context, _ *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		return executeHostStart(ctx, hostCommand{PlatformRoot: flags.String("platform-root"), Foreground: flags.Bool("foreground"), Executable: deps.Executable, Version: buildVersion})
	}},
	{Name: "stop", Short: "Stop the local host", Args: cobra.NoArgs, Flags: []string{"platform-root"}, Human: renderStop, Handler: func(ctx context.Context, _ *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		return executeHostStop(ctx, hostCommand{PlatformRoot: flags.String("platform-root"), Executable: deps.Executable, Version: buildVersion})
	}},
	{Name: "restart", Short: "Restart the local host", Args: cobra.NoArgs, Flags: []string{"platform-root", "interrupt"}, Human: renderRestart, Handler: func(ctx context.Context, _ *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		return executeHostRestart(ctx, hostCommand{PlatformRoot: flags.String("platform-root"), Interrupt: flags.Bool("interrupt"), Executable: deps.Executable, Version: buildVersion})
	}},
	{Name: "update", Short: "Update the installation", Args: cobra.NoArgs, Flags: []string{"index", "input", "platform-root", "project-root", "platform-version", "platform-channel", "gateway-url", "sdk-version", "service-profile", "plugins", "adapters", "provider", "policy", "offline", "secret-env", "scenario", "scenario-answers", "resume", "registry", "binary-source", "marketplace-registry-url", "marketplace-registry-public-key-env", "marketplace-registry-token-env", "marketplace-npm-url", "telemetry-endpoint", "telemetry-consent"}, Human: renderUpdate, Handler: func(ctx context.Context, cmd *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		invocation, err := flags.Invocation()
		if err != nil {
			return nil, contracts.NewDiag(contracts.CodeOperationFailed, "the update invocation could not be reconstructed", "rerun the command with its original flags", err)
		}
		input := updateCommandInput{Index: flags.String("index"), RequestFile: flags.String("input"), ScenarioID: flags.String("scenario"), Answers: flags.String("scenario-answers"), Direct: readUpdateRequest(flags), RetryCommand: invocation, Resume: flags.Bool("resume"), Executable: deps.Executable, SecretEnv: flags.String("secret-env"), ArtifactRunner: deps.ArtifactRunner, TelemetryEndpoint: flags.String("telemetry-endpoint"), TelemetryConsent: flags.Bool("telemetry-consent"), Arguments: command.Arguments(cmd)}
		return executeUpdate(ctx, input, deps)
	}},
	{Name: "uninstall", Short: "Remove the installation", Args: cobra.NoArgs, Flags: []string{"platform-root", "registry", "yes"}, Human: renderUninstall, Handler: func(ctx context.Context, cmd *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		var artifactInstaller runtime.ArtifactInstaller
		if deps.Runtime != nil {
			artifactInstaller = deps.Runtime.Artifacts
		}
		return executeUninstall(ctx, uninstallCommandInput{PlatformRoot: flags.String("platform-root"), Registry: flags.String("registry"), Executable: deps.Executable, Yes: flags.Bool("yes"), JSON: jsonMode(cmd), Command: cmd, Artifacts: artifactInstaller, ArtifactRunner: deps.ArtifactRunner})
	}},
	{Name: "rollback", Short: "Restore a saved snapshot", Args: cobra.NoArgs, Flags: []string{"platform-root", "registry", "snapshot", "yes"}, Human: renderRollback, Handler: func(ctx context.Context, cmd *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		var artifactInstaller runtime.ArtifactInstaller
		if deps.Runtime != nil {
			artifactInstaller = deps.Runtime.Artifacts
		}
		return executeRollback(ctx, rollbackCommandInput{PlatformRoot: flags.String("platform-root"), Registry: flags.String("registry"), Executable: deps.Executable, Snapshot: flags.String("snapshot"), Yes: flags.Bool("yes"), JSON: jsonMode(cmd), Command: cmd, Artifacts: artifactInstaller, ArtifactRunner: deps.ArtifactRunner})
	}},
	{Name: "supervise", Short: "Run the host supervisor", Hidden: true, Args: cobra.NoArgs, Flags: []string{"platform-root", "foreground"}, Human: renderSupervise, Handler: func(ctx context.Context, _ *cobra.Command, flags *commandFlagReader, deps commandDependencies) (any, *diag.Diag) {
		return executeHostSupervise(ctx, hostCommand{PlatformRoot: flags.String("platform-root"), Foreground: flags.Bool("foreground"), Executable: deps.Executable, Version: buildVersion})
	}},
	{Name: "version", Short: "Show launcher build identity", Args: cobra.NoArgs, Human: renderVersion, Handler: func(ctx context.Context, _ *cobra.Command, _ *commandFlagReader, _ commandDependencies) (any, *diag.Diag) {
		return executeVersion(ctx, versionCommandInput{})
	}},
}

func readDirectRequest(flags *commandFlagReader) directRequest {
	return readDirectRequestAt(flags, "platform-root")
}

func readUpdateRequest(flags *commandFlagReader) directRequest {
	return readDirectRequestAt(flags, "platform-root")
}

func readDirectRequestAt(flags *commandFlagReader, platformRootFlag string) directRequest {
	return directRequest{Registry: flags.String("registry"), BinarySource: flags.String("binary-source"), PlatformRoot: flags.String(platformRootFlag), ProjectRoot: flags.String("project-root"), PlatformVersion: flags.String("platform-version"), PlatformChannel: flags.String("platform-channel"), GatewayURL: flags.String("gateway-url"), SDKVersion: flags.String("sdk-version"), ServiceProfile: flags.String("service-profile"), Plugins: flags.String("plugins"), Adapters: flags.String("adapters"), Providers: flags.Strings("provider"), Policy: flags.String("policy"), Offline: flags.Bool("offline"), MarketplaceRegistryURL: flags.String("marketplace-registry-url"), MarketplaceSigningKeyEnv: flags.String("marketplace-registry-public-key-env"), MarketplaceTokenEnv: flags.String("marketplace-registry-token-env"), MarketplaceNpmURL: flags.String("marketplace-npm-url")}
}

func executablePath() string {
	path, _ := os.Executable()
	return path
}

func newRootCommand() *cobra.Command {
	return newRootCommandWithDependencyFactory(productionCommandDependencies)
}

func newRootCommandWithDependencyFactory(dependencyFactory func(*cobra.Command) commandDependencies) *cobra.Command {
	root := &cobra.Command{Use: "kb-create", Short: "Install, update, and diagnose a local KB Labs platform", SilenceUsage: true, SilenceErrors: true}
	registerPersistentFlags(root)
	for _, registered := range operationDescriptors {
		descriptor := registered
		values := make(map[string]any, len(descriptor.Flags))
		child := &cobra.Command{Use: descriptor.Name, Short: descriptor.Short, Args: descriptor.Args,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return callDescriptor(cmd, descriptor, values, dependencyFactory(cmd))
			}}
		child.Hidden = descriptor.Hidden
		registerLocalFlags(child, descriptor.Flags, values)
		root.AddCommand(child)
	}
	return root
}

func lookupOperationDescriptor(name string) (operationDescriptor, bool) {
	for _, descriptor := range operationDescriptors {
		if descriptor.Name == name {
			return descriptor, true
		}
	}
	return operationDescriptor{}, false
}

func callDescriptor(cmd *cobra.Command, descriptor operationDescriptor, values map[string]any, deps commandDependencies) error {
	output, failure := descriptor.Handler(cmd.Context(), cmd, newCommandFlagReader(cmd, values), deps)
	if failure != nil {
		return runSafely(func() error { return failure })
	}
	if completion, ok := output.(streamCompletion); ok {
		return result.StreamComplete(completion.ExitStatus)
	}
	if !jsonMode(cmd) && descriptor.Human != nil {
		if human := descriptor.Human(output); human != "" {
			command.Printf("%s\n", human)
		}
	}
	if applyResult, ok := output.(applyCommandResult); ok {
		return result.ReturnWithEmitter(output, func(write func() error) *diag.Diag {
			_, failure := emitFirstAdminResult(applyResult, descriptor.Name, write)
			return failure
		})
	}
	return result.Return(output)
}

func runSafely(run func() error) error {
	err := run()
	if err == nil || result.IsStreamComplete(err) {
		return err
	}
	var typed *diag.Diag
	if errors.As(err, &typed) && typed != nil {
		if _, known := diag.LookupCatalog(typed.Code); known {
			return typed
		}
	}
	home, homeErr := os.UserHomeDir()
	if homeErr != nil {
		return diag.FromErrorWithLogger(err, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	}
	logDir := filepath.Join(gateway.DataDir(home), "logs")
	if mkdirErr := os.MkdirAll(logDir, 0o700); mkdirErr != nil {
		return diag.FromErrorWithLogger(err, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	}
	file, openErr := os.OpenFile(filepath.Join(logDir, "kb-create.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if openErr != nil {
		return diag.FromErrorWithLogger(err, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	}
	defer file.Close()
	return diag.FromErrorWithLogger(err, slog.New(slog.NewJSONHandler(file, nil)))
}

type streamProgress struct{ writer *stream.Writer }

func (p streamProgress) Emit(event runtime.ProgressEvent) error {
	state := "completed"
	if event.Start {
		state = "started"
	}
	if err := p.writer.Event(map[string]any{"phase": event.Phase, "state": state}); err != nil {
		return progressWriteFailure(err, "apply")
	}
	return nil
}

func renderPlan(any) string { return "Install plan resolved." }
func renderVersion(any) string {
	return fmt.Sprintf("kb-create %s (commit %s)", buildVersion, buildCommit)
}

func executeVersion(_ context.Context, _ versionCommandInput) (map[string]any, *diag.Diag) {
	return map[string]any{"version": buildVersion, "commit": buildCommit}, nil
}
func renderUpdate(value any) string {
	if result, ok := value.(updateCommandResult); ok {
		message := "Platform update completed."
		if result.ProjectRegistrationNotice != "" {
			message += "\n" + result.ProjectRegistrationNotice
		}
		if result.AlreadyUpToDate {
			message = "Platform is already up to date."
		}
		if result.PendingRestart != nil {
			message += "\n" + renderPendingRestart(result.PendingRestart)
		}
		return message
	}
	return "Platform update completed."
}

func renderRollback(value any) string {
	result, ok := value.(recoveryCommandResult)
	if !ok || result.ProjectRegistrationNotice == "" {
		return "Platform rollback completed."
	}
	return "Platform rollback completed.\n" + result.ProjectRegistrationNotice
}
func renderUninstall(value any) string {
	result, ok := value.(recoveryCommandResult)
	if !ok {
		return "Platform uninstalled."
	}
	message := "Platform uninstalled."
	if len(result.PreservedEntries) > 0 {
		message += " Preserved foreign entries:\n  " + strings.Join(result.PreservedEntries, "\n  ")
	}
	switch result.ShimAction {
	case "removed":
		message += " The kb command was removed."
	case "left":
		message += fmt.Sprintf(" The kb command remains with its owner at %s.", result.ShimOwner)
	case "left-foreign":
		message += " The existing kb command was left untouched because its owner could not be verified."
	}
	return message
}
func renderStart(any) string     { return "KB Labs host started." }
func renderStop(any) string      { return "KB Labs host stopped." }
func renderRestart(any) string   { return "KB Labs host restarted." }
func renderSupervise(any) string { return "KB Labs host supervisor started." }

func renderApply(value any) string {
	payload, ok := value.(applyCommandResult)
	if !ok {
		return "Platform installation completed."
	}
	message := "Platform installation completed."
	if payload.Shim != nil && !payload.Shim.Linked {
		message += fmt.Sprintf("\nThe kb command is owned by %s; run %s to use this platform.", payload.Shim.Owner, shim.Target(payload.Receipt.Plan.Request.PlatformRoot))
	}
	if payload.ProjectRegistrationNotice != "" {
		message += "\n" + payload.ProjectRegistrationNotice
	}
	return withFirstAdmin(message, payload.FirstAdmin)
}

func withFirstAdmin(message string, credential *firstAdminCredential) string {
	if credential == nil {
		return message
	}
	switch credential.State {
	case firstAdminDisclosed:
		return fmt.Sprintf("%s\nFirst administrator credentials (shown once):\n  Email: %s\n  Password: %s", message, credential.Email, credential.Password)
	case firstAdminSupplied:
		return fmt.Sprintf("%s\nFirst administrator is ready; its password was supplied by the operator.\n  Email: %s", message, credential.Email)
	case firstAdminPreviouslyDisclosed:
		return fmt.Sprintf("%s\n%s\n  1. `%s`\n  2. `%s`\n  3. `%s`", message, credential.Notice, credential.StopCommand, credential.RecoveryCommand, credential.StartCommand)
	default:
		command := contracts.ShellCommand("kb-create", "doctor", "--recover", "--email", credential.Email, "--generate", "--yes")
		return fmt.Sprintf("%s\nFirst administrator result is incomplete. Run `%s` to recover access.", message, command)
	}
}

func renderStatus(value any) string {
	payload, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	installed, _ := payload["installed"].(bool)
	running, _ := payload["running"].(bool)
	reachable, _ := payload["reachable"].(bool)
	installation, _ := payload["installation"].(map[string]any)
	channel, _ := installation["platformChannel"].(string)
	version, _ := installation["platformVersion"].(string)
	lines := fmt.Sprintf("Installed: %t\nPlatform channel: %s\nPlatform version: %s\nRunning: %t\nReachable: %t", installed, channel, version, running, reachable)
	if studio, ok := payload["studioUrl"].(string); ok && studio != "" {
		lines += "\nStudio: " + studio
	}
	if next, ok := payload["next"].(string); ok && next != "" {
		lines += "\nNext: " + next
	}
	if installedVersion, ok := payload["installedVersion"].(string); ok && installedVersion != "" {
		lines += "\nInstalled version: " + installedVersion
	}
	if runningVersion, ok := payload["runningVersion"].(string); ok && runningVersion != "" {
		lines += "\nRunning version: " + runningVersion
	}
	if sources, ok := payload["marketplaceSources"].([]map[string]any); ok {
		for _, source := range sources {
			line := fmt.Sprintf("\nMarketplace source: %s %s", source["kind"], source["url"])
			if configured, _ := source["signingKeyConfigured"].(bool); configured {
				line += " (signing key configured)"
			}
			if configured, _ := source["authTokenConfigured"].(bool); configured {
				line += " (token configured)"
			}
			lines += line
		}
	}
	if pending := pendingRestartValue(payload["pendingRestart"]); pending != nil {
		lines += "\n" + renderPendingRestart(pending)
	}
	return lines
}

func renderDoctor(value any) string {
	diagnosis, ok := value.(doctorCommandResult)
	if !ok {
		return "Platform diagnosis completed."
	}
	return diagnosis.human()
}

func stringField(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return value
}
