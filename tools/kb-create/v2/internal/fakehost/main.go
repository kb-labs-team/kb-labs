// Command fakehost is a tiny stand-in for the platform host, used only by
// launcher tests. It serves GET /health on a loopback port and can misbehave
// on request so the supervisor's failure paths are exercised for real.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	port := flag.Int("port", 0, "loopback port to serve /health on")
	ignoreTerm := flag.Bool("ignore-term", false, "ignore SIGTERM (forces the launcher to kill)")
	unhealthy := flag.Bool("unhealthy", false, "answer /health with 500")
	exitCode := flag.Int("exit", -1, "exit immediately with this status (start failure)")
	delay := flag.Duration("delay", 0, "wait before listening")
	dumpEnv := flag.String("dump-env", "", "write the process environment to this file at start")
	flag.Parse()
	if *exitCode >= 0 {
		fmt.Fprintln(os.Stderr, "fakehost: exiting early")
		os.Exit(*exitCode)
	}
	if *dumpEnv != "" {
		if err := os.WriteFile(*dumpEnv, []byte(strings.Join(os.Environ(), "\n")+"\n"), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, "fakehost:", err)
			os.Exit(4)
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
		os.Exit(3)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		if *unhealthy {
			http.Error(w, "unhealthy", http.StatusInternalServerError)
			return
		}
		fmt.Fprint(w, "ok")
	})
	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(listener) }()
	fmt.Println("fakehost: ready")
	<-signals
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}
