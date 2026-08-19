// This file is the authored Go API for Atlas Protocol. go run ./tools/check
// verifies its JSON fields, field types, optionality, and enums against the
// canonical JSON Schema.

package atlasprotocol

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/the-drunken-coder/atlas/atlas_protocol/validator"
)

type JSONValue = any

type ResourceType string

const (
	ResourceTypeEntity ResourceType = "entity"
	ResourceTypeTask   ResourceType = "task"
	ResourceTypeObject ResourceType = "object"
)

type FeedEventName string

const (
	FeedEventCreate FeedEventName = "create"
	FeedEventUpdate FeedEventName = "update"
	FeedEventDelete FeedEventName = "delete"
)

type ErrorCode string

const (
	ErrorCodeValidationError        ErrorCode = "VALIDATION_ERROR"
	ErrorCodeInvalidJSON            ErrorCode = "INVALID_JSON"
	ErrorCodeBodyTooLarge           ErrorCode = "BODY_TOO_LARGE"
	ErrorCodeInvalidForm            ErrorCode = "INVALID_FORM"
	ErrorCodeUnauthorized           ErrorCode = "UNAUTHORIZED"
	ErrorCodeTooManyAttempts        ErrorCode = "TOO_MANY_ATTEMPTS"
	ErrorCodeFeedUnavailable        ErrorCode = "FEED_UNAVAILABLE"
	ErrorCodeStorageUnavailable     ErrorCode = "STORAGE_UNAVAILABLE"
	ErrorCodeStorageError           ErrorCode = "STORAGE_ERROR"
	ErrorCodeContentTypeNotViewable ErrorCode = "CONTENT_TYPE_NOT_VIEWABLE"
	ErrorCodeFileTooLarge           ErrorCode = "FILE_TOO_LARGE"
	ErrorCodeReadError              ErrorCode = "READ_ERROR"
	ErrorCodeInternalServerError    ErrorCode = "INTERNAL_SERVER_ERROR"
	ErrorCodeEntityNotFound         ErrorCode = "ENTITY_NOT_FOUND"
	ErrorCodeEntityAliasNotFound    ErrorCode = "ENTITY_ALIAS_NOT_FOUND"
	ErrorCodeTaskNotFound           ErrorCode = "TASK_NOT_FOUND"
	ErrorCodeObjectNotFound         ErrorCode = "OBJECT_NOT_FOUND"
	ErrorCodeBucketNotFound         ErrorCode = "BUCKET_NOT_FOUND"
	ErrorCodeEntityAlreadyExists    ErrorCode = "ENTITY_ALREADY_EXISTS"
	ErrorCodeTaskAlreadyExists      ErrorCode = "TASK_ALREADY_EXISTS"
	ErrorCodeObjectAlreadyExists    ErrorCode = "OBJECT_ALREADY_EXISTS"
	ErrorCodeObjectPathConflict     ErrorCode = "OBJECT_PATH_CONFLICT"
	ErrorCodeCursorExpired          ErrorCode = "CURSOR_EXPIRED"
	ErrorCodePreconditionFailed     ErrorCode = "PRECONDITION_FAILED"
)

// ErrorResponse is exported so HTTP handlers can attach request metadata.
// Prefer NewErrorResponse for base responses; MarshalJSON enforces the Atlas
// Protocol error contract before a response is sent.
type ErrorResponse struct {
	Success   bool                 `json:"success"`
	Message   string               `json:"message"`
	ErrorCode ErrorCode            `json:"error_code"`
	ErrorID   string               `json:"error_id,omitempty"`
	Timestamp string               `json:"timestamp,omitempty"`
	Path      string               `json:"path,omitempty"`
	Details   map[string]JSONValue `json:"details,omitempty"`
}

func NewErrorResponse(message string, code ErrorCode) (ErrorResponse, error) {
	response := ErrorResponse{
		Success:   false,
		Message:   message,
		ErrorCode: code,
	}
	if _, err := json.Marshal(response); err != nil {
		return ErrorResponse{}, err
	}
	return response, nil
}

func (e ErrorResponse) MarshalJSON() ([]byte, error) {
	type errorResponseAlias ErrorResponse
	data, err := json.Marshal(errorResponseAlias(e))
	if err != nil {
		return nil, err
	}
	if errors := validator.ValidateErrorResponse(json.RawMessage(data)); len(errors) > 0 {
		return nil, fmt.Errorf("invalid ErrorResponse: %s", strings.Join(errors, "; "))
	}
	return data, nil
}

type FeedAction string

const (
	FeedActionAuth                FeedAction = "auth"
	FeedActionSubscribe           FeedAction = "subscribe"
	FeedActionSubscriptionBarrier FeedAction = "subscription_barrier"
	FeedActionUnsubscribe         FeedAction = "unsubscribe"
)

type FeedFilter string

const (
	FeedFilterAll           FeedFilter = "all"
	FeedFilterID            FeedFilter = "id"
	FeedFilterType          FeedFilter = "type"
	FeedFilterTasksForAsset FeedFilter = "tasks_for_asset"
)

type CommandScheduling string

const (
	CommandSchedulingImmediate CommandScheduling = "immediate"
	CommandSchedulingQueued    CommandScheduling = "queued"
)

type TaskStatus string

const (
	TaskStatusAcknowledged TaskStatus = "acknowledged"
	TaskStatusCancelled    TaskStatus = "cancelled"
	TaskStatusCompleted    TaskStatus = "completed"
	TaskStatusFailed       TaskStatus = "failed"
	TaskStatusInProgress   TaskStatus = "in_progress"
	TaskStatusPending      TaskStatus = "pending"
)

type TaskFailureCode string

const (
	TaskFailureCodeAssetRestarted        TaskFailureCode = "asset_restarted"
	TaskFailureCodeExecutionFailed       TaskFailureCode = "execution_failed"
	TaskFailureCodeImmediateStartTimeout TaskFailureCode = "immediate_start_timeout"
	TaskFailureCodeInvalidOutput         TaskFailureCode = "invalid_output"
	TaskFailureCodePreconditionFailed    TaskFailureCode = "precondition_failed"
	TaskFailureCodeUnsupportedCommand    TaskFailureCode = "unsupported_command"
)

type TaskCancellationCode string

const (
	TaskCancellationCodeRequested  TaskCancellationCode = "requested"
	TaskCancellationCodeSuperseded TaskCancellationCode = "superseded"
)

type MetadataBlock struct {
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	Version   int64  `json:"version"`
}

type CommandDefinition struct {
	Command      string            `json:"command"`
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	InputSchema  string            `json:"input_schema"`
	OutputSchema string            `json:"output_schema,omitempty"`
	Scheduling   CommandScheduling `json:"scheduling,omitempty"`
}

// CommandCatalog is the Protocol-owned aggregate served by Atlas Core.
type CommandCatalog = []CommandDefinition

type CommandManifestEntry struct {
	Command          string            `json:"command"`
	Description      string            `json:"description"`
	Scheduling       CommandScheduling `json:"scheduling"`
	SupportsCancel   bool              `json:"supports_cancel"`
	SupportsProgress bool              `json:"supports_progress"`
}

// CommandManifest is the fixed set of Commands advertised by a ready runtime.
type CommandManifest = []CommandManifestEntry

type ProtocolRevisionResponse struct {
	ProtocolRevision string `json:"protocol_revision"`
}

type EntityCheckInRequest struct {
	Status     *string              `json:"status,omitempty"`
	Latitude   *float64             `json:"latitude,omitempty"`
	Longitude  *float64             `json:"longitude,omitempty"`
	AltitudeM  *float64             `json:"altitude_m,omitempty"`
	SpeedMS    *float64             `json:"speed_m_s,omitempty"`
	HeadingDeg *float64             `json:"heading_deg,omitempty"`
	Components map[string]JSONValue `json:"components,omitempty"`
}

type EntityResource struct {
	EntityID        string               `json:"entity_id"`
	EntityType      string               `json:"entity_type"`
	Subtype         *string              `json:"subtype"`
	Alias           *string              `json:"alias"`
	CommandManifest *CommandManifest     `json:"command_manifest,omitempty"`
	Components      map[string]JSONValue `json:"components"`
	Metadata        MetadataBlock        `json:"metadata"`
	Extra           map[string]JSONValue `json:"extra,omitempty"`
}

type TaskResource struct {
	TaskID         string            `json:"task_id"`
	AssetID        string            `json:"asset_id"`
	Command        string            `json:"command"`
	Input          JSONValue         `json:"input"`
	Status         TaskStatus        `json:"status"`
	Progress       *float64          `json:"progress,omitempty"`
	Output         JSONValue         `json:"output,omitempty"`
	Failure        *TaskFailure      `json:"failure,omitempty"`
	Cancellation   *TaskCancellation `json:"cancellation,omitempty"`
	CreatedAt      string            `json:"created_at"`
	AcknowledgedAt string            `json:"acknowledged_at,omitempty"`
	StartedAt      string            `json:"started_at,omitempty"`
	FinishedAt     string            `json:"finished_at,omitempty"`
	UpdatedAt      string            `json:"updated_at"`
}

type TaskFailure struct {
	Code    TaskFailureCode `json:"code"`
	Message string          `json:"message"`
}

type TaskCancellation struct {
	Code    TaskCancellationCode `json:"code"`
	Message string               `json:"message"`
}

type TaskCreateRequest struct {
	AssetID string    `json:"asset_id"`
	Command string    `json:"command"`
	Input   JSONValue `json:"input"`
}

type TaskAcknowledgeRequest struct{}

type TaskStartRequest struct{}

type TaskProgressRequest struct {
	Progress float64 `json:"progress"`
}

type TaskCompleteRequest struct {
	Output JSONValue `json:"output,omitempty"`
}

type TaskFailRequest struct {
	Failure TaskFailure `json:"failure"`
}

type TaskCancelRequest struct {
	Cancellation TaskCancellation `json:"cancellation"`
}

type RuntimeRegistrationRequest struct {
	RuntimeID string `json:"runtime_id"`
}

type RuntimeReadyRequest struct {
	RuntimeID string                 `json:"runtime_id"`
	Manifest  []CommandManifestEntry `json:"manifest"`
}

type RuntimeTaskDeliveryResponse struct {
	Tasks []TaskResource `json:"tasks"`
}

type ObjectReference struct {
	EntityID *string `json:"entity_id,omitempty"`
	TaskID   *string `json:"task_id,omitempty"`
}

type ObjectResource struct {
	ObjectID     string            `json:"object_id"`
	Path         *string           `json:"path"`
	ContentType  *string           `json:"content_type"`
	Type         *string           `json:"type"`
	SizeBytes    *int64            `json:"size_bytes"`
	UsageHints   []string          `json:"usage_hints"`
	ReferencedBy []ObjectReference `json:"referenced_by,omitempty"`
	Bucket       *string           `json:"bucket"`
	Metadata     MetadataBlock     `json:"metadata"`
}

type ObjectDetailResource struct {
	ObjectID     string               `json:"object_id"`
	Path         *string              `json:"path"`
	ContentType  *string              `json:"content_type"`
	Type         *string              `json:"type"`
	SizeBytes    *int64               `json:"size_bytes"`
	UsageHints   []string             `json:"usage_hints"`
	ReferencedBy []ObjectReference    `json:"referenced_by,omitempty"`
	Bucket       *string              `json:"bucket"`
	Metadata     MetadataBlock        `json:"metadata"`
	Extra        map[string]JSONValue `json:"extra"`
}

type EntityCheckInFullResponse struct {
	Entity EntityResource `json:"entity"`
}

type EntityCheckInMinimalResponse struct {
	Entity EntityResource `json:"entity"`
}

type FullDatasetResponse struct {
	Entities         []EntityResource       `json:"entities"`
	Tasks            []TaskResource         `json:"tasks"`
	Objects          []ObjectDetailResource `json:"objects"`
	Version          int64                  `json:"version"`
	HasMoreEntities  bool                   `json:"has_more_entities"`
	HasMoreTasks     bool                   `json:"has_more_tasks"`
	HasMoreObjects   bool                   `json:"has_more_objects"`
	NextEntityCursor string                 `json:"next_entity_cursor,omitempty"`
	NextTaskCursor   string                 `json:"next_task_cursor,omitempty"`
	NextObjectCursor string                 `json:"next_object_cursor,omitempty"`
}

type ChangedSinceResponse struct {
	Events     []FeedEvent `json:"events"`
	Version    int64       `json:"version"`
	HasMore    bool        `json:"has_more"`
	NextCursor string      `json:"next_cursor,omitempty"`
}

type FeedEvent struct {
	Event        FeedEventName `json:"event"`
	ResourceType ResourceType  `json:"resource_type"`
	ID           string        `json:"id"`
	Version      int64         `json:"version"`
	Resource     JSONValue     `json:"resource,omitempty"`
}

func (e FeedEvent) MarshalJSON() ([]byte, error) {
	type feedEventAlias FeedEvent
	data, err := json.Marshal(feedEventAlias(e))
	if err != nil {
		return nil, err
	}
	if err := validateMarshaledFeedEvent("FeedEvent", data); err != nil {
		return nil, err
	}
	return data, nil
}

func validateMarshaledFeedEvent(name string, data []byte) error {
	if errors := validator.ValidateFeedEvent(json.RawMessage(data)); len(errors) > 0 {
		return fmt.Errorf("invalid %s: %s", name, strings.Join(errors, "; "))
	}
	return nil
}

type EntityDeleteEvent struct {
	ID      string `json:"id"`
	Version int64  `json:"version"`
}

func (e EntityDeleteEvent) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(struct {
		Event        FeedEventName `json:"event"`
		ResourceType ResourceType  `json:"resource_type"`
		ID           string        `json:"id"`
		Version      int64         `json:"version"`
	}{
		Event:        FeedEventDelete,
		ResourceType: ResourceTypeEntity,
		ID:           e.ID,
		Version:      e.Version,
	})
	if err != nil {
		return nil, err
	}
	if err := validateMarshaledFeedEvent("EntityDeleteEvent", data); err != nil {
		return nil, err
	}
	return data, nil
}

func (e EntityDeleteEvent) FeedEvent() FeedEvent {
	return FeedEvent{
		Event:        FeedEventDelete,
		ResourceType: ResourceTypeEntity,
		ID:           e.ID,
		Version:      e.Version,
	}
}

type ObjectDeleteEvent struct {
	ID      string `json:"id"`
	Version int64  `json:"version"`
}

func (e ObjectDeleteEvent) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(struct {
		Event        FeedEventName `json:"event"`
		ResourceType ResourceType  `json:"resource_type"`
		ID           string        `json:"id"`
		Version      int64         `json:"version"`
	}{
		Event:        FeedEventDelete,
		ResourceType: ResourceTypeObject,
		ID:           e.ID,
		Version:      e.Version,
	})
	if err != nil {
		return nil, err
	}
	if err := validateMarshaledFeedEvent("ObjectDeleteEvent", data); err != nil {
		return nil, err
	}
	return data, nil
}

func (e ObjectDeleteEvent) FeedEvent() FeedEvent {
	return FeedEvent{
		Event:        FeedEventDelete,
		ResourceType: ResourceTypeObject,
		ID:           e.ID,
		Version:      e.Version,
	}
}

type FeedAuthMessage struct {
	Action FeedAction `json:"action"`
	APIKey string     `json:"api_key"`
}

type feedAuthMessageAlias FeedAuthMessage

func (m FeedAuthMessage) MarshalJSON() ([]byte, error) {
	m.Action = FeedActionAuth
	data, err := json.Marshal(feedAuthMessageAlias(m))
	if err != nil {
		return nil, err
	}
	if errors := validator.ValidateFeedAuthMessage(json.RawMessage(data)); len(errors) > 0 {
		return nil, fmt.Errorf("invalid FeedAuthMessage: %s", strings.Join(errors, "; "))
	}
	return data, nil
}

type FeedSubscriptionMessage struct {
	Action       FeedAction   `json:"action"`
	Filter       FeedFilter   `json:"filter"`
	ResourceType ResourceType `json:"resource_type,omitempty"`
	ID           string       `json:"id,omitempty"`
	AssetID      string       `json:"asset_id,omitempty"`
}

type feedSubscriptionMessageAlias FeedSubscriptionMessage

func (m FeedSubscriptionMessage) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(feedSubscriptionMessageAlias(m))
	if err != nil {
		return nil, err
	}
	if errors := validateFeedSubscriptionMessagePayload(data); len(errors) > 0 {
		return nil, fmt.Errorf("invalid FeedSubscriptionMessage: %s", strings.Join(errors, "; "))
	}
	return data, nil
}

func validateFeedSubscriptionMessagePayload(data []byte) []string {
	var envelope struct {
		Action FeedAction `json:"action"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return []string{err.Error()}
	}
	switch envelope.Action {
	case FeedActionSubscribe:
		return validator.ValidateFeedSubscribeMessage(json.RawMessage(data))
	case FeedActionUnsubscribe:
		return validator.ValidateFeedUnsubscribeMessage(json.RawMessage(data))
	default:
		if errors := validator.ValidateFeedClientMessage(json.RawMessage(data)); len(errors) > 0 {
			return errors
		}
		return []string{fmt.Sprintf("unsupported feed subscription action %q", envelope.Action)}
	}
}

type FeedHandshakeMessage struct {
	Type             string `json:"type"`
	ProtocolRevision string `json:"protocol_revision"`
}

type FeedSubscriptionBarrierMessage struct {
	Action FeedAction `json:"action"`
}

type feedSubscriptionBarrierMessageAlias FeedSubscriptionBarrierMessage

func (m FeedSubscriptionBarrierMessage) MarshalJSON() ([]byte, error) {
	m.Action = FeedActionSubscriptionBarrier
	data, err := json.Marshal(feedSubscriptionBarrierMessageAlias(m))
	if err != nil {
		return nil, err
	}
	if errors := validator.ValidateFeedSubscriptionBarrierMessage(json.RawMessage(data)); len(errors) > 0 {
		return nil, fmt.Errorf("invalid FeedSubscriptionBarrierMessage: %s", strings.Join(errors, "; "))
	}
	return data, nil
}

type FeedSubscriptionsReadyMessage struct {
	Type    string `json:"type"`
	Version int64  `json:"version"`
}

type feedSubscriptionsReadyMessageAlias FeedSubscriptionsReadyMessage

func (m FeedSubscriptionsReadyMessage) MarshalJSON() ([]byte, error) {
	m.Type = "subscriptions_ready"
	data, err := json.Marshal(feedSubscriptionsReadyMessageAlias(m))
	if err != nil {
		return nil, err
	}
	if errors := validator.ValidateFeedSubscriptionsReadyMessage(json.RawMessage(data)); len(errors) > 0 {
		return nil, fmt.Errorf("invalid FeedSubscriptionsReadyMessage: %s", strings.Join(errors, "; "))
	}
	return data, nil
}

type feedHandshakeMessageAlias FeedHandshakeMessage

func (m FeedHandshakeMessage) MarshalJSON() ([]byte, error) {
	m.Type = "hello"
	data, err := json.Marshal(feedHandshakeMessageAlias(m))
	if err != nil {
		return nil, err
	}
	if errors := validator.ValidateFeedHandshakeMessage(json.RawMessage(data)); len(errors) > 0 {
		return nil, fmt.Errorf("invalid FeedHandshakeMessage: %s", strings.Join(errors, "; "))
	}
	return data, nil
}
