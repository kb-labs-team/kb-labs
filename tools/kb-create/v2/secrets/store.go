// Package secrets owns V2's local secret boundary. Values are private,
// atomic, and deliberately absent from plans, receipts, scenario state, logs,
// and diagnostic dossiers.
package secrets

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Store struct{ PlatformRoot string }

func (store Store) Put(name, value string) error {
	if err := validate(name); err != nil {
		return err
	}
	if value == "" {
		return fmt.Errorf("secret %q is empty", name)
	}
	if err := os.MkdirAll(filepath.Dir(store.path()), 0o750); err != nil {
		return err
	}
	values, err := store.read()
	if err != nil {
		return err
	}
	values[name] = value
	data := make([]string, 0, len(values))
	for key, item := range values {
		data = append(data, key+"="+item)
	}
	sortStrings(data)
	temporary := store.path() + ".tmp"
	if err := os.WriteFile(temporary, []byte(strings.Join(data, "\n")+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, store.path())
}
func (store Store) Exists(name string) (bool, error) {
	if err := validate(name); err != nil {
		return false, err
	}
	values, err := store.read()
	if err != nil {
		return false, err
	}
	return values[name] != "", nil
}

// Get returns a stored secret. The bool reports presence (an empty stored value
// counts as absent, matching Exists).
func (store Store) Get(name string) (string, bool, error) {
	if err := validate(name); err != nil {
		return "", false, err
	}
	values, err := store.read()
	if err != nil {
		return "", false, err
	}
	value := values[name]
	return value, value != "", nil
}
func (store Store) path() string {
	return filepath.Join(store.PlatformRoot, ".kb", "v2", "secrets.env")
}
func (store Store) read() (map[string]string, error) {
	data, err := os.ReadFile(store.path())
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[key] = value
		}
	}
	return values, nil
}
func validate(name string) error {
	if name == "" || strings.ContainsAny(name, "=\r\n") || strings.TrimSpace(name) != name {
		return fmt.Errorf("invalid secret name %q", name)
	}
	return nil
}
func sortStrings(values []string) {
	for i := range values {
		for j := i + 1; j < len(values); j++ {
			if values[j] < values[i] {
				values[i], values[j] = values[j], values[i]
			}
		}
	}
}
