package models

import (
	"encoding/json"
	"testing"
	"time"
)

func entityWithJSON(jsonStr string) *Entity {
	e := &Entity{}
	if jsonStr != "" {
		e.JSON = json.RawMessage(jsonStr)
	}
	return e
}

func taskWithJSON(jsonStr string) *Task {
	task := &Task{}
	if jsonStr != "" {
		task.JSON = json.RawMessage(jsonStr)
	}
	return task
}

func TestEntity_GetTelemetry(t *testing.T) {
	tests := []struct {
		name     string
		json     string
		wantNil  bool
		checkLat float64
	}{
		{
			name:     "valid telemetry",
			json:     `{"components":{"telemetry":{"latitude":37.7749,"longitude":-122.4194,"altitude_m":100.5}}}`,
			wantNil:  false,
			checkLat: 37.7749,
		},
		{
			name:    "missing telemetry component",
			json:    `{"components":{"status":{"value":"active"}}}`,
			wantNil: true,
		},
		{
			name:    "missing components",
			json:    `{}`,
			wantNil: true,
		},
		{
			name:    "nil JSON",
			json:    "",
			wantNil: true,
		},
		{
			name:    "invalid telemetry format",
			json:    `{"components":{"telemetry":"not an object"}}`,
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := entityWithJSON(tt.json).GetTelemetry()
			if tt.wantNil {
				if got != nil {
					t.Errorf("GetTelemetry() = %v, want nil", got)
				}
				return
			}

			if got == nil {
				t.Fatal("GetTelemetry() = nil, want non-nil")
			}
			if got.Latitude == nil || *got.Latitude != tt.checkLat {
				t.Errorf("GetTelemetry().Latitude = %v, want %v", got.Latitude, tt.checkLat)
			}
		})
	}
}

func TestEntity_GetStatus(t *testing.T) {
	tests := []struct {
		name     string
		json     string
		wantNil  bool
		checkVal string
	}{
		{
			name:     "valid status",
			json:     `{"components":{"status":{"value":"active"}}}`,
			wantNil:  false,
			checkVal: "active",
		},
		{
			name:    "missing status component",
			json:    `{"components":{"telemetry":{"latitude":0}}}`,
			wantNil: true,
		},
		{
			name:    "missing components",
			json:    `{}`,
			wantNil: true,
		},
		{
			name:    "nil JSON",
			json:    "",
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := entityWithJSON(tt.json).GetStatus()
			if tt.wantNil {
				if got != nil {
					t.Errorf("GetStatus() = %v, want nil", got)
				}
				return
			}

			if got == nil {
				t.Fatal("GetStatus() = nil, want non-nil")
			}
			if got.Value != tt.checkVal {
				t.Errorf("GetStatus().Value = %v, want %v", got.Value, tt.checkVal)
			}
		})
	}
}

func TestEntity_GetHeartbeat(t *testing.T) {
	tests := []struct {
		name     string
		json     string
		wantNil  bool
		wantTime time.Time
	}{
		{
			name:     "valid heartbeat",
			json:     `{"components":{"heartbeat":{"last_seen":"2024-01-15T10:30:00Z"}}}`,
			wantNil:  false,
			wantTime: time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC),
		},
		{
			name:    "missing heartbeat component",
			json:    `{"components":{"status":{"value":"active"}}}`,
			wantNil: true,
		},
		{
			name:    "missing components",
			json:    `{}`,
			wantNil: true,
		},
		{
			name:    "nil JSON",
			json:    "",
			wantNil: true,
		},
		{
			name:    "invalid heartbeat format - missing last_seen",
			json:    `{"components":{"heartbeat":{}}}`,
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := entityWithJSON(tt.json).GetHeartbeat()
			if tt.wantNil {
				if got != nil {
					t.Errorf("GetHeartbeat() = %v, want nil", got)
				}
				return
			}

			if got == nil {
				t.Fatal("GetHeartbeat() = nil, want non-nil")
			}
			if !got.LastSeen.Equal(tt.wantTime) {
				t.Errorf("GetHeartbeat().LastSeen = %v, want %v", got.LastSeen, tt.wantTime)
			}
		})
	}
}

func TestTask_GetCommand(t *testing.T) {
	tests := []struct {
		name       string
		json       string
		wantNil    bool
		checkType  string
		wantTarget map[string]float64
	}{
		{
			name:       "valid command",
			json:       `{"components":{"command":{"type":"move","target":{"latitude":40.1,"longitude":-74.2}}}}`,
			wantNil:    false,
			checkType:  "move",
			wantTarget: map[string]float64{"latitude": 40.1, "longitude": -74.2},
		},
		{
			name:    "missing command component",
			json:    `{"components":{"other":{}}}`,
			wantNil: true,
		},
		{
			name:    "missing components",
			json:    `{}`,
			wantNil: true,
		},
		{
			name:    "nil JSON",
			json:    "",
			wantNil: true,
		},
		{
			name:    "empty command object (missing type)",
			json:    `{"components":{"command":{}}}`,
			wantNil: true,
		},
		{
			name:    "malformed command target",
			json:    `{"components":{"command":{"type":"move","target":"latitude=40.1,longitude=-74.2"}}}`,
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := taskWithJSON(tt.json).GetCommand()
			if tt.wantNil {
				if got != nil {
					t.Errorf("GetCommand() = %v, want nil", got)
				}
				return
			}

			if got == nil {
				t.Fatal("GetCommand() = nil, want non-nil")
			}
			if got.Type != tt.checkType {
				t.Errorf("GetCommand().Type = %v, want %v", got.Type, tt.checkType)
			}
			for key, want := range tt.wantTarget {
				gotValue, ok := got.Target[key].(float64)
				if !ok {
					t.Errorf("GetCommand().Target[%q] = %T(%v), want float64", key, got.Target[key], got.Target[key])
					continue
				}
				if gotValue != want {
					t.Errorf("GetCommand().Target[%q] = %v, want %v", key, gotValue, want)
				}
			}
		})
	}
}

func TestTask_GetResult(t *testing.T) {
	tests := []struct {
		name         string
		json         string
		wantNil      bool
		checkSuccess bool
	}{
		{
			name:         "valid result",
			json:         `{"result":{"success":true,"description":"Operation completed"}}`,
			wantNil:      false,
			checkSuccess: true,
		},
		{
			name:    "missing result",
			json:    `{"error":{"code":"ERR001"}}`,
			wantNil: true,
		},
		{
			name:    "empty JSON",
			json:    `{}`,
			wantNil: true,
		},
		{
			name:    "nil JSON",
			json:    "",
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := taskWithJSON(tt.json).GetResult()
			if tt.wantNil {
				if got != nil {
					t.Errorf("GetResult() = %v, want nil", got)
				}
				return
			}

			if got == nil {
				t.Fatal("GetResult() = nil, want non-nil")
			}
			if got.Success != tt.checkSuccess {
				t.Errorf("GetResult().Success = %v, want %v", got.Success, tt.checkSuccess)
			}
		})
	}
}

func TestTask_GetError(t *testing.T) {
	tests := []struct {
		name      string
		json      string
		wantNil   bool
		checkCode string
	}{
		{
			name:      "valid error",
			json:      `{"error":{"code":"ERR001","message":"Something went wrong"}}`,
			wantNil:   false,
			checkCode: "ERR001",
		},
		{
			name:    "missing error",
			json:    `{"result":{"success":true}}`,
			wantNil: true,
		},
		{
			name:    "empty JSON",
			json:    `{}`,
			wantNil: true,
		},
		{
			name:    "nil JSON",
			json:    "",
			wantNil: true,
		},
		{
			name:    "error object with empty code and message",
			json:    `{"error":{"code":"","message":""}}`,
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := taskWithJSON(tt.json).GetError()
			if tt.wantNil {
				if got != nil {
					t.Errorf("GetError() = %v, want nil", got)
				}
				return
			}

			if got == nil {
				t.Fatal("GetError() = nil, want non-nil")
			}
			if got.Code != tt.checkCode {
				t.Errorf("GetError().Code = %v, want %v", got.Code, tt.checkCode)
			}
		})
	}
}

func TestTask_GetProgress(t *testing.T) {
	tests := []struct {
		name          string
		json          string
		wantNil       bool
		checkProgress float64
	}{
		{
			name:          "valid progress",
			json:          `{"components":{"progress":{"percent":75}}}`,
			wantNil:       false,
			checkProgress: 75,
		},
		{
			name:    "missing progress",
			json:    `{"result":{"success":true}}`,
			wantNil: true,
		},
		{
			name:    "empty JSON",
			json:    `{}`,
			wantNil: true,
		},
		{
			name:    "nil JSON",
			json:    "",
			wantNil: true,
		},
		{
			name:    "invalid progress type",
			json:    `{"components":{"progress":"not an object"}}`,
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := taskWithJSON(tt.json).GetProgress()
			if tt.wantNil {
				if got != nil {
					t.Errorf("GetProgress() = %v, want nil", got)
				}
				return
			}

			if got == nil {
				t.Fatal("GetProgress() = nil, want non-nil")
			}
			if *got != tt.checkProgress {
				t.Errorf("GetProgress() = %v, want %v", *got, tt.checkProgress)
			}
		})
	}
}

func TestTask_GetProgress_IgnoresLegacyExtraProgress(t *testing.T) {
	tests := []struct {
		name          string
		json          string
		wantNil       bool
		checkProgress float64
	}{
		{
			name:          "components.progress.percent is used",
			json:          `{"components":{"progress":{"percent":42}},"progress":7}`,
			checkProgress: 42,
		},
		{
			name:    "top-level progress is ignored",
			json:    `{"progress":7}`,
			wantNil: true,
		},
		{
			name:          "canonical components.progress.percent alone",
			json:          `{"components":{"progress":{"percent":55.5}}}`,
			checkProgress: 55.5,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := taskWithJSON(tt.json).GetProgress()
			if tt.wantNil {
				if got != nil {
					t.Errorf("GetProgress() = %v, want nil", got)
				}
				return
			}
			if got == nil {
				t.Fatal("GetProgress() = nil, want non-nil")
			}
			if *got != tt.checkProgress {
				t.Errorf("GetProgress() = %v, want %v", *got, tt.checkProgress)
			}
		})
	}
}

func TestEntity_GetTelemetry_CanonicalSpeed(t *testing.T) {
	tests := []struct {
		name      string
		json      string
		wantSpeed *float64
	}{
		{
			name:      "canonical speed_m_s",
			json:      `{"components":{"telemetry":{"speed_m_s":9}}}`,
			wantSpeed: ptrFloat(9),
		},
		{
			name:      "no speed field",
			json:      `{"components":{"telemetry":{"latitude":1.0}}}`,
			wantSpeed: nil,
		},
		{
			name:      "legacy speed_ms ignored",
			json:      `{"components":{"telemetry":{"speed_ms":9}}}`,
			wantSpeed: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := entityWithJSON(tt.json).GetTelemetry()
			if got == nil {
				t.Fatal("GetTelemetry() = nil, want non-nil")
			}
			switch {
			case tt.wantSpeed == nil && got.SpeedMS != nil:
				t.Errorf("SpeedMS = %v, want nil", *got.SpeedMS)
			case tt.wantSpeed != nil && got.SpeedMS == nil:
				t.Errorf("SpeedMS = nil, want %v", *tt.wantSpeed)
			case tt.wantSpeed != nil && got.SpeedMS != nil && *got.SpeedMS != *tt.wantSpeed:
				t.Errorf("SpeedMS = %v, want %v", *got.SpeedMS, *tt.wantSpeed)
			}
		})
	}
}

func ptrFloat(f float64) *float64 { return &f }
