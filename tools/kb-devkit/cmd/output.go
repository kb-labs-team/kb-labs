package cmd

import (
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"
	"os"

	"github.com/charmbracelet/lipgloss"
	"github.com/kb-labs/clikit/result"
	clikitui "github.com/kb-labs/clikit/ui"
)

// output provides unified CLI formatting with lipgloss.
type output struct {
	infoTag string
	okTag   string
	warnTag string
	errTag  string
	label   lipgloss.Style
	value   lipgloss.Style
	dim     lipgloss.Style
	bullet  lipgloss.Style

	// Issue severity styles.
	healthy  lipgloss.Style
	warning  lipgloss.Style
	errStyle lipgloss.Style
	info     lipgloss.Style
}

func newOutput() output {
	enabled := colorEnabled()
	clikitui.ConfigureLipglossColor(enabled)
	return output{
		infoTag: lipgloss.NewStyle().Bold(enabled).Foreground(color(enabled, "14")).Render("[INFO]"),
		okTag:   lipgloss.NewStyle().Bold(enabled).Foreground(color(enabled, "10")).Render("[ OK ]"),
		warnTag: lipgloss.NewStyle().Bold(enabled).Foreground(color(enabled, "11")).Render("[WARN]"),
		errTag:  lipgloss.NewStyle().Bold(enabled).Foreground(color(enabled, "9")).Render("[ERR ]"),
		label:   lipgloss.NewStyle().Bold(enabled).Foreground(color(enabled, "8")),
		value:   lipgloss.NewStyle().Foreground(color(enabled, "14")),
		dim:     lipgloss.NewStyle().Foreground(color(enabled, "8")),
		bullet:  lipgloss.NewStyle().Foreground(color(enabled, "10")),

		healthy:  lipgloss.NewStyle().Foreground(color(enabled, "10")),
		warning:  lipgloss.NewStyle().Foreground(color(enabled, "11")),
		errStyle: lipgloss.NewStyle().Foreground(color(enabled, "9")),
		info:     lipgloss.NewStyle().Foreground(color(enabled, "14")),
	}
}

func (o output) Info(msg string) { clikitcommand.Printf("%s %s\n", o.infoTag, msg) }
func (o output) OK(msg string)   { clikitcommand.Printf("%s %s\n", o.okTag, msg) }
func (o output) Warn(msg string) { clikitcommand.Printf("%s %s\n", o.warnTag, msg) }
func (o output) Err(msg string)  { clikitcommand.Printf("%s %s\n", o.errTag, msg) }

func (o output) Section(title string) {
	clikitcommand.Printf("\n%s %s\n", o.infoTag, o.label.Render(title))
}

func (o output) KeyValue(k, v string) {
	clikitcommand.Printf("  %s %s\n", o.label.Render(k+":"), o.value.Render(v))
}

func (o output) Bullet(label, details string) {
	if details == "" {
		clikitcommand.Printf("    %s %s\n", o.bullet.Render("●"), label)
		return
	}
	clikitcommand.Printf("    %s %-30s  %s\n", o.bullet.Render("●"), label, o.dim.Render(details))
}

// StatusIcon returns the colored icon for a package/workspace health state.
func (o output) StatusIcon(state string) string {
	switch state {
	case "healthy":
		return o.healthy.Render("●")
	case "warning":
		return o.warning.Render("◐")
	case "error":
		return o.errStyle.Render("✕")
	default: // unknown / skipped
		return o.dim.Render("○")
	}
}

// SeverityColor returns colored severity label.
func (o output) SeverityColor(severity string) string {
	switch severity {
	case "error":
		return o.errStyle.Render("error")
	case "warning":
		return o.warning.Render("warning")
	default:
		return o.info.Render(severity)
	}
}

// Detail prints a diagnostic line indented under a package.
func (o output) Detail(msg string) {
	clikitcommand.Printf("    %s\n", o.dim.Render("↳ "+msg))
}

// Pad pads a string to the given width.
func Pad(s string, width int) string {
	return fmt.Sprintf("%-*s", width, s)
}

// JSONOut writes a value as JSON to stdout.
func JSONOut(v any) error {
	return result.Return(v)
}

func color(enabled bool, ansi string) lipgloss.TerminalColor {
	if !enabled {
		return lipgloss.NoColor{}
	}
	return lipgloss.Color(ansi)
}

func colorEnabled() bool {
	return clikitui.StdoutColorEnabled()
}

func stdoutIsTerminal() bool {
	fi, err := os.Stdout.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}
