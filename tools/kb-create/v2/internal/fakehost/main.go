// Command fakehost is a tiny stand-in for the platform host, used only by
// launcher tests. It serves GET /health on a loopback port and can misbehave
// on request so the supervisor's failure paths are exercised for real.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
)

func main() {
	command.Exit(run())
}

func run() diag.ExitStatus {
	port := flag.Int("port", 0, "loopback port to serve /health on")
	ignoreTerm := flag.Bool("ignore-term", false, "ignore SIGTERM (forces the launcher to kill)")
	unhealthy := flag.Bool("unhealthy", false, "answer /health with 500")
	exitCode := flag.Int("exit", -1, "exit immediately with this status (start failure)")
	startupError := flag.Bool("startup-error", false, "emit a typed startup error before exiting")
	delay := flag.Duration("delay", 0, "wait before listening")
	dumpEnv := flag.String("dump-env", "", "write the process environment to this file at start")
	stderrLine := flag.String("stderr-line", "", "write one line to stderr before listening")
	activeWorkJSON := flag.String("active-work-json", "[]", "test response for the authenticated active-work endpoint")
	flag.Parse()
	if *startupError {
		if token := os.Getenv("API_TOKEN"); token != "" {
			fmt.Fprintln(os.Stderr, "API_TOKEN="+token)
		}
		fmt.Fprintln(os.Stderr, `{"ok":false,"error":{"code":"KB_CONFIG_INVALID","message":"Adapter option \"platform.adapterOptions.analytics.retentionDays\" is invalid: must be a positive integer.","cause":"must be a positive integer","hint":"kb config set --scope platform platform.adapterOptions.analytics.retentionDays 90","details":{"path":"platform.adapterOptions.analytics.retentionDays"}}}`)
		return childExitStatus(7)
	}
	if *exitCode >= 0 {
		fmt.Fprintln(os.Stderr, "fakehost: exiting early")
		return childExitStatus(*exitCode)
	}
	if *stderrLine != "" {
		fmt.Fprintln(os.Stderr, *stderrLine)
	}
	if *dumpEnv != "" {
		if err := os.WriteFile(*dumpEnv, []byte(strings.Join(os.Environ(), "\n")+"\n"), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, "fakehost:", err)
			return diag.ExitCode(diag.New("KB_RUNTIME_UNEXPECTED", "The fake host could not write its test environment.", diag.WithCauseAndReason(err.Error()), diag.WithHint("Check the fake host environment path and rerun the test.")))
		}
	}
	signals := make(chan os.Signal, 1)
	if *ignoreTerm {
		signal.Ignore(syscall.SIGTERM)
	} else {
		signal.Notify(signals, syscall.SIGTERM, os.Interrupt)
	}
	time.Sleep(*delay)
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		fmt.Fprintln(os.Stderr, "fakehost:", err)
		return diag.ExitCode(diag.New("KB_RUNTIME_UNEXPECTED", "The fake host could not start its test listener.", diag.WithCauseAndReason(err.Error()), diag.WithHint("Check the test listener address and rerun the test.")))
	}
	mux := http.NewServeMux()
	var ready atomic.Bool
	var controlServer *http.Server
	controlCredential := os.Getenv(contracts.HostControlCredentialEnv)
	var controlAddress string
	if controlCredential != "" {
		controlListener, controlErr := net.Listen("tcp", "127.0.0.1:0")
		if controlErr != nil {
			fmt.Fprintln(os.Stderr, "fakehost: control listener unavailable")
			return diag.ExitCode(diag.New("KB_RUNTIME_UNEXPECTED", "The fake host control listener could not start.", diag.WithCauseAndReason(controlErr.Error()), diag.WithHint("Check the test listener address and rerun the test.")))
		}
		controlAddress = "http://" + controlListener.Addr().String()
		controlMux := http.NewServeMux()
		controlMux.HandleFunc("/v1/active-work", func(w http.ResponseWriter, request *http.Request) {
			if request.Header.Get("Authorization") != "Bearer "+controlCredential {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, *activeWorkJSON)
		})
		controlServer = &http.Server{Handler: controlMux}
		go func() { _ = controlServer.Serve(controlListener) }()
	}
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		if *unhealthy {
			http.Error(w, "unhealthy", http.StatusInternalServerError)
			return
		}
		ready.Store(true)
		if controlAddress != "" {
			w.Header().Set(contracts.HostActiveWorkAddressHeader, controlAddress)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true,"data":{"upstreams":{},"adapters":{}}}`)
	})
	mux.HandleFunc("/health/adapters", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true,"data":[{"slot":"storage","mode":"real","implementation":"@kb-labs/adapters-fs"}]}`)
	})
	mux.HandleFunc("/api/v1/marketplace/packages/install", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var request struct {
			Specs []string `json:"specs"`
			Scope string   `json:"scope"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, "invalid Marketplace install request", http.StatusBadRequest)
			return
		}
		if request.Scope != "platform" || len(request.Specs) == 0 {
			http.Error(w, "invalid Marketplace install scope or identities", http.StatusBadRequest)
			return
		}
		if !ready.Load() {
			http.Error(w, "host is not ready", http.StatusServiceUnavailable)
			return
		}
		installed := make([]contracts.MarketplaceInstallRecord, 0, len(request.Specs))
		for _, spec := range request.Specs {
			installed = append(installed, contracts.MarketplaceInstallRecord{
				ID: spec, Spec: spec, Version: "1.0.0", PrimaryKind: "plugin", Source: "registry", SignatureStatus: "verified",
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"installed": installed, "scope": request.Scope})
	})
	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(listener) }()
	fmt.Fprintln(os.Stderr, "fakehost: ready")
	<-signals
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	if controlServer != nil {
		_ = controlServer.Shutdown(ctx)
	}
	return diag.SuccessStatus()
}

func childExitStatus(code int) diag.ExitStatus {
	if code == 0 {
		return diag.SuccessStatus()
	}
	var child *exec.ExitError
	var command *exec.Cmd
	if runtime.GOOS == "windows" {
		command = exec.Command("cmd.exe", "/c", "exit", fmt.Sprint(code))
	} else {
		command = exec.Command("sh", "-c", "exit "+fmt.Sprint(code))
	}
	command.Stdout, command.Stderr = nil, nil
	if err := command.Run(); !errors.As(err, &child) {
		return diag.ExitCode(diag.New("KB_RUNTIME_UNEXPECTED", "The fake host could not simulate a child process exit.", diag.WithCauseAndReason(fmt.Sprint(err)), diag.WithHint("Check the system shell used by the fake host test.")))
	}
	return diag.ChildProcessStatus(child)
}
