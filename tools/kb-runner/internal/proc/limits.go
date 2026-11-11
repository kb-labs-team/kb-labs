//go:build darwin || linux

package proc

func limitsAdvisory(reason string) string {
	return "limits advisory: " + reason
}
