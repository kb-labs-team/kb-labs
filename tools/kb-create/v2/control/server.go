package control

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
)

const maxBodyBytes = 4096

// Server is the launcher control channel. It binds 127.0.0.1 on a random port,
// requires a bearer token on every request, and sets no CORS headers.
type Server struct {
	Runner  host.Runner
	State   host.State
	Version string

	token     string
	address   string
	listener  net.Listener
	http      *http.Server
	queue     *Queue
	startedAt time.Time
	restartMu sync.Mutex
	done      chan struct{}
}

// Start binds the listener, writes control.json (0600) and begins serving.
func (s *Server) Start() error {
	if err := s.State.Ensure(); err != nil {
		return err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	s.token = hex.EncodeToString(raw)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	s.listener, s.address = listener, listener.Addr().String()
	s.startedAt = time.Now().UTC()
	s.queue = &Queue{Path: s.State.UpdateRequests()}
	s.http = &http.Server{Handler: s.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second}
	file := File{Protocol: ProtocolVersion, Address: s.address, Token: s.token, PID: os.Getpid(), Version: s.Version}
	if err := writeControlFile(s.State.Control(), file); err != nil {
		_ = listener.Close()
		return err
	}
	s.done = make(chan struct{})
	go func() {
		defer close(s.done)
		_ = s.http.Serve(listener)
	}()
	return nil
}

// Address is the bound loopback address.
func (s *Server) Address() string { return s.address }

// Token is the bearer token (exposed for tests; clients read control.json).
func (s *Server) Token() string { return s.token }

// Close stops serving and removes control.json.
func (s *Server) Close() error {
	_ = os.Remove(s.State.Control())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := s.http.Shutdown(ctx)
	<-s.done
	return err
}

func writeControlFile(path string, file File) error {
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	// WriteFile only applies the mode to a newly created file, so make sure a
	// stale temp file cannot leave wider permissions behind.
	_ = os.Remove(temp)
	if err := os.WriteFile(temp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", s.status)
	mux.HandleFunc("POST /v1/host/restart", s.restart)
	mux.HandleFunc("POST /v1/update-request", s.updateRequest)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		s.fail(w, http.StatusNotFound, contracts.NewLauncherError("KB_RUNTIME_INPUT_INVALID", "Unknown control endpoint.", "Use GET /v1/status, POST /v1/host/restart or POST /v1/update-request.", nil))
	})
	return s.guard(mux)
}

// guard authenticates every request before routing, so an unauthenticated
// caller cannot even distinguish known from unknown paths.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			s.fail(w, http.StatusUnauthorized, contracts.NewLauncherError("KB_HOST_CONTROL_UNAUTHORIZED", "The launcher control channel rejected the request token.", "Read the current token from control.json in the launcher state directory.", nil))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) authorized(r *http.Request) bool {
	// Browser-originated requests are never legitimate clients of this
	// channel, and a foreign Host header indicates DNS rebinding.
	if r.Header.Get("Origin") != "" || r.Host != s.address {
		return false
	}
	if remote, _, err := net.SplitHostPort(r.RemoteAddr); err != nil || !net.ParseIP(remote).IsLoopback() {
		return false
	}
	header := r.Header.Get("Authorization")
	presented, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return false
	}
	// Compare fixed-length digests so the comparison time never depends on
	// where, or whether, the lengths differ.
	want, got := sha256.Sum256([]byte(s.token)), sha256.Sum256([]byte(presented))
	return subtle.ConstantTimeCompare(want[:], got[:]) == 1
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	hostStatus, err := s.Runner.Status(r.Context())
	if err != nil {
		s.failWith(w, err)
		return
	}
	s.write(w, http.StatusOK, StatusResponse{OK: true, Protocol: ProtocolVersion, Launcher: LauncherInfo{Version: s.Version, PID: os.Getpid(), StartedAt: s.startedAt}, Host: hostStatus, UpdateRequests: QueueSummary{Pending: s.queue.Pending()}})
}

func (s *Server) restart(w http.ResponseWriter, r *http.Request) {
	// One restart at a time; a second caller waits and then restarts again,
	// which is the least surprising behaviour for an idempotent request.
	s.restartMu.Lock()
	defer s.restartMu.Unlock()
	stopped, err := s.Runner.Stop(r.Context())
	if err != nil {
		s.failWith(w, err)
		return
	}
	info, err := s.Runner.Start(r.Context())
	if err != nil {
		s.failWith(w, err)
		return
	}
	s.write(w, http.StatusOK, RestartResponse{OK: true, Protocol: ProtocolVersion, Stopped: stopped, Host: info})
}

func (s *Server) updateRequest(w http.ResponseWriter, r *http.Request) {
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes))
	decoder.DisallowUnknownFields()
	var input UpdateRequestInput
	if err := decoder.Decode(&input); err != nil {
		s.fail(w, http.StatusBadRequest, contracts.NewLauncherError("KB_RUNTIME_INPUT_INVALID", "The update request body is not valid.", "Send {\"version\":\"x.y.z\"} or {\"channel\":\"stable\"}.", err))
		return
	}
	request, err := s.queue.Add(input)
	if errors.Is(err, errQueueFull) {
		s.fail(w, http.StatusTooManyRequests, contracts.NewLauncherError("KB_RUNTIME_RATE_LIMITED", "Too many update requests are waiting.", "Wait for the pending update requests to be processed.", err))
		return
	}
	if err != nil {
		s.fail(w, http.StatusBadRequest, contracts.NewLauncherError("KB_RUNTIME_INPUT_INVALID", "The update request is not valid.", "Send exactly one of an exact version or a channel (stable, canary, experimental).", err))
		return
	}
	s.write(w, http.StatusAccepted, UpdateRequestResponse{OK: true, Protocol: ProtocolVersion, Request: request})
}

func (s *Server) failWith(w http.ResponseWriter, err error) {
	var typed *contracts.LauncherError
	if errors.As(err, &typed) {
		status := http.StatusInternalServerError
		if typed.Code == "KB_HOST_ALREADY_RUNNING" {
			status = http.StatusConflict
		}
		s.fail(w, status, typed)
		return
	}
	s.fail(w, http.StatusInternalServerError, contracts.NewLauncherError("KB_RUNTIME_UNEXPECTED", "The launcher failed to process the request.", "Read the launcher log in the state directory.", err))
}

func (s *Server) fail(w http.ResponseWriter, status int, err *contracts.LauncherError) {
	s.write(w, status, ErrorResponse{OK: false, Error: err})
}

func (s *Server) write(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
