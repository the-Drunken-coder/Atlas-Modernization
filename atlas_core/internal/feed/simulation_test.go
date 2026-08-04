package feed

import (
	"testing"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestHubDeliversDurableEventsInPublishedOrder(t *testing.T) {
	hub := NewHub(Options{})
	defer hub.Close()
	client := hub.NewClient()
	client.Subscribe(Subscription{Filter: FilterAll})

	hub.Publish(testRoutedEvent(4, protocol.ResourceTypeEntity, "entity-1"))
	hub.Publish(testRoutedEvent(5, protocol.ResourceTypeTask, "task-1"))

	for _, want := range []int64{4, 5} {
		got := <-client.Events()
		if got.Event.Version != want {
			t.Fatalf("event version = %d, want %d", got.Event.Version, want)
		}
	}
}

func TestTasksForEntityMatchesBeforeAndAfterRoutingContext(t *testing.T) {
	hub := NewHub(Options{})
	defer hub.Close()
	client := hub.NewClient()
	client.Subscribe(Subscription{Filter: FilterTasksForEntity, ResourceType: protocol.ResourceTypeTask, EntityID: "entity-1"})

	hub.Publish(RoutedEvent{
		Event:              testRoutedEvent(1, protocol.ResourceTypeTask, "task-1").Event,
		BeforeTaskEntityID: "entity-1",
		AfterTaskEntityID:  "entity-2",
	})
	if got := <-client.Events(); got.Event.ID != "task-1" {
		t.Fatalf("event id = %q, want task-1", got.Event.ID)
	}
}

func TestHubDisconnectsSlowClients(t *testing.T) {
	hub := NewHub(Options{ClientBuffer: 1})
	defer hub.Close()
	client := hub.NewClient()
	client.Subscribe(Subscription{Filter: FilterAll})

	hub.Publish(testRoutedEvent(1, protocol.ResourceTypeEntity, "entity-1"))
	hub.Publish(testRoutedEvent(2, protocol.ResourceTypeEntity, "entity-2"))

	if _, ok := <-client.Events(); !ok {
		t.Fatal("buffered event was not retained")
	}
	if _, ok := <-client.Events(); ok {
		t.Fatal("slow client channel remained open")
	}
}

func testRoutedEvent(version int64, resourceType protocol.ResourceType, id string) RoutedEvent {
	return RoutedEvent{Event: protocol.FeedEvent{
		Event:        protocol.FeedEventUpdate,
		ResourceType: resourceType,
		ID:           id,
		Version:      version,
	}}
}

func entityEvent(eventName, id string, version int64, entityType string) RoutedEvent {
	event := protocol.FeedEvent{Event: protocol.FeedEventName(eventName), ResourceType: protocol.ResourceTypeEntity, ID: id, Version: version}
	if eventName != "delete" {
		event.Resource = map[string]any{
			"entity_id": id, "entity_type": entityType, "subtype": nil, "alias": nil,
			"components": map[string]any{}, "metadata": testMetadata(version),
		}
	}
	return RoutedEvent{Event: event}
}

func taskEvent(eventName, id string, version int64, beforeEntity, afterEntity, status string) RoutedEvent {
	event := protocol.FeedEvent{Event: protocol.FeedEventName(eventName), ResourceType: protocol.ResourceTypeTask, ID: id, Version: version}
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
			"task_id": id, "status": status, "entity_id": entityID,
			"components": map[string]any{}, "metadata": testMetadata(version),
		}
	}
	return RoutedEvent{Event: event, BeforeTaskEntityID: beforeEntity, AfterTaskEntityID: afterEntity}
}

func testMetadata(version int64) map[string]any {
	return map[string]any{
		"created_at": "2026-06-12T12:00:00Z",
		"updated_at": "2026-06-12T12:00:00Z",
		"version":    version,
	}
}
