// Package metrics reads host resource usage from /proc and statfs (Linux).
package metrics

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Sample is one point-in-time reading. Percentages are 0..100.
type Sample struct {
	CPU    float64 `json:"cpu"`
	Mem    float64 `json:"mem"`
	Disk   float64 `json:"disk"`
	Load1  float64 `json:"load1"`
	Uptime int64   `json:"uptime"`
}

type cpuTimes struct{ idle, total uint64 }

func readCPU() (cpuTimes, bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuTimes{}, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return cpuTimes{}, false
	}
	fields := strings.Fields(sc.Text())
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuTimes{}, false
	}
	var total, idle uint64
	for i := 1; i < len(fields); i++ {
		v, err := strconv.ParseUint(fields[i], 10, 64)
		if err != nil {
			continue
		}
		total += v
		if i == 4 || i == 5 { // idle + iowait
			idle += v
		}
	}
	return cpuTimes{idle: idle, total: total}, true
}

func memPercent() float64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	var total, avail float64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		v, _ := strconv.ParseFloat(fields[1], 64)
		switch fields[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			avail = v
		}
	}
	if total == 0 {
		return 0
	}
	return (total - avail) / total * 100
}

func diskPercent(path string) float64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	total := float64(st.Blocks) * float64(st.Bsize)
	free := float64(st.Bavail) * float64(st.Bsize)
	if total == 0 {
		return 0
	}
	return (total - free) / total * 100
}

func firstFloat(path string) float64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return v
}

// Collect samples CPU over a short interval and reads the rest instantly.
func Collect() Sample {
	c1, ok1 := readCPU()
	time.Sleep(200 * time.Millisecond)
	c2, ok2 := readCPU()
	cpu := 0.0
	if ok1 && ok2 && c2.total > c1.total {
		dt := float64(c2.total - c1.total)
		di := float64(c2.idle - c1.idle)
		cpu = (dt - di) / dt * 100
	}
	if cpu < 0 {
		cpu = 0
	}
	return Sample{
		CPU:    round1(cpu),
		Mem:    round1(memPercent()),
		Disk:   round1(diskPercent("/")),
		Load1:  firstFloat("/proc/loadavg"),
		Uptime: int64(firstFloat("/proc/uptime")),
	}
}

func round1(v float64) float64 {
	return float64(int(v*10+0.5)) / 10
}
