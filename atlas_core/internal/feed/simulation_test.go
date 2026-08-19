package feed

import (
	"testing"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestHubDeliversDurableEventsInPublishedOrder(t *testing.T) {
	hub := NewHub(Options{})
	defer hub.Close()
	client := hub.NewClient()
	client.Subscribe(Subscription{Filter: protocol.FeedFilterAll})

	hub.Publish(testRoutedEvent(4, protocol.ResourceTypeEntity, "entity-1"))
	hub.Publish(testRoutedEvent(5, protocol.ResourceTypeTask, "task-1"))

	for _, want := range []int64{4, 5} {
		got := <-client.Events()
		if got.Event.Version != want {
			t.Fatalf("event version = %d, want %d", got.Event.Version, want)
		}
	}
}

func TestTasksForAssetMatchesImmutableAssetRoutingContext(t *testing.T) {
	hub := NewHub(Options{})
	defer hub.Close()
	client := hub.NewClient()
	client.Subscribe(Subscription{Filter: protocol.FeedFilterTasksForAsset, ResourceType: protocol.ResourceTypeTask, AssetID: "entity-1"})

	hub.Publish(RoutedEvent{
		Event:       testRoutedEvent(1, protocol.ResourceTypeTask, "task-1").Event,
		TaskAssetID: "entity-1",
	})
	hub.Publish(RoutedEvent{
		Event:       testRoutedEvent(2, protocol.ResourceTypeTask, "task-2").Event,
		TaskAssetID: "entity-1",
	})
	hub.Publish(RoutedEvent{
		Event:       testRoutedEvent(3, protocol.ResourceTypeTask, "task-unrelated").Event,
		TaskAssetID: "entity-9",
	})
	for _, want := range []string{"task-1", "task-2"} {
		if got := <-client.Events(); got.Event.ID != want {
			t.Fatalf("event id = %q, want %s", got.Event.ID, want)
		}
	}
	select {
	case event := <-client.Events():
		t.Fatalf("received unrelated task event %q", event.Event.ID)
	default:
	}
}

func TestHubDisconnectsSlowClients(t *testing.T) {
	hub := NewHub(Options{ClientBuffer: 1})
	defer hub.Close()
	client := hub.NewClient()
	client.Subscribe(Subscription{Filter: protocol.FeedFilterAll})

	hub.Publish(testRoutedEvent(1, protocol.ResourceTypeEntity, "entity-1"))
	hub.Publish(testRoutedEvent(2, protocol.ResourceTypeEntity, "entity-2"))

	if _, ok := <-client.Events(); !ok {
		t.Fatal("buffered event was not retained")
	}
	if _, ok := <-client.Events(); ok {
		t.Fatal("slow client channel remained open")
	}
}

func TestHubDropsPublishesAndReturnsClosedClientsAfterClose(t *testing.T) {
	hub := NewHub(Options{})
	hub.Close()
	hub.Publish(testRoutedEvent(1, protocol.ResourceTypeEntity, "entity-1"))

	client := hub.NewClient()
	if _, ok := <-client.Events(); ok {
		t.Fatal("client created after hub shutdown was not closed")
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

func taskEvent(eventName, id string, version int64, assetID, status string) RoutedEvent {
	event := protocol.FeedEvent{Event: protocol.FeedEventName(eventName), ResourceType: protocol.ResourceTypeTask, ID: id, Version: version}
	if eventName != "delete" {
		event.Resource = map[string]any{
			"task_id": id, "asset_id": assetID, "command": "fixture.immediate",
			"input": map[string]any{}, "status": status,
			"created_at": "2026-06-12T12:00:00Z", "updated_at": "2026-06-12T12:00:00Z",
		}
	}
	return RoutedEvent{Event: event, TaskAssetID: assetID}
}

func testMetadata(version int64) map[string]any {
	return map[string]any{
		"created_at": "2026-06-12T12:00:00Z",
		"updated_at": "2026-06-12T12:00:00Z",
		"version":    version,
	}
}
