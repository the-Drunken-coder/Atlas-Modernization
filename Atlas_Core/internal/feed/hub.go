package feed

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

const defaultClientBuffer = 256

type Options struct {
	ClientBuffer int
}

type Hub struct {
	mu           sync.Mutex
	nextVersion  int64
	pending      map[int64]RoutedEvent
	clients      map[*Client]struct{}
	clientBuffer int
	closed       bool
}

type RoutedEvent struct {
	Event              protocol.FeedEvent
	BeforeTaskEntityID string
	AfterTaskEntityID  string
}

func NewHub(startAfterVersion int64, opts Options) *Hub {
	buffer := opts.ClientBuffer
	if buffer <= 0 {
		buffer = defaultClientBuffer
	}
	return &Hub{
		nextVersion:  startAfterVersion + 1,
		pending:      make(map[int64]RoutedEvent),
		clients:      make(map[*Client]struct{}),
		clientBuffer: buffer,
	}
}

func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for client := range h.clients {
		h.closeClientLocked(client)
	}
}

func (h *Hub) NewClient() *Client {
	h.mu.Lock()
	defer h.mu.Unlock()
	client := &Client{
		hub:  h,
		subs: make(map[string]Subscription),
		send: make(chan RoutedEvent, h.clientBuffer),
	}
	if h.closed {
		client.closed = true
		close(client.send)
		return client
	}
	h.clients[client] = struct{}{}
	return client
}

func (h *Hub) RemoveClient(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closeClientLocked(client)
}

func (h *Hub) closeClientLocked(client *Client) {
	delete(h.clients, client)
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.closed {
		return
	}
	client.closed = true
	close(client.send)
}

func (h *Hub) PublishResourceChange(change actions.ResourceChange) {
	routed, err := RoutedEventFromChange(change)
	if err != nil {
		return
	}
	h.Publish(routed)
}

func (h *Hub) Publish(event RoutedEvent) {
	if event.Event.Version <= 0 {
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	if event.Event.Version < h.nextVersion {
		return
	}
	h.pending[event.Event.Version] = event
	for {
		next, ok := h.pending[h.nextVersion]
		if !ok {
			break
		}
		delete(h.pending, h.nextVersion)
		h.deliverLocked(next)
		h.nextVersion++
	}
}

func (h *Hub) deliverLocked(event RoutedEvent) {
	var slow []*Client
	for client := range h.clients {
		if !client.deliver(event) {
			slow = append(slow, client)
		}
	}
	for _, client := range slow {
		h.closeClientLocked(client)
	}
}

type FilterKind string

const (
	FilterAll            FilterKind = "all"
	FilterID             FilterKind = "id"
	FilterType           FilterKind = "type"
	FilterTasksForEntity FilterKind = "tasks_for_entity"
)

type Subscription struct {
	Filter       FilterKind
	ResourceType protocol.ResourceType
	ID           string
	EntityID     string
}

func (s Subscription) Key() string {
	parts := []string{string(s.Filter), string(s.ResourceType), s.ID, s.EntityID}
	return strings.Join(parts, "\x00")
}

func SubscriptionFromMessage(msg protocol.FeedSubscriptionMessage) (Subscription, error) {
	sub := Subscription{
		Filter:       FilterKind(msg.Filter),
		ResourceType: msg.ResourceType,
		ID:           strings.TrimSpace(msg.ID),
		EntityID:     strings.TrimSpace(msg.EntityID),
	}
	switch sub.Filter {
	case FilterAll:
		return Subscription{Filter: FilterAll}, nil
	case FilterID:
		if sub.ResourceType == "" || sub.ID == "" {
			return Subscription{}, fmt.Errorf("id subscriptions require resource_type and id")
		}
		return sub, nil
	case FilterType:
		if sub.ResourceType == "" {
			return Subscription{}, fmt.Errorf("type subscriptions require resource_type")
		}
		sub.ID = ""
		return sub, nil
	case FilterTasksForEntity:
		if sub.EntityID == "" {
			return Subscription{}, fmt.Errorf("tasks_for_entity subscriptions require entity_id")
		}
		sub.ResourceType = protocol.ResourceTypeTask
		sub.ID = ""
		return sub, nil
	default:
		return Subscription{}, fmt.Errorf("unknown feed filter %q", msg.Filter)
	}
}

type Client struct {
	hub *Hub

	mu     sync.Mutex
	subs   map[string]Subscription
	send   chan RoutedEvent
	closed bool
}

func (c *Client) Subscribe(sub Subscription) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.subs[sub.Key()] = sub
}

func (c *Client) Unsubscribe(sub Subscription) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.subs, sub.Key())
}

func (c *Client) Events() <-chan RoutedEvent {
	return c.send
}

func (c *Client) Close() {
	if c.hub == nil {
		return
	}
	c.hub.RemoveClient(c)
}

func (c *Client) deliver(event RoutedEvent) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	if !c.matchesLocked(event) {
		return true
	}
	select {
	case c.send <- event:
		return true
	default:
		return false
	}
}

func (c *Client) matchesLocked(event RoutedEvent) bool {
	for _, sub := range c.subs {
		if subscriptionMatches(sub, event) {
			return true
		}
	}
	return false
}

func subscriptionMatches(sub Subscription, event RoutedEvent) bool {
	switch sub.Filter {
	case FilterAll:
		return true
	case FilterID:
		return event.Event.ResourceType == sub.ResourceType && event.Event.ID == sub.ID
	case FilterType:
		return event.Event.ResourceType == sub.ResourceType
	case FilterTasksForEntity:
		if event.Event.ResourceType != protocol.ResourceTypeTask {
			return false
		}
		return event.BeforeTaskEntityID == sub.EntityID || event.AfterTaskEntityID == sub.EntityID
	default:
		return false
	}
}

func RoutedEventFromChange(change actions.ResourceChange) (RoutedEvent, error) {
	event := protocol.FeedEvent{
		Event:        protocol.FeedEventName(change.Event),
		ResourceType: protocol.ResourceType(change.ResourceType),
		ID:           change.ID,
		Version:      change.Version,
	}

	routed := RoutedEvent{Event: event}
	switch change.ResourceType {
	case actions.ChangeResourceEntity:
		if change.Event != actions.ChangeEventDelete {
			if change.AfterEntity == nil {
				return RoutedEvent{}, fmt.Errorf("entity %s event missing after state", change.Event)
			}
			event.Resource = serializers.SerializeEntity(change.AfterEntity)
		}
	case actions.ChangeResourceTask:
		routed.BeforeTaskEntityID = taskEntityID(change.BeforeTask)
		routed.AfterTaskEntityID = taskEntityID(change.AfterTask)
		if change.Event != actions.ChangeEventDelete {
			if change.AfterTask == nil {
				return RoutedEvent{}, fmt.Errorf("task %s event missing after state", change.Event)
			}
			event.Resource = serializers.SerializeTask(change.AfterTask)
		}
	case actions.ChangeResourceObject:
		if change.Event != actions.ChangeEventDelete {
			if change.AfterObject == nil {
				return RoutedEvent{}, fmt.Errorf("object %s event missing after state", change.Event)
			}
			event.Resource = serializers.SerializeObjectForFeed(change.AfterObject)
		}
	default:
		return RoutedEvent{}, fmt.Errorf("unknown resource type %q", change.ResourceType)
	}
	routed.Event = event
	return routed, nil
}

func taskEntityID(task *models.Task) string {
	if task == nil {
		return ""
	}
	if task.EntityID == nil {
		return ""
	}
	return *task.EntityID
}

func ProtocolValidationErrors(event protocol.FeedEvent) []string {
	var payload map[string]any
	raw, err := json.Marshal(event)
	if err != nil {
		return []string{err.Error()}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		return []string{err.Error()}
	}
	return protocol.ValidateFeedEvent(payload)
}

func EventsByVersion(events []RoutedEvent) []RoutedEvent {
	out := append([]RoutedEvent(nil), events...)
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Event.Version < out[j].Event.Version
	})
	return out
}
