package feed

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

type simulationLedger struct {
	events []RoutedEvent
}

var feedTestLogMu sync.Mutex

func (l *simulationLedger) append(t *testing.T, event RoutedEvent) {
	t.Helper()
	if errors := ProtocolValidationErrors(event.Event); len(errors) > 0 {
		t.Fatalf("ledger event %d failed protocol validation: %v", event.Event.Version, errors)
	}
	l.events = append(l.events, event)
}

func TestFeedEventNullableTaskContextNormalizesNullToAbsent(t *testing.T) {
	var deleteWithNull protocol.FeedEvent
	if err := json.Unmarshal([]byte(`{"event":"delete","resource_type":"task","id":"task-1","version":1,"entity_id":null}`), &deleteWithNull); err != nil {
		t.Fatalf("decode task delete with null entity_id: %v", err)
	}
	if deleteWithNull.EntityID != nil {
		t.Fatalf("null entity_id decoded as %#v, want nil", deleteWithNull.EntityID)
	}

	var updateWithNull protocol.FeedEvent
	if err := json.Unmarshal([]byte(`{"event":"update","resource_type":"task","id":"task-1","version":2,"previous_entity_id":null,"resource":{"task_id":"task-1","status":"pending","entity_id":null,"components":{},"metadata":{"created_at":"2026-06-12T12:00:00Z","updated_at":"2026-06-12T12:00:00Z","version":2}}}`), &updateWithNull); err != nil {
		t.Fatalf("decode task update with null previous_entity_id: %v", err)
	}
	if updateWithNull.PreviousEntityID != nil {
		t.Fatalf("null previous_entity_id decoded as %#v, want nil", updateWithNull.PreviousEntityID)
	}

	var raw map[string]any
	if err := json.Unmarshal([]byte(`{"entity_id":null}`), &raw); err != nil {
		t.Fatalf("decode raw null payload: %v", err)
	}
	if _, present := raw["entity_id"]; !present {
		t.Fatal("raw JSON decoding should preserve explicit entity_id key")
	}
}

func (l *simulationLedger) changedSince(version int64) []RoutedEvent {
	var out []RoutedEvent
	for _, event := range l.events {
		if event.Event.Version > version {
			out = append(out, event)
		}
	}
	return EventsByVersion(out)
}

func (l *simulationLedger) entitled(filter Subscription) []RoutedEvent {
	var out []RoutedEvent
	for _, event := range l.events {
		if subscriptionMatches(filter, event) {
			out = append(out, event)
		}
	}
	return EventsByVersion(out)
}

type simulatedSubscriber struct {
	name         string
	filter       Subscription
	hub          *Hub
	ledger       *simulationLedger
	client       *Client
	received     map[int64]RoutedEvent
	appliedOrder []int64
	lastVersion  int64
	dropVersions map[int64]bool
	gapRecovery  bool
}

func newSimulatedSubscriber(name string, hub *Hub, ledger *simulationLedger, filter Subscription, gapRecovery bool) *simulatedSubscriber {
	s := &simulatedSubscriber{
		name:         name,
		filter:       filter,
		hub:          hub,
		ledger:       ledger,
		received:     make(map[int64]RoutedEvent),
		dropVersions: make(map[int64]bool),
		gapRecovery:  gapRecovery,
	}
	s.connect()
	return s
}

func (s *simulatedSubscriber) connect() {
	s.client = s.hub.NewClient()
	s.client.Subscribe(s.filter)
}

func (s *simulatedSubscriber) disconnect() {
	if s.client != nil {
		s.client.Close()
		s.client = nil
	}
}

func (s *simulatedSubscriber) reconnectAndRecover() {
	s.connect()
	s.recoverFromLedger()
}

func (s *simulatedSubscriber) drain() {
	if s.client == nil {
		return
	}
	for {
		select {
		case event, ok := <-s.client.Events():
			if !ok {
				s.client = nil
				return
			}
			s.handleFeedEvent(event)
		default:
			return
		}
	}
}

func (s *simulatedSubscriber) handleFeedEvent(event RoutedEvent) {
	version := event.Event.Version
	if s.dropVersions[version] {
		delete(s.dropVersions, version)
		return
	}
	if s.gapRecovery && s.filter.Filter == FilterAll && s.lastVersion > 0 && version > s.lastVersion+1 {
		s.recoverFromLedger()
	}
	s.apply(event)
}

func (s *simulatedSubscriber) recoverFromLedger() {
	for _, event := range s.ledger.changedSince(s.lastVersion) {
		if subscriptionMatches(s.filter, event) {
			s.apply(event)
		}
	}
}

func (s *simulatedSubscriber) apply(event RoutedEvent) {
	version := event.Event.Version
	if _, exists := s.received[version]; !exists {
		s.received[version] = event
	}
	s.appliedOrder = append(s.appliedOrder, version)
	if version > s.lastVersion {
		s.lastVersion = version
	}
}

func (s *simulatedSubscriber) audit(t *testing.T) {
	t.Helper()
	expected := s.ledger.entitled(s.filter)
	for _, event := range expected {
		received, ok := s.received[event.Event.Version]
		if !ok {
			t.Fatalf("%s missed entitled event version=%d event=%s resource=%s id=%s", s.name, event.Event.Version, event.Event.Event, event.Event.ResourceType, event.Event.ID)
		}
		if event.Event.ResourceType == protocol.ResourceTypeTask {
			assertOptionalString(t, s.name, event.Event.Version, "previous_entity_id", event.Event.PreviousEntityID, received.Event.PreviousEntityID)
			assertOptionalString(t, s.name, event.Event.Version, "entity_id", event.Event.EntityID, received.Event.EntityID)
		}
	}
	// Gap recovery may re-apply a version already received from the live feed,
	// so appliedOrder only needs to be non-decreasing, not unique.
	for i := 1; i < len(s.appliedOrder); i++ {
		if s.appliedOrder[i] < s.appliedOrder[i-1] {
			t.Fatalf("%s applied versions out of order: %v", s.name, s.appliedOrder)
		}
	}
}

func assertOptionalString(t *testing.T, subscriber string, version int64, field string, want, got *string) {
	t.Helper()
	if want == nil && got == nil {
		return
	}
	if want == nil || got == nil || *want != *got {
		t.Fatalf("%s event version=%d %s = %v, want %v", subscriber, version, field, optionalStringValue(got), optionalStringValue(want))
	}
}

func optionalStringValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func TestHubOrdersAndFiltersFeedEvents(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()

	all := hub.NewClient()
	all.Subscribe(Subscription{Filter: FilterAll})
	taskForA := hub.NewClient()
	taskForA.Subscribe(Subscription{Filter: FilterTasksForEntity, EntityID: "asset-a", ResourceType: protocol.ResourceTypeTask})

	first := taskEvent("create", "task-1", 1, "", "asset-a", "pending")
	second := taskEvent("update", "task-1", 2, "asset-a", "asset-b", "pending")

	hub.Publish(second)
	assertNoEvent(t, all)
	hub.Publish(first)

	assertVersion(t, all, 1)
	assertVersion(t, all, 2)
	assertVersion(t, taskForA, 1)
	assertVersion(t, taskForA, 2)
}

func TestHubSkipsTimedOutMissingVersions(t *testing.T) {
	hub := NewHub(0, Options{MissingVersionTimeout: 100 * time.Millisecond})
	defer hub.Close()

	all := hub.NewClient()
	all.Subscribe(Subscription{Filter: FilterAll})

	hub.Publish(entityEvent("create", "asset-after-burned-version", 2, "asset"))
	assertNoEvent(t, all)
	assertVersionWithin(t, all, 2, time.Second)
}

func TestHubSkipsKnownMissingVersionWhenChangeCannotBeBuilt(t *testing.T) {
	hub := NewHub(0, Options{MissingVersionTimeout: time.Second})
	defer hub.Close()
	logs := captureFeedTestLogs(t)

	all := hub.NewClient()
	all.Subscribe(Subscription{Filter: FilterAll})

	hub.PublishResourceChange(actions.ResourceChange{
		Event:        actions.ChangeEventCreate,
		ResourceType: actions.ChangeResourceEntity,
		ID:           "asset-missing-after-state",
		Version:      1,
	})
	hub.Publish(entityEvent("create", "asset-after-unbuildable-event", 2, "asset"))

	assertVersionWithin(t, all, 2, time.Second)
	logOutput := logs.String()
	for _, want := range []string{
		"Atlas feed change could not be converted to a feed event",
		"Skipping known-missing Atlas feed version",
		"asset-missing-after-state",
		`"version":1`,
	} {
		if !strings.Contains(logOutput, want) {
			t.Fatalf("captured logs missing %q:\n%s", want, logOutput)
		}
	}
}

func TestAsyncChangeSinkDoesNotBlockPublisher(t *testing.T) {
	blocking := &blockingChangeSink{
		received: make(chan actions.ResourceChange, 1),
		release:  make(chan struct{}),
	}
	t.Cleanup(func() {
		close(blocking.release)
	})
	sink := NewAsyncChangeSink(blocking, AsyncChangeSinkOptions{Buffer: 1})
	t.Cleanup(sink.Close)

	sink.PublishResourceChange(actions.ResourceChange{Event: actions.ChangeEventCreate, ResourceType: actions.ChangeResourceEntity, ID: "asset-1", Version: 1})
	select {
	case <-blocking.received:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for async sink worker to receive first change")
	}

	done := make(chan struct{})
	go func() {
		sink.PublishResourceChange(actions.ResourceChange{Event: actions.ChangeEventCreate, ResourceType: actions.ChangeResourceEntity, ID: "asset-2", Version: 2})
		sink.PublishResourceChange(actions.ResourceChange{Event: actions.ChangeEventCreate, ResourceType: actions.ChangeResourceEntity, ID: "asset-3", Version: 3})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("async sink publisher blocked behind slow downstream sink")
	}
}

func TestAsyncChangeSinkSkipsDroppedVersion(t *testing.T) {
	blocking := &skippableBlockingChangeSink{
		received: make(chan actions.ResourceChange, 1),
		release:  make(chan struct{}),
		skipped:  make(chan skippedVersion, 1),
	}
	t.Cleanup(func() {
		close(blocking.release)
	})
	sink := NewAsyncChangeSink(blocking, AsyncChangeSinkOptions{Buffer: 1})
	t.Cleanup(sink.Close)

	sink.PublishResourceChange(actions.ResourceChange{Event: actions.ChangeEventCreate, ResourceType: actions.ChangeResourceEntity, ID: "asset-1", Version: 1})
	select {
	case <-blocking.received:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for async sink worker to receive first change")
	}

	sink.PublishResourceChange(actions.ResourceChange{Event: actions.ChangeEventCreate, ResourceType: actions.ChangeResourceEntity, ID: "asset-2", Version: 2})
	sink.PublishResourceChange(actions.ResourceChange{Event: actions.ChangeEventCreate, ResourceType: actions.ChangeResourceEntity, ID: "asset-3", Version: 3})

	select {
	case skipped := <-blocking.skipped:
		if skipped.version != 3 || skipped.reason != "async_sink_queue_full" {
			t.Fatalf("skipped version = %+v, want version 3 with async_sink_queue_full", skipped)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for async sink to skip dropped version")
	}
}

func TestAsyncChangeSinkStopsAfterClose(t *testing.T) {
	recording := &recordingAsyncSink{
		received: make(chan actions.ResourceChange, 1),
	}
	sink := NewAsyncChangeSink(recording, AsyncChangeSinkOptions{Buffer: 1})
	sink.Close()
	sink.Close()

	sink.PublishResourceChange(actions.ResourceChange{Event: actions.ChangeEventCreate, ResourceType: actions.ChangeResourceEntity, ID: "asset-after-close", Version: 1})

	select {
	case change := <-recording.received:
		t.Fatalf("closed async sink delivered change: %+v", change)
	case <-time.After(250 * time.Millisecond):
	}
}

func TestAsyncChangeSinkStopsWhenWrappedSinkCloses(t *testing.T) {
	wrapped := &closingChangeSink{
		done:     make(chan struct{}),
		received: make(chan actions.ResourceChange, 1),
	}
	sink := NewAsyncChangeSink(wrapped, AsyncChangeSinkOptions{Buffer: 1})
	close(wrapped.done)

	sink.PublishResourceChange(actions.ResourceChange{Event: actions.ChangeEventCreate, ResourceType: actions.ChangeResourceEntity, ID: "asset-after-wrapped-close", Version: 1})

	select {
	case change := <-wrapped.received:
		t.Fatalf("async sink delivered change after wrapped sink closed: %+v", change)
	case <-time.After(250 * time.Millisecond):
	}
}

type blockingChangeSink struct {
	received chan actions.ResourceChange
	release  chan struct{}
}

func (s *blockingChangeSink) PublishResourceChange(change actions.ResourceChange) {
	select {
	case s.received <- change:
	default:
	}
	<-s.release
}

type skippedVersion struct {
	version int64
	reason  string
}

type skippableBlockingChangeSink struct {
	received chan actions.ResourceChange
	release  chan struct{}
	skipped  chan skippedVersion
}

func (s *skippableBlockingChangeSink) PublishResourceChange(change actions.ResourceChange) {
	select {
	case s.received <- change:
	default:
	}
	<-s.release
}

func (s *skippableBlockingChangeSink) SkipVersion(version int64, reason string) {
	s.skipped <- skippedVersion{version: version, reason: reason}
}

type recordingAsyncSink struct {
	received chan actions.ResourceChange
}

func (s *recordingAsyncSink) PublishResourceChange(change actions.ResourceChange) {
	s.received <- change
}

type closingChangeSink struct {
	done     chan struct{}
	received chan actions.ResourceChange
}

func (s *closingChangeSink) PublishResourceChange(change actions.ResourceChange) {
	s.received <- change
}

func (s *closingChangeSink) Done() <-chan struct{} {
	return s.done
}

func captureFeedTestLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	feedTestLogMu.Lock()
	var buf bytes.Buffer
	previous := log.Logger
	log.Logger = zerolog.New(&buf)
	t.Cleanup(func() {
		log.Logger = previous
		feedTestLogMu.Unlock()
	})
	return &buf
}

func TestSimulationHarnessAuditsEntitledFeedDeliveryAndRecovery(t *testing.T) {
	hub := NewHub(0, Options{ClientBuffer: 512})
	defer hub.Close()
	ledger := &simulationLedger{}

	subscribers := []*simulatedSubscriber{
		newSimulatedSubscriber("all-live", hub, ledger, Subscription{Filter: FilterAll}, false),
		newSimulatedSubscriber("all-gap-recovery", hub, ledger, Subscription{Filter: FilterAll}, true),
		newSimulatedSubscriber("all-reconnect-recovery", hub, ledger, Subscription{Filter: FilterAll}, true),
		newSimulatedSubscriber("entity-type", hub, ledger, Subscription{Filter: FilterType, ResourceType: protocol.ResourceTypeEntity}, false),
		newSimulatedSubscriber("task-id", hub, ledger, Subscription{Filter: FilterID, ResourceType: protocol.ResourceTypeTask, ID: "task-05"}, false),
		newSimulatedSubscriber("tasks-for-asset-1", hub, ledger, Subscription{Filter: FilterTasksForEntity, ResourceType: protocol.ResourceTypeTask, EntityID: "asset-1"}, false),
	}
	subscribers[1].dropVersions[18] = true

	events := simulatedTraffic()
	for i := 0; i < len(events); i++ {
		event := events[i]
		if event.Event.Version == 25 {
			subscribers[2].disconnect()
		}
		if i+1 < len(events) && event.Event.Version%11 == 0 {
			next := events[i+1]
			ledger.append(t, next)
			hub.Publish(next)
			drainAll(subscribers)

			ledger.append(t, event)
			hub.Publish(event)
			drainAll(subscribers)
			i++
		} else {
			ledger.append(t, event)
			hub.Publish(event)
			drainAll(subscribers)
		}
		if event.Event.Version == 31 {
			subscribers[2].reconnectAndRecover()
			drainAll(subscribers)
		}
		if event.Event.Version%17 == 0 {
			for _, sub := range subscribers {
				sub.audit(t)
			}
		}
	}
	for _, sub := range subscribers {
		sub.recoverFromLedger()
		sub.audit(t)
	}
}

func drainAll(subscribers []*simulatedSubscriber) {
	for _, sub := range subscribers {
		sub.drain()
	}
}

func assertNoEvent(t *testing.T, client *Client) {
	t.Helper()
	select {
	case event := <-client.Events():
		t.Fatalf("unexpected event version %d", event.Event.Version)
	default:
	}
}

func assertVersion(t *testing.T, client *Client, version int64) {
	t.Helper()
	select {
	case event := <-client.Events():
		if event.Event.Version != version {
			t.Fatalf("got version %d, want %d", event.Event.Version, version)
		}
	default:
		t.Fatalf("missing version %d", version)
	}
}

func assertVersionWithin(t *testing.T, client *Client, version int64, timeout time.Duration) {
	t.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case event := <-client.Events():
			if event.Event.Version != version {
				t.Fatalf("got version %d, want %d", event.Event.Version, version)
			}
			return
		case <-timer.C:
			t.Fatalf("timed out waiting for version %d", version)
		}
	}
}

func simulatedTraffic() []RoutedEvent {
	var events []RoutedEvent
	var version int64
	nextVersion := func() int64 {
		version++
		return version
	}
	for i := 0; i < 4; i++ {
		assetID := fmt.Sprintf("asset-%d", i)
		events = append(events, entityEvent("create", assetID, nextVersion(), "asset"))
	}
	for i := 0; i < 18; i++ {
		taskID := fmt.Sprintf("task-%02d", i)
		from := fmt.Sprintf("asset-%d", i%4)
		to := fmt.Sprintf("asset-%d", (i+1)%4)
		events = append(events,
			taskEvent("create", taskID, nextVersion(), "", from, "pending"),
			taskEvent("update", taskID, nextVersion(), from, to, "pending"),
		)
		if i%3 == 0 {
			events = append(events, taskEvent("update", taskID, nextVersion(), to, to, "acknowledged"))
		}
		if i%4 == 0 {
			events = append(events, taskEvent("delete", taskID, nextVersion(), to, "", ""))
		}
		if i%5 == 0 {
			objectID := fmt.Sprintf("object-%02d", i)
			events = append(events,
				objectEvent("create", objectID, nextVersion()),
				objectEvent("update", objectID, nextVersion()),
			)
		}
	}
	events = append(events, entityEvent("delete", "asset-2", nextVersion(), ""))
	return events
}

func entityEvent(eventName, id string, version int64, entityType string) RoutedEvent {
	event := protocol.FeedEvent{
		Event:        protocol.FeedEventName(eventName),
		ResourceType: protocol.ResourceTypeEntity,
		ID:           id,
		Version:      version,
	}
	if eventName != "delete" {
		event.Resource = map[string]any{
			"entity_id":   id,
			"entity_type": entityType,
			"subtype":     nil,
			"alias":       nil,
			"components":  map[string]any{},
			"metadata":    metadata(version),
		}
	}
	return RoutedEvent{Event: event}
}

func taskEvent(eventName, id string, version int64, beforeEntity, afterEntity, status string) RoutedEvent {
	event := protocol.FeedEvent{
		Event:        protocol.FeedEventName(eventName),
		ResourceType: protocol.ResourceTypeTask,
		ID:           id,
		Version:      version,
	}
	if eventName == "update" && beforeEntity != "" {
		event.PreviousEntityID = &beforeEntity
	}
	if eventName == "delete" && beforeEntity != "" {
		event.EntityID = &beforeEntity
	}
	if eventName != "delete" {
		var entityID any
		if afterEntity != "" {
			entityID = afterEntity
		}
		event.Resource = map[string]any{
			"task_id":    id,
			"status":     status,
			"entity_id":  entityID,
			"components": map[string]any{},
			"metadata":   metadata(version),
		}
	}
	return RoutedEvent{Event: event, BeforeTaskEntityID: beforeEntity, AfterTaskEntityID: afterEntity}
}

func objectEvent(eventName, id string, version int64) RoutedEvent {
	event := protocol.FeedEvent{
		Event:        protocol.FeedEventName(eventName),
		ResourceType: protocol.ResourceTypeObject,
		ID:           id,
		Version:      version,
	}
	if eventName != "delete" {
		event.Resource = map[string]any{
			"object_id":     id,
			"path":          nil,
			"content_type":  nil,
			"type":          "image",
			"size_bytes":    nil,
			"usage_hints":   []string{"thumbnail"},
			"referenced_by": []map[string]any{{"entity_id": "asset-1"}},
			"bucket":        nil,
			"metadata":      metadata(version),
		}
	}
	return RoutedEvent{Event: event}
}

func metadata(version int64) map[string]any {
	return map[string]any{
		"created_at": "2026-06-12T12:00:00Z",
		"updated_at": "2026-06-12T12:00:00Z",
		"version":    version,
	}
}
