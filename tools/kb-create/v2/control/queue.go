package control

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sync"
	"time"
)

const (
	statusPending = "pending"
	maxPending    = 16
)

var (
	// errQueueFull is returned when too many requests are waiting.
	errQueueFull = errors.New("update request queue is full")
	versionRule  = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)
	channels     = map[string]bool{"stable": true, "canary": true, "experimental": true}
)

// validateUpdateInput enforces: exactly one of version|channel, known shapes.
func validateUpdateInput(input UpdateRequestInput) error {
	if (input.Version == "") == (input.Channel == "") {
		return errors.New("exactly one of version and channel is required")
	}
	if input.Version != "" && !versionRule.MatchString(input.Version) {
		return errors.New("version must be an exact semantic version")
	}
	if input.Channel != "" && !channels[input.Channel] {
		return errors.New("channel must be stable, canary or experimental")
	}
	if len(input.RequestedBy) > 64 {
		return errors.New("requestedBy must be at most 64 characters")
	}
	return nil
}

// Queue persists update requests in the launcher state home. The update flow
// that consumes them is later work; this only records and validates.
type Queue struct {
	Path string
	Now  func() time.Time
	mu   sync.Mutex
}

// Add records a request. An identical pending request is returned as is, so
// a retrying caller does not grow the queue.
func (q *Queue) Add(input UpdateRequestInput) (UpdateRequest, error) {
	if err := validateUpdateInput(input); err != nil {
		return UpdateRequest{}, err
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	items, err := q.load()
	if err != nil {
		return UpdateRequest{}, err
	}
	for _, item := range items {
		if item.Status == statusPending && item.Version == input.Version && item.Channel == input.Channel {
			return item, nil
		}
	}
	if len(items) >= maxPending {
		return UpdateRequest{}, errQueueFull
	}
	id, err := newID()
	if err != nil {
		return UpdateRequest{}, err
	}
	now := time.Now
	if q.Now != nil {
		now = q.Now
	}
	request := UpdateRequest{ID: id, Status: statusPending, Version: input.Version, Channel: input.Channel, RequestedBy: input.RequestedBy, CreatedAt: now().UTC()}
	items = append(items, request)
	if err := q.save(items); err != nil {
		return UpdateRequest{}, err
	}
	return request, nil
}

// Pending counts waiting requests.
func (q *Queue) Pending() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	items, err := q.load()
	if err != nil {
		return 0
	}
	count := 0
	for _, item := range items {
		if item.Status == statusPending {
			count++
		}
	}
	return count
}

func (q *Queue) load() ([]UpdateRequest, error) {
	data, err := os.ReadFile(q.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var items []UpdateRequest
	if err := json.Unmarshal(data, &items); err != nil {
		return nil, fmt.Errorf("decode update request queue: %w", err)
	}
	return items, nil
}

func (q *Queue) save(items []UpdateRequest) error {
	data, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return err
	}
	temp := q.Path + ".tmp"
	if err := os.WriteFile(temp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temp, q.Path)
}

func newID() (string, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "upd_" + hex.EncodeToString(raw), nil
}
