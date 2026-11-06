package cmd

import (
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"

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

	// Status-specific styles.
	alive    lipgloss.Style
	degraded lipgloss.Style
	failed   lipgloss.Style
	dead     lipgloss.Style
	starting lipgloss.Style
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

		alive:    lipgloss.NewStyle().Foreground(color(enabled, "10")),
		degraded: lipgloss.NewStyle().Foreground(color(enabled, "11")),
		failed:   lipgloss.NewStyle().Foreground(color(enabled, "9")),
		dead:     lipgloss.NewStyle().Foreground(color(enabled, "8")),
		starting: lipgloss.NewStyle().Foreground(color(enabled, "14")),
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
	clikitcommand.Printf("    %s %-15s  %s\n", o.bullet.Render("●"), label, o.dim.Render(details))
}

// StatusIcon returns the colored icon for a service state.
func (o output) StatusIcon(state string) string {
	switch state {
	case "alive":
		return o.alive.Render("●")
	case "degraded":
		return o.degraded.Render("◐")
	case "failed":
		return o.failed.Render("✕")
	case "starting":
		return o.starting.Render("◉")
	case "stopping":
		return o.dim.Render("◌")
	default: // dead
		return o.dead.Render("○")
	}
}

// StatusColor returns the colored text for a state label.
func (o output) StatusColor(state string) string {
	switch state {
	case "alive":
		return o.alive.Render(state)
	case "degraded":
		return o.degraded.Render(state)
	case "failed":
		return o.failed.Render(state)
	case "starting":
		return o.starting.Render(state)
	default:
		return o.dead.Render(state)
	}
}

// Detail prints a diagnostic line indented under a service.
func (o output) Detail(msg string) {
	clikitcommand.Printf("    %s\n", o.dim.Render("↳ "+msg))
}

// Pad pads a string to the given width.
func Pad(s string, width int) string {
	return fmt.Sprintf("%-*s", width, s)
}

// JSONOut writes a value as JSON to stdout and returns any marshaling error.
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
