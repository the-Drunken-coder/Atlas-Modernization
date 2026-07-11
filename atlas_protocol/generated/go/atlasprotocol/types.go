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
	ErrorCodePreconditionFailed     ErrorCode = "PRECONDITION_FAILED"
)

// ErrorResponse is exported so HTTP handlers can attach request metadata.
// Prefer NewErrorResponse for base responses; Validate and MarshalJSON enforce
// the Atlas Protocol error contract before a response is sent.
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
	if errors := response.Validate(); len(errors) > 0 {
		return ErrorResponse{}, fmt.Errorf("invalid ErrorResponse: %s", strings.Join(errors, "; "))
	}
	return response, nil
}

func (e ErrorResponse) Validate() []string {
	type errorResponseAlias ErrorResponse
	data, err := json.Marshal(errorResponseAlias(e))
	if err != nil {
		return []string{err.Error()}
	}
	return validator.ValidateErrorResponse(json.RawMessage(data))
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
	FeedActionAuth        FeedAction = "auth"
	FeedActionSubscribe   FeedAction = "subscribe"
	FeedActionUnsubscribe FeedAction = "unsubscribe"
)

type FeedFilter string

const (
	FeedFilterAll            FeedFilter = "all"
	FeedFilterID             FeedFilter = "id"
	FeedFilterType           FeedFilter = "type"
	FeedFilterTasksForEntity FeedFilter = "tasks_for_entity"
)

type MetadataBlock struct {
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	Version   int64  `json:"version"`
}

type EntityResource struct {
	EntityID   string               `json:"entity_id"`
	EntityType string               `json:"entity_type"`
	Subtype    *string              `json:"subtype"`
	Alias      *string              `json:"alias"`
	Components map[string]JSONValue `json:"components"`
	Metadata   MetadataBlock        `json:"metadata"`
	Extra      map[string]JSONValue `json:"extra,omitempty"`
}

type TaskResource struct {
	TaskID     string               `json:"task_id"`
	Status     string               `json:"status"`
	EntityID   *string              `json:"entity_id"`
	Components map[string]JSONValue `json:"components"`
	Metadata   MetadataBlock        `json:"metadata"`
	Extra      map[string]JSONValue `json:"extra,omitempty"`
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

type FeedEvent struct {
	Event            FeedEventName `json:"event"`
	ResourceType     ResourceType  `json:"resource_type"`
	ID               string        `json:"id"`
	Version          int64         `json:"version"`
	PreviousEntityID *string       `json:"previous_entity_id,omitempty"`
	EntityID         *string       `json:"entity_id,omitempty"`
	Resource         JSONValue     `json:"resource,omitempty"`
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

type TaskDeleteEvent struct {
	ID       string  `json:"id"`
	Version  int64   `json:"version"`
	EntityID *string `json:"entity_id,omitempty"`
}

func (e TaskDeleteEvent) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(struct {
		Event        FeedEventName `json:"event"`
		ResourceType ResourceType  `json:"resource_type"`
		ID           string        `json:"id"`
		Version      int64         `json:"version"`
		EntityID     *string       `json:"entity_id,omitempty"`
	}{
		Event:        FeedEventDelete,
		ResourceType: ResourceTypeTask,
		ID:           e.ID,
		Version:      e.Version,
		EntityID:     e.EntityID,
	})
	if err != nil {
		return nil, err
	}
	if err := validateMarshaledFeedEvent("TaskDeleteEvent", data); err != nil {
		return nil, err
	}
	return data, nil
}

func (e TaskDeleteEvent) FeedEvent() FeedEvent {
	return FeedEvent{
		Event:        FeedEventDelete,
		ResourceType: ResourceTypeTask,
		ID:           e.ID,
		Version:      e.Version,
		EntityID:     e.EntityID,
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

func (m FeedAuthMessage) Validate() []string {
	m.Action = FeedActionAuth
	data, err := json.Marshal(feedAuthMessageAlias(m))
	if err != nil {
		return []string{err.Error()}
	}
	return validator.ValidateFeedAuthMessage(json.RawMessage(data))
}

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
	EntityID     string       `json:"entity_id,omitempty"`
}

type feedSubscriptionMessageAlias FeedSubscriptionMessage

func (m FeedSubscriptionMessage) Validate() []string {
	data, err := json.Marshal(feedSubscriptionMessageAlias(m))
	if err != nil {
		return []string{err.Error()}
	}
	return validateFeedSubscriptionMessagePayload(data)
}

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

type feedHandshakeMessageAlias FeedHandshakeMessage

func (m FeedHandshakeMessage) Validate() []string {
	m.Type = "hello"
	data, err := json.Marshal(feedHandshakeMessageAlias(m))
	if err != nil {
		return []string{err.Error()}
	}
	return validator.ValidateFeedHandshakeMessage(json.RawMessage(data))
}

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
