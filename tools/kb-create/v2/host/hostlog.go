package host

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// The host's structured log is owned by the platform logger adapter, which
// writes a bounded rotating file at the path the launcher passes in
// contracts.HostLogFileEnv (x279b); the launcher declares no budget for it.
//
// host.log is only the raw fd 1/2 residue (crash traces, console output, Node
// warnings). The host writes it straight into a plain file, never through a
// pipe the launcher drains, so a host that outlives its launcher keeps logging.
// The launcher bounds that file at each Start.
const HostResidueLogBytes int64 = 4 << 20

// boundResidueLog moves the residue file aside (replacing the previous
// generation) when it is over limit, so it and its predecessor together stay
// within 2×limit plus what one run writes.
func boundResidueLog(path string, limit int64) error {
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Size() <= limit {
		return nil
	}
	return os.Rename(path, path+".1")
}

// residueTail reads what the host wrote to the residue file after offset.
func residueTail(path string, offset int64) *tailBuffer {
	tail := &tailBuffer{limit: startupStderrLimit}
	file, err := os.Open(path)
	if err != nil {
		return tail
	}
	defer file.Close()
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return tail
	}
	if data, err := io.ReadAll(io.LimitReader(file, 1<<20)); err == nil {
		_, _ = tail.Write(data)
	}
	return tail
}

// pino's numeric level for warn; a startup diagnostic carries warn and above.
const structuredTailMinLevel = 40

var structuredLevelNames = map[int]string{40: "WARN", 50: "ERROR", 60: "FATAL"}

// structuredTail renders, as readable lines, the warn-and-above records the
// host's platform logger wrote to its structured log after offset. A file
// shorter than offset was rotated by the logger since the offset was taken, so
// it is read from its start. Lines that are not JSON log records are skipped.
func structuredTail(path string, offset int64) *tailBuffer {
	tail := &tailBuffer{limit: startupStderrLimit}
	file, err := os.Open(path)
	if err != nil {
		return tail
	}
	defer file.Close()
	if info, err := file.Stat(); err != nil || info.Size() < offset {
		offset = 0
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return tail
	}
	data, err := io.ReadAll(io.LimitReader(file, 1<<20))
	if err != nil {
		return tail
	}
	for _, line := range bytes.Split(data, []byte("\n")) {
		var record struct {
			Level   int    `json:"level"`
			Time    int64  `json:"time"`
			Msg     string `json:"msg"`
			Message string `json:"message"`
			Err     *struct {
				Message string `json:"message"`
			} `json:"err"`
		}
		if json.Unmarshal(bytes.TrimSpace(line), &record) != nil || record.Level < structuredTailMinLevel {
			continue
		}
		name := structuredLevelNames[record.Level]
		if name == "" {
			name = "ERROR"
		}
		message := record.Msg
		if message == "" {
			message = record.Message
		}
		if record.Err != nil && record.Err.Message != "" {
			message = strings.TrimSpace(message + ": " + record.Err.Message)
		}
		_, _ = tail.Write([]byte(fmt.Sprintf("%s %s %s\n", time.UnixMilli(record.Time).UTC().Format(time.RFC3339), name, message)))
	}
	return tail
}
