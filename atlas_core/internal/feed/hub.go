package feed

import (
	"fmt"
	"strings"
	"sync"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

const defaultClientBuffer = 256

type Options struct {
	ClientBuffer int
}

type RoutedEvent struct {
	Event              protocol.FeedEvent
	BeforeTaskEntityID string
	AfterTaskEntityID  string
}

// Hub fans already ordered durable events out to active subscriptions. It does
// not recover, reorder, or invent missing versions; the database log owns those
// responsibilities.
type Hub struct {
	mu           sync.Mutex
	clients      map[*Client]struct{}
	clientBuffer int
	closed       bool
}

func NewHub(opts Options) *Hub {
	buffer := opts.ClientBuffer
	if buffer <= 0 {
		buffer = defaultClientBuffer
	}
	return &Hub{
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
		hub:     h,
		subs:    make(map[string]Subscription),
		send:    make(chan RoutedEvent, h.clientBuffer),
		control: make(chan protocol.FeedSubscriptionsReadyMessage, 1),
	}
	if h.closed {
		client.closed = true
		close(client.send)
		close(client.control)
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

func (h *Hub) HasSubscription(sub Subscription) bool {
	key := sub.Key()
	h.mu.Lock()
	defer h.mu.Unlock()
	for client := range h.clients {
		client.mu.Lock()
		_, ok := client.subs[key]
		client.mu.Unlock()
		if ok {
			return true
		}
	}
	return false
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
	close(client.control)
}

// Publish delivers one event read from the durable log. Slow clients are
// disconnected and recover from their last applied version through changed-since.
func (h *Hub) Publish(event RoutedEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
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

	mu      sync.Mutex
	subs    map[string]Subscription
	send    chan RoutedEvent
	control chan protocol.FeedSubscriptionsReadyMessage
	closed  bool
}

func (c *Client) Subscribe(sub Subscription) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.subs[sub.Key()] = sub
	}
}

func (c *Client) Unsubscribe(sub Subscription) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.subs, sub.Key())
}

func (c *Client) Events() <-chan RoutedEvent {
	return c.send
}

func (c *Client) Controls() <-chan protocol.FeedSubscriptionsReadyMessage {
	return c.control
}

func (c *Client) SubscriptionsReady(version int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	select {
	case c.control <- protocol.FeedSubscriptionsReadyMessage{Version: version}:
		return true
	default:
		return false
	}
}

func (c *Client) Close() {
	if c.hub != nil {
		c.hub.RemoveClient(c)
	}
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
		return event.Event.ResourceType == protocol.ResourceTypeTask &&
			(event.BeforeTaskEntityID == sub.EntityID || event.AfterTaskEntityID == sub.EntityID)
	default:
		return false
	}
}
