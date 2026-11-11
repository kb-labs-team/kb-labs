package control

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/kb-labs/clikit/diag"
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
	Restart func(context.Context, bool) (RestartResponse, error)

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
	processIdentity, err := host.ProcessIdentityForPID(os.Getpid())
	if err != nil {
		_ = listener.Close()
		return err
	}
	file := File{Protocol: ProtocolVersion, Address: s.address, Token: s.token, PID: os.Getpid(), ProcessIdentity: processIdentity, Version: s.Version}
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
	return host.WriteRecordFile(path, append(data, '\n'))
}

func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", s.status)
	mux.HandleFunc("POST /v1/host/restart", s.restart)
	mux.HandleFunc("POST /v1/update-request", s.updateRequest)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		s.fail(w, http.StatusNotFound, contracts.NewDiag("KB_RUNTIME_INPUT_INVALID", "Unknown control endpoint.", "Use GET /v1/status, POST /v1/host/restart or POST /v1/update-request.", nil))
	})
	return s.guard(mux)
}

// guard authenticates every request before routing, so an unauthenticated
// caller cannot even distinguish known from unknown paths.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			s.fail(w, http.StatusUnauthorized, contracts.NewDiag("KB_HOST_CONTROL_UNAUTHORIZED", "The launcher control channel rejected the request token.", "Read the current token from control.json in the install-root host-state directory reported by `kb-create doctor`.", nil))
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
	var input RestartRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes)).Decode(&input); err != nil && !errors.Is(err, io.EOF) {
		s.fail(w, http.StatusBadRequest, contracts.NewDiag("KB_RUNTIME_INPUT_INVALID", "The restart request body is not valid.", "Send an empty object or {\"interrupt\":true}.", err))
		return
	}
	if s.Restart != nil {
		response, err := s.Restart(r.Context(), input.Interrupt)
		if err != nil {
			s.failWith(w, err)
			return
		}
		s.write(w, http.StatusOK, response)
		return
	}
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
		s.fail(w, http.StatusBadRequest, contracts.NewDiag("KB_RUNTIME_INPUT_INVALID", "The update request body is not valid.", "Send {\"version\":\"x.y.z\"} or {\"channel\":\"stable\"}.", err))
		return
	}
	request, err := s.queue.Add(input)
	if errors.Is(err, errQueueFull) {
		limited := contracts.NewDiag("KB_RUNTIME_RATE_LIMITED", "Too many update requests are waiting.", "Wait for the pending update requests to be processed.", err)
		limited.Meta = map[string]any{"retryAfter": "the pending update completes"}
		s.fail(w, http.StatusTooManyRequests, limited)
		return
	}
	if err != nil {
		diagnostic := contracts.NewDiag("KB_RUNTIME_INPUT_INVALID", "The update request is not valid.", "Send exactly one of an exact version or a channel (stable, canary, experimental).", err)
		if input.Version != "" && input.Channel != "" {
			diagnostic.Cause = "exactly one of version and channel is required"
		}
		s.fail(w, http.StatusBadRequest, diagnostic)
		return
	}
	s.write(w, http.StatusAccepted, UpdateRequestResponse{OK: true, Protocol: ProtocolVersion, Request: request})
}

func (s *Server) failWith(w http.ResponseWriter, err error) {
	var typed *diag.Diag
	if errors.As(err, &typed) {
		status := http.StatusInternalServerError
		if typed.Code == contracts.CodeHostAlreadyRunning {
			status = http.StatusConflict
		}
		s.fail(w, status, typed)
		return
	}
	s.fail(w, http.StatusInternalServerError, contracts.NewDiag("KB_RUNTIME_UNEXPECTED", "The launcher failed to process the request.", "Read the launcher log in the state directory.", err))
}

func (s *Server) fail(w http.ResponseWriter, status int, err *diag.Diag) {
	err = diag.FromError(err)
	s.write(w, status, ErrorResponse{OK: false, Error: err})
}

func (s *Server) write(w http.ResponseWriter, status int, body any) {
	_ = diag.WriteHTTPJSON(w, status, body, func(cause error) any {
		return ErrorResponse{OK: false, Error: contracts.NewDiag(
			"KB_RUNTIME_UNEXPECTED", "The response could not be encoded.",
			"Correct the launcher response data, then retry the request.", cause,
		)}
	})
}
