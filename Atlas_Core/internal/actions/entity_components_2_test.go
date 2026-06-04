package actions

import (
	"testing"
)

// TestValidateSensorRefsComponent tests sensor_refs component validation
func TestValidateSensorRefsComponent(t *testing.T) {
	tests := []struct {
		name       string
		sensorRefs interface{}
		wantErr    bool
		errMsg     string
	}{
		{
			name: "valid sensor_refs",
			sensorRefs: []interface{}{
				map[string]interface{}{"sensor_id": "sensor-1", "type": "camera"},
				map[string]interface{}{"sensor_id": "sensor-2", "type": "lidar", "horizontal_fov": 90.0},
			},
			wantErr: false,
		},
		{
			name:       "nil sensor_refs",
			sensorRefs: nil,
			wantErr:    true,
			errMsg:     "sensor_refs: expected array",
		},
		{
			name:       "empty sensor_refs",
			sensorRefs: []interface{}{},
			wantErr:    false,
		},
		{
			name:       "sensor_refs is object",
			sensorRefs: map[string]interface{}{"sensor_id": "sensor-1"},
			wantErr:    true,
			errMsg:     "sensor_refs: expected array",
		},
		{
			name: "sensor_refs missing sensor_id",
			sensorRefs: []interface{}{
				map[string]interface{}{"type": "camera"},
			},
			wantErr: true,
			errMsg:  "sensor_refs[0]: missing required field 'sensor_id'",
		},
		{
			name: "sensor_refs empty sensor_id",
			sensorRefs: []interface{}{
				map[string]interface{}{"sensor_id": "", "type": "camera"},
			},
			wantErr: true,
			errMsg:  "sensor_refs[0].sensor_id: must be non-empty",
		},
		{
			name: "sensor_refs whitespace-only sensor_id",
			sensorRefs: []interface{}{
				map[string]interface{}{"sensor_id": "   ", "type": "camera"},
			},
			wantErr: true,
			errMsg:  "sensor_refs[0].sensor_id: must be non-empty",
		},
		{
			name: "sensor_refs missing type",
			sensorRefs: []interface{}{
				map[string]interface{}{"sensor_id": "sensor-1"},
			},
			wantErr: true,
			errMsg:  "sensor_refs[0]: missing required field 'type'",
		},
		{
			name: "sensor_refs empty type",
			sensorRefs: []interface{}{
				map[string]interface{}{"sensor_id": "sensor-1", "type": ""},
			},
			wantErr: true,
			errMsg:  "sensor_refs[0].type: must be non-empty",
		},
		{
			name: "sensor_refs whitespace-only type",
			sensorRefs: []interface{}{
				map[string]interface{}{"sensor_id": "sensor-1", "type": "\t"},
			},
			wantErr: true,
			errMsg:  "sensor_refs[0].type: must be non-empty",
		},
		{
			name: "sensor_refs invalid fov field",
			sensorRefs: []interface{}{
				map[string]interface{}{"sensor_id": "sensor-1", "type": "camera", "horizontal_fov": "90"},
			},
			wantErr: true,
			errMsg:  "sensor_refs[0].horizontal_fov: expected number",
		},
		{
			name: "sensor_refs legacy fov alias rejected",
			sensorRefs: []interface{}{
				map[string]interface{}{"sensor_id": "sensor-1", "type": "camera", "fov_horizontal": 90.0},
			},
			wantErr: true,
			errMsg:  "sensor_refs[0]: unknown field 'fov_horizontal'",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateSensorRefsComponent(tt.sensorRefs), tt.wantErr, tt.errMsg)
		})
	}
}

// TestValidateCommunicationsComponent tests communications component validation
func TestValidateCommunicationsComponent(t *testing.T) {
	tests := []struct {
		name    string
		comms   map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name:    "valid link_state connected",
			comms:   map[string]interface{}{"link_state": "connected"},
			wantErr: false,
		},
		{
			name:    "valid link_state disconnected",
			comms:   map[string]interface{}{"link_state": "disconnected"},
			wantErr: false,
		},
		{
			name:    "valid link_state degraded",
			comms:   map[string]interface{}{"link_state": "degraded"},
			wantErr: false,
		},
		{
			name:    "valid link_state unknown",
			comms:   map[string]interface{}{"link_state": "unknown"},
			wantErr: false,
		},
		{
			name:    "invalid link_state",
			comms:   map[string]interface{}{"link_state": "offline"},
			wantErr: true,
			errMsg:  "communications.link_state: must be one of",
		},
		{
			name:    "link_state is number",
			comms:   map[string]interface{}{"link_state": 1},
			wantErr: true,
			errMsg:  "communications.link_state: expected string",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateCommunicationsComponent(tt.comms), tt.wantErr, tt.errMsg)
		})
	}
}

// TestValidateTaskQueueComponent tests task_queue component validation
func TestValidateTaskQueueComponent(t *testing.T) {
	tests := []struct {
		name    string
		queue   map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid task_queue",
			queue: map[string]interface{}{
				"current_task_id": "task-1",
				"queued_task_ids": []interface{}{"task-2", "task-3"},
			},
			wantErr: false,
		},
		{
			name:    "empty task_queue",
			queue:   map[string]interface{}{},
			wantErr: false,
		},
		{
			name: "null current_task_id",
			queue: map[string]interface{}{
				"current_task_id": nil,
			},
			wantErr: false,
		},
		{
			name: "current_task_id is number",
			queue: map[string]interface{}{
				"current_task_id": 123,
			},
			wantErr: true,
			errMsg:  "task_queue.current_task_id: expected string or null",
		},
		{
			name: "queued_task_ids is string",
			queue: map[string]interface{}{
				"queued_task_ids": "task-1",
			},
			wantErr: true,
			errMsg:  "task_queue.queued_task_ids: expected array of strings",
		},
		{
			name: "queued_task_ids contains number",
			queue: map[string]interface{}{
				"queued_task_ids": []interface{}{"task-1", 123},
			},
			wantErr: true,
			errMsg:  "task_queue.queued_task_ids[1]: expected string",
		},
		{
			name: "current_task_id empty string",
			queue: map[string]interface{}{
				"current_task_id": "",
			},
			wantErr: true,
			errMsg:  "task_queue.current_task_id: must be non-empty when provided",
		},
		{
			name: "current_task_id whitespace only",
			queue: map[string]interface{}{
				"current_task_id": "   ",
			},
			wantErr: true,
			errMsg:  "task_queue.current_task_id: must be non-empty when provided",
		},
		{
			name: "queued_task_ids empty string entry",
			queue: map[string]interface{}{
				"queued_task_ids": []interface{}{"task-1", ""},
			},
			wantErr: true,
			errMsg:  "task_queue.queued_task_ids[1]: must be non-empty",
		},
		{
			name: "queued_task_ids whitespace entry",
			queue: map[string]interface{}{
				"queued_task_ids": []interface{}{"task-1", "\t"},
			},
			wantErr: true,
			errMsg:  "task_queue.queued_task_ids[1]: must be non-empty",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateTaskQueueComponent(tt.queue), tt.wantErr, tt.errMsg)
		})
	}
}
