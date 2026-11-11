package ui

import (
	"io"
	"os"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// ColorEnabled reports whether ANSI color should be used when writing to w.
// The generated decision follows the ordered policy declared in
// core/plugin-contracts/src/color-policy.mjs. NO_COLOR conventions are at
// https://no-color.org/; FORCE_COLOR conventions follow
// https://github.com/chalk/supports-color.
func ColorEnabled(w io.Writer) bool {
	forceColor, forceColorSet := os.LookupEnv("FORCE_COLOR")
	return resolveColorSupport(isTerminalWriter(w), os.Getenv("NO_COLOR"), forceColor, forceColorSet, os.Getenv("TERM"))
}

// StdoutColorEnabled reports the color policy for the CLI's standard output.
func StdoutColorEnabled() bool {
	return ColorEnabled(os.Stdout)
}

// ConfigureLipglossColor applies the shared decision to Lipgloss's renderer,
// whose automatic environment detection otherwise overrides FORCE_COLOR.
func ConfigureLipglossColor(enabled bool) {
	if enabled {
		lipgloss.SetColorProfile(termenv.ANSI)
		return
	}
	lipgloss.SetColorProfile(termenv.Ascii)
}

func isTerminalWriter(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

func color(enabled bool, ansi string) lipgloss.TerminalColor {
	if !enabled {
		return lipgloss.NoColor{}
	}
	return lipgloss.Color(ansi)
}
