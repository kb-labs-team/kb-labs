//go:build darwin || linux

package proc

import "testing"

func TestRunOwnsProcessRequiresRunKeeperAndWorkerIdentities(t *testing.T) {
	listing := Listing{Runs: []RunInfo{{
		RunID: "run-1", PID: 100, Identity: "keeper-start", Status: StatusRunning,
		Tree: []Process{{PID: 200, Identity: "worker-start"}},
	}}}
	cases := []struct {
		name     string
		runID    string
		pid      int
		identity string
		want     bool
	}{
		{name: "exact run and worker", runID: "run-1", pid: 200, identity: "worker-start", want: true},
		{name: "foreign run", runID: "run-2", pid: 200, identity: "worker-start"},
		{name: "reused worker pid", runID: "run-1", pid: 200, identity: "other-start"},
		{name: "foreign worker", runID: "run-1", pid: 201, identity: "worker-start"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := runOwnsProcess(listing, tc.runID, tc.pid, tc.identity); got != tc.want {
				t.Fatalf("runOwnsProcess = %t, want %t", got, tc.want)
			}
		})
	}
	listing.Runs[0].Status = StatusDead
	if runOwnsProcess(listing, "run-1", 200, "worker-start") {
		t.Fatal("dead keeper run still owns its former worker")
	}
}

func TestRunTagActiveRequiresRunAndKeeperIdentity(t *testing.T) {
	listing := Listing{Runs: []RunInfo{{RunID: "run-1", Tag: "review", PID: 100, Identity: "keeper-start", Status: StatusRunning}}}
	if !runTagActive(listing, "review") {
		t.Fatal("active run with a complete keeper identity was not found")
	}
	listing.Runs[0].RunID = ""
	if runTagActive(listing, "review") {
		t.Fatal("tag without run ID was treated as a live run")
	}
	listing.Runs[0].RunID = "run-1"
	listing.Runs[0].Identity = ""
	if runTagActive(listing, "review") {
		t.Fatal("tag without keeper start identity was treated as a live run")
	}
	listing.Runs[0].Identity = "keeper-start"
	listing.Runs[0].Status = StatusDead
	if runTagActive(listing, "review") {
		t.Fatal("dead keeper run was treated as active")
	}
}
