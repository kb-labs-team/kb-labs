//go:build darwin

package main

/*
#include <mach/mach.h>
#include <servers/bootstrap.h>
static kern_return_t lookup_cfprefsd(mach_port_t *port) {
	return bootstrap_look_up(bootstrap_port, "com.apple.cfprefsd.daemon", port);
}
static kern_return_t release_service(mach_port_t port) { return mach_port_deallocate(mach_task_self(), port); }
*/
import "C"

import (
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"golang.org/x/sys/unix"
)

func main() {
	command.Exit(run())
}

func run() diag.ExitStatus {
	secretList := flag.String("secrets", "", "paths to fake secrets")
	target := flag.String("target", "", "TCP listener address")
	unixTarget := flag.String("unix-target", "", "Unix-domain socket path")
	hardlink := flag.String("hardlink", "", "hard link to planted secret")
	writePath := flag.String("write-path", "", "worktree symlink to outside target")
	dataVolumeAliases := flag.String("data-volume-aliases", "", "secret paths through the Data-volume alias")
	worktreeAliases := flag.String("worktree-aliases", "", "secret symlinks under the worktree")
	tempHomeAliases := flag.String("temp-home-aliases", "", "secret symlinks under the temporary HOME")
	goCacheAliases := flag.String("gocache-aliases", "", "secret symlinks under GOCACHE")
	flag.Parse()
	processes, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil || len(processes) == 0 {
		fmt.Println("PROCESS_DENIED")
		return diag.SuccessStatus()
	}
	if _, err := unix.SysctlRaw("kern.procargs2", os.Getpid()); err != nil {
		fmt.Println("PROCESS_ARGS_DENIED")
		return diag.SuccessStatus()
	}
	fmt.Printf("PROCESS_TABLE_ALLOWED %d\n", len(processes))
	fmt.Println("PROCESS_ARGS_ALLOWED")
	for _, path := range filepath.SplitList(*secretList) {
		if _, err := os.ReadFile(path); err != nil {
			fmt.Println("SECRET_DENIED", path)
		} else {
			fmt.Println("SECRET_ALLOWED", path)
		}
	}
	for _, group := range []struct {
		name  string
		paths string
	}{
		{name: "DATA_VOLUME", paths: *dataVolumeAliases},
		{name: "WORKTREE", paths: *worktreeAliases},
		{name: "TEMP_HOME", paths: *tempHomeAliases},
		{name: "GOCACHE", paths: *goCacheAliases},
	} {
		for _, path := range filepath.SplitList(group.paths) {
			if _, err := os.ReadFile(path); err != nil {
				fmt.Printf("%s_ALIAS_READ_DENIED %s\n", group.name, path)
			} else {
				fmt.Printf("%s_ALIAS_READ_ALLOWED %s\n", group.name, path)
			}
		}
	}
	if _, err := os.ReadFile(*hardlink); err != nil {
		fmt.Println("HARDLINK_READ_DENIED")
	} else {
		fmt.Println("HARDLINK_READ_ALLOWED")
	}
	connection, err := net.Dial("unix", *unixTarget)
	if err != nil {
		fmt.Println("UNIX_SOCKET_DENIED")
	} else {
		fmt.Println("UNIX_SOCKET_ALLOWED")
		if err := connection.Close(); err != nil {
			fmt.Println("UNIX_SOCKET_CLOSE_ERROR", err)
		}
	}
	service := C.mach_port_t(0)
	if C.lookup_cfprefsd(&service) != 0 {
		fmt.Println("MACH_LOOKUP_DENIED")
	} else {
		fmt.Println("MACH_LOOKUP_ALLOWED")
		if status := C.release_service(service); status != 0 {
			fmt.Println("MACH_RELEASE_ERROR", status)
		}
	}
	if err := os.WriteFile(*writePath, []byte("escaped"), 0o600); err != nil {
		fmt.Println("SYMLINK_WRITE_DENIED")
	} else {
		fmt.Println("SYMLINK_WRITE_ALLOWED")
	}
	connection, err = net.Dial("tcp", *target)
	if err != nil {
		fmt.Println("NETWORK_DENIED")
		return diag.SuccessStatus()
	}
	fmt.Println("NETWORK_ALLOWED")
	if err := connection.Close(); err != nil {
		fmt.Println("NETWORK_CLOSE_ERROR", err)
	}
	return diag.SuccessStatus()
}
