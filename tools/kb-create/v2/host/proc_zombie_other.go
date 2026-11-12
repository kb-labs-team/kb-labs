//go:build !linux && !darwin && !windows

package host

// processZombie: this platform has no zombie probe, so a signalable pid counts as alive.
func processZombie(int) bool { return false }
