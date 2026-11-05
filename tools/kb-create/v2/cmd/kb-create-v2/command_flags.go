package v2cli

import (
	"fmt"
	"strings"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/scenario"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

type flagKind uint8

const (
	stringFlag flagKind = iota
	boolFlag
	repeatedStringFlag
)

type flagDefinition struct {
	Name, Usage string
	Kind        flagKind
	Default     string
	Secret      bool
	URL         bool
}

var flagCatalog = map[string]flagDefinition{
	"index":                               {Name: "index", Usage: "path to immutable release index JSON"},
	"input":                               {Name: "input", Usage: "path to install request JSON"},
	"project-root":                        {Name: "project-root", Usage: "project directory to register after installation"},
	"platform-version":                    {Name: "platform-version", Usage: "exact platform version"},
	"platform-channel":                    {Name: "platform-channel", Usage: "platform channel: stable, canary, experimental"},
	"gateway-url":                         {Name: "gateway-url", Usage: "Gateway origin for this installation, for example http://127.0.0.1:4100", URL: true},
	"sdk-version":                         {Name: "sdk-version", Usage: "exact SDK version"},
	"service-profile":                     {Name: "service-profile", Usage: "platform-owned service profile"},
	"plugins":                             {Name: "plugins", Usage: "comma-separated plugin IDs or id@version pins"},
	"adapters":                            {Name: "adapters", Usage: "comma-separated adapter IDs or id@version pins"},
	"provider":                            {Name: "provider", Usage: "provider preference capability=adapter (repeatable)", Kind: repeatedStringFlag},
	"policy":                              {Name: "policy", Usage: "compatibility policy: strict or compatible", Default: "strict"},
	"offline":                             {Name: "offline", Usage: "use the offline artifact source", Kind: boolFlag},
	"secret-env":                          {Name: "secret-env", Usage: "requirement=ENV_VAR secret sources (never serialized)"},
	"doctor-input":                        {Name: "doctor-input", Usage: "path to manifest-derived doctor JSON"},
	"scenario":                            {Name: "scenario", Usage: "built-in install scenario ID"},
	"scenario-answers":                    {Name: "scenario-answers", Usage: "JSON object of scenario answers", Secret: true},
	"resume":                              {Name: "resume", Usage: "resume persisted non-secret scenario answers", Kind: boolFlag},
	"fix":                                 {Name: "fix", Usage: "apply manifest-declared safe defaults", Kind: boolFlag},
	"recover":                             {Name: "recover", Usage: "recover the administrator account", Kind: boolFlag},
	"email":                               {Name: "email", Usage: "administrator email for recovery"},
	"tenant":                              {Name: "tenant", Usage: "tenant ID for recovery"},
	"password-stdin":                      {Name: "password-stdin", Usage: "read recovery password from stdin", Kind: boolFlag},
	"generate":                            {Name: "generate", Usage: "generate and print a recovery password once", Kind: boolFlag},
	"yes":                                 {Name: "yes", Usage: "confirm recovery, uninstall, or rollback", Kind: boolFlag},
	"platform-root":                       {Name: "platform-root", Usage: "platform root for an install request or lifecycle operation"},
	"snapshot":                            {Name: "snapshot", Usage: "snapshot ID for rollback"},
	"binary-source":                       {Name: "binary-source", Usage: "base URL for checksum-verified release binary assets", URL: true},
	"registry":                            {Name: "registry", Usage: "npm registry for exact artifact installation", URL: true},
	"marketplace-registry-url":            {Name: "marketplace-registry-url", Usage: "KB Marketplace Registry URL for plugin resolution", URL: true},
	"marketplace-registry-public-key-env": {Name: "marketplace-registry-public-key-env", Usage: "environment variable containing the Registry Ed25519 public key"},
	"marketplace-registry-token-env":      {Name: "marketplace-registry-token-env", Usage: "environment variable containing the Registry bearer token"},
	"marketplace-npm-url":                 {Name: "marketplace-npm-url", Usage: "npm source or fallback mirror URL for Marketplace identities", URL: true},
	"telemetry-endpoint":                  {Name: "telemetry-endpoint", Usage: "opt-in anonymous telemetry endpoint", URL: true},
	"foreground":                          {Name: "foreground", Usage: "run the host directly in this process", Kind: boolFlag},
	"interrupt":                           {Name: "interrupt", Usage: "interrupt active work before restarting the host", Kind: boolFlag},
	"telemetry-consent":                   {Name: "telemetry-consent", Usage: "allow anonymous operational telemetry", Kind: boolFlag},
	"json":                                {Name: "json", Usage: "emit machine-readable output", Kind: boolFlag},
}

type commandFlagReader struct {
	command *cobra.Command
	values  map[string]any
	reads   map[string]struct{}
}

func newCommandFlagReader(command *cobra.Command, values map[string]any) *commandFlagReader {
	return &commandFlagReader{command: command, values: values, reads: make(map[string]struct{})}
}

func (r *commandFlagReader) String(name string) string {
	r.reads[name] = struct{}{}
	return *r.values[name].(*string)
}

func (r *commandFlagReader) Bool(name string) bool {
	r.reads[name] = struct{}{}
	return *r.values[name].(*bool)
}

func (r *commandFlagReader) Strings(name string) []string {
	r.reads[name] = struct{}{}
	return append([]string(nil), (*r.values[name].(*repeatedValue))...)
}

func (r *commandFlagReader) Changed(name string) bool {
	r.reads[name] = struct{}{}
	flag := r.command.Flags().Lookup(name)
	return flag != nil && flag.Changed
}

func (r *commandFlagReader) Invocation() (string, error) {
	if args := clikitcommand.Arguments(r.command); len(args) > 0 {
		invocation, _ := retryArguments(args)
		return invocation, nil
	}
	argv := strings.Fields(r.command.CommandPath())
	var failure error
	r.command.Flags().Visit(func(flag *pflag.Flag) {
		if failure != nil {
			return
		}
		definition, ok := flagCatalog[flag.Name]
		if !ok {
			failure = fmt.Errorf("changed command flag %q has no invocation declaration", flag.Name)
			return
		}
		if definition.Secret {
			return
		}
		name := "--" + flag.Name
		if values, ok := r.values[flag.Name].(*repeatedValue); ok {
			for _, value := range *values {
				argv = append(argv, name, value)
			}
			return
		}
		if flag.Value.Type() == "bool" {
			if flag.Value.String() == "true" {
				argv = append(argv, name)
			} else {
				argv = append(argv, name+"=false")
			}
			return
		}
		argv = append(argv, name, flag.Value.String())
	})
	if failure != nil {
		return "", failure
	}
	return contracts.ShellCommand(argv...), nil
}

func registerLocalFlags(command *cobra.Command, names []string, values map[string]any) {
	for _, name := range names {
		definition, ok := flagCatalog[name]
		if !ok {
			panic("kb-create descriptor references unknown flag " + name)
		}
		if name == "scenario" {
			ids, err := scenario.IDs()
			if err != nil {
				panic(err)
			}
			definition.Usage += ": " + strings.Join(ids, ", ")
		}
		switch definition.Kind {
		case stringFlag:
			value := definition.Default
			command.Flags().StringVar(&value, name, definition.Default, definition.Usage)
			values[name] = &value
		case boolFlag:
			value := false
			command.Flags().BoolVar(&value, name, false, definition.Usage)
			values[name] = &value
		case repeatedStringFlag:
			value := repeatedValue{}
			command.Flags().Var(&value, name, definition.Usage)
			values[name] = &value
		default:
			panic("kb-create descriptor uses unsupported flag kind")
		}
	}
}

func registerPersistentFlags(command *cobra.Command) {
	command.PersistentFlags().Bool("json", false, "emit machine-readable output")
}

func jsonMode(command *cobra.Command) bool {
	flag := command.Flags().Lookup("json")
	if flag == nil {
		flag = command.InheritedFlags().Lookup("json")
	}
	return flag != nil && flag.Value.Type() == "bool" && flag.Value.String() == "true"
}

func localFlagNames(command *cobra.Command) []string {
	names := make([]string, 0)
	command.LocalNonPersistentFlags().VisitAll(func(flag *pflag.Flag) { names = append(names, flag.Name) })
	return names
}
