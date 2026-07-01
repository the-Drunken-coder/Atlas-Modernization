package handlers

import (
	"context"
	"math"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const resourceCPUSampleInterval = 100 * time.Millisecond

type resourcesResponse struct {
	Service   string           `json:"service"`
	Timestamp string           `json:"timestamp"`
	CPU       cpuResources     `json:"cpu"`
	Memory    memoryResources  `json:"memory"`
	Disk      diskResources    `json:"disk"`
	Process   processResources `json:"process"`
}

type cpuResources struct {
	Cores                   int      `json:"cores"`
	UsagePercent            *float64 `json:"usage_percent,omitempty"`
	LoadAverage1m           *float64 `json:"load_average_1m,omitempty"`
	LoadAverage1mPerCore    *float64 `json:"load_average_1m_per_core,omitempty"`
	MeasurementWindowMillis int      `json:"measurement_window_ms"`
}

type memoryResources struct {
	TotalBytes     *uint64  `json:"total_bytes,omitempty"`
	AvailableBytes *uint64  `json:"available_bytes,omitempty"`
	UsedBytes      *uint64  `json:"used_bytes,omitempty"`
	UsedPercent    *float64 `json:"used_percent,omitempty"`
}

type diskResources struct {
	Path        string  `json:"path"`
	TotalBytes  uint64  `json:"total_bytes"`
	FreeBytes   uint64  `json:"free_bytes"`
	UsedBytes   uint64  `json:"used_bytes"`
	UsedPercent float64 `json:"used_percent"`
}

type processResources struct {
	Goroutines      int    `json:"goroutines"`
	AllocBytes      uint64 `json:"alloc_bytes"`
	SysBytes        uint64 `json:"sys_bytes"`
	HeapAllocBytes  uint64 `json:"heap_alloc_bytes"`
	HeapSysBytes    uint64 `json:"heap_sys_bytes"`
	HeapIdleBytes   uint64 `json:"heap_idle_bytes"`
	HeapInuseBytes  uint64 `json:"heap_inuse_bytes"`
	NumGC           uint32 `json:"num_gc"`
	PauseTotalNanos uint64 `json:"pause_total_ns"`
}

type cpuSnapshot struct {
	idle  uint64
	total uint64
}

// Resources handles GET /resources with lightweight host and process usage metrics.
func (h *Handler) Resources(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, collectResources(r.Context(), time.Now().UTC(), "/"))
}

func collectResources(ctx context.Context, now time.Time, diskPath string) resourcesResponse {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	return resourcesResponse{
		Service:   "atlas-core",
		Timestamp: now.Format(time.RFC3339),
		CPU:       collectCPUResources(ctx),
		Memory:    collectMemoryResources(),
		Disk:      collectDiskResources(diskPath),
		Process: processResources{
			Goroutines:      runtime.NumGoroutine(),
			AllocBytes:      mem.Alloc,
			SysBytes:        mem.Sys,
			HeapAllocBytes:  mem.HeapAlloc,
			HeapSysBytes:    mem.HeapSys,
			HeapIdleBytes:   mem.HeapIdle,
			HeapInuseBytes:  mem.HeapInuse,
			NumGC:           mem.NumGC,
			PauseTotalNanos: mem.PauseTotalNs,
		},
	}
}

func collectCPUResources(ctx context.Context) cpuResources {
	cpu := cpuResources{
		Cores:                   runtime.NumCPU(),
		MeasurementWindowMillis: int(resourceCPUSampleInterval / time.Millisecond),
	}

	if usage, err := linuxCPUUsagePercent(ctx, resourceCPUSampleInterval); err == nil {
		cpu.UsagePercent = &usage
	}
	if loadAverage, err := linuxLoadAverage1m(); err == nil {
		cpu.LoadAverage1m = &loadAverage
		if cpu.Cores > 0 {
			perCore := roundPercent(loadAverage / float64(cpu.Cores))
			cpu.LoadAverage1mPerCore = &perCore
		}
	}

	return cpu
}

func collectMemoryResources() memoryResources {
	total, available, err := linuxMemoryBytes()
	if err != nil {
		return memoryResources{}
	}

	used := total - available
	usedPercent := percent(used, total)
	return memoryResources{
		TotalBytes:     &total,
		AvailableBytes: &available,
		UsedBytes:      &used,
		UsedPercent:    &usedPercent,
	}
}

func collectDiskResources(path string) diskResources {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return diskResources{Path: path}
	}

	blockSize := uint64(stat.Bsize)
	total := stat.Blocks * blockSize
	free := stat.Bavail * blockSize
	if free > total {
		free = total
	}
	used := total - free

	return diskResources{
		Path:        path,
		TotalBytes:  total,
		FreeBytes:   free,
		UsedBytes:   used,
		UsedPercent: percent(used, total),
	}
}

func linuxCPUUsagePercent(ctx context.Context, window time.Duration) (float64, error) {
	first, err := readLinuxCPUSnapshot()
	if err != nil {
		return 0, err
	}

	timer := time.NewTimer(window)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-timer.C:
	}

	second, err := readLinuxCPUSnapshot()
	if err != nil {
		return 0, err
	}

	return cpuUsagePercent(first, second), nil
}

func readLinuxCPUSnapshot() (cpuSnapshot, error) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuSnapshot{}, err
	}

	line, _, _ := strings.Cut(string(data), "\n")
	return parseCPUSnapshot(line)
}

func parseCPUSnapshot(line string) (cpuSnapshot, error) {
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuSnapshot{}, strconv.ErrSyntax
	}

	var total uint64
	values := make([]uint64, 0, len(fields)-1)
	for _, field := range fields[1:] {
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return cpuSnapshot{}, err
		}
		values = append(values, value)
		total += value
	}

	idle := values[3]
	if len(values) > 4 {
		idle += values[4]
	}
	return cpuSnapshot{idle: idle, total: total}, nil
}

func cpuUsagePercent(first, second cpuSnapshot) float64 {
	if second.total <= first.total || second.idle < first.idle {
		return 0
	}
	totalDelta := second.total - first.total
	if totalDelta == 0 {
		return 0
	}
	idleDelta := second.idle - first.idle
	if idleDelta > totalDelta {
		return 0
	}
	return percent(totalDelta-idleDelta, totalDelta)
}

func linuxLoadAverage1m() (float64, error) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, err
	}

	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, strconv.ErrSyntax
	}
	return strconv.ParseFloat(fields[0], 64)
}

func linuxMemoryBytes() (uint64, uint64, error) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	return parseMeminfoBytes(string(data))
}

func parseMeminfoBytes(data string) (uint64, uint64, error) {
	values := map[string]uint64{}
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, 0, err
		}
		values[key] = value * 1024
	}

	total, ok := values["MemTotal"]
	if !ok {
		return 0, 0, strconv.ErrSyntax
	}
	available, ok := values["MemAvailable"]
	if !ok {
		return 0, 0, strconv.ErrSyntax
	}
	if available > total {
		available = total
	}

	return total, available, nil
}

func percent(part, total uint64) float64 {
	if total == 0 {
		return 0
	}
	return roundPercent(float64(part) / float64(total) * 100)
}

func roundPercent(value float64) float64 {
	return math.Round(value*100) / 100
}
