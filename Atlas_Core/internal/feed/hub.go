package feed

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

const (
	defaultClientBuffer          = 256
	defaultMissingVersionTimeout = 2 * time.Second
)

type Options struct {
	ClientBuffer          int
	MissingVersionTimeout time.Duration
}

type Hub struct {
	mu                    sync.Mutex
	nextVersion           int64
	pending               map[int64]RoutedEvent
	skipped               map[int64]string
	clients               map[*Client]struct{}
	clientBuffer          int
	missingVersionTimeout time.Duration
	gapTimer              *time.Timer
	closed                bool
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
	missingVersionTimeout := opts.MissingVersionTimeout
	if missingVersionTimeout <= 0 {
		missingVersionTimeout = defaultMissingVersionTimeout
	}
	return &Hub{
		nextVersion:           startAfterVersion + 1,
		pending:               make(map[int64]RoutedEvent),
		skipped:               make(map[int64]string),
		clients:               make(map[*Client]struct{}),
		clientBuffer:          buffer,
		missingVersionTimeout: missingVersionTimeout,
	}
}

func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	h.stopGapTimerLocked()
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

// HasSubscription reports whether any active client currently holds sub.
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
}

func (h *Hub) PublishResourceChange(change actions.ResourceChange) {
	routed, err := RoutedEventFromChange(change)
	if err != nil {
		log.Error().
			Err(err).
			Str("event", string(change.Event)).
			Str("resource_type", string(change.ResourceType)).
			Str("id", change.ID).
			Int64("version", change.Version).
			Msg("Atlas feed change could not be converted to a feed event; skipping version")
		h.SkipVersion(change.Version, "event_conversion_failed")
		return
	}
	if errors := ProtocolValidationErrors(routed.Event); len(errors) > 0 {
		log.Error().
			Strs("validation_errors", errors).
			Str("event", string(change.Event)).
			Str("resource_type", string(change.ResourceType)).
			Str("id", change.ID).
			Int64("version", change.Version).
			Msg("Atlas feed event failed protocol validation; skipping version")
		h.SkipVersion(change.Version, "invalid_feed_event")
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
		log.Warn().
			Int64("event_version", event.Event.Version).
			Int64("next_version", h.nextVersion).
			Str("event", string(event.Event.Event)).
			Str("resource_type", string(event.Event.ResourceType)).
			Str("id", event.Event.ID).
			Msg("Dropping stale Atlas feed event")
		return
	}
	if _, exists := h.pending[event.Event.Version]; exists {
		log.Warn().
			Int64("event_version", event.Event.Version).
			Str("event", string(event.Event.Event)).
			Str("resource_type", string(event.Event.ResourceType)).
			Str("id", event.Event.ID).
			Msg("Dropping duplicate Atlas feed event version")
		return
	}
	h.pending[event.Event.Version] = event
	h.advanceLocked()
}

// SkipVersion marks a known-permanent feed version gap so later versions do not
// block behind an event that cannot be emitted.
func (h *Hub) SkipVersion(version int64, reason string) {
	if version <= 0 {
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || version < h.nextVersion {
		return
	}
	if reason == "" {
		reason = "unknown"
	}
	h.skipped[version] = reason
	h.advanceLocked()
}

func (h *Hub) advanceLocked() {
	for {
		next, ok := h.pending[h.nextVersion]
		if ok {
			delete(h.pending, h.nextVersion)
			h.deliverLocked(next)
			h.nextVersion++
			continue
		}
		if reason, ok := h.skipped[h.nextVersion]; ok {
			log.Warn().
				Int64("version", h.nextVersion).
				Str("reason", reason).
				Msg("Skipping known-missing Atlas feed version")
			delete(h.skipped, h.nextVersion)
			h.nextVersion++
			continue
		}
		break
	}
	h.updateGapTimerLocked()
}

func (h *Hub) updateGapTimerLocked() {
	if h.closed || h.lowestKnownVersionLocked() == 0 {
		h.stopGapTimerLocked()
		return
	}
	if h.gapTimer != nil {
		return
	}
	h.gapTimer = time.AfterFunc(h.missingVersionTimeout, h.skipTimedOutMissingVersions)
}

func (h *Hub) stopGapTimerLocked() {
	if h.gapTimer == nil {
		return
	}
	h.gapTimer.Stop()
	h.gapTimer = nil
}

func (h *Hub) skipTimedOutMissingVersions() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.gapTimer = nil
	if h.closed {
		return
	}
	target := h.lowestKnownVersionLocked()
	if target == 0 {
		return
	}
	if target > h.nextVersion {
		log.Warn().
			Int64("from_version", h.nextVersion).
			Int64("to_version", target-1).
			Int("pending_events", len(h.pending)).
			Dur("timeout", h.missingVersionTimeout).
			Msg("Skipping timed-out Atlas feed version gap")
		h.nextVersion = target
	}
	h.advanceLocked()
}

func (h *Hub) lowestKnownVersionLocked() int64 {
	var lowest int64
	for version := range h.pending {
		if version < h.nextVersion {
			continue
		}
		if lowest == 0 || version < lowest {
			lowest = version
		}
	}
	for version := range h.skipped {
		if version < h.nextVersion {
			continue
		}
		if lowest == 0 || version < lowest {
			lowest = version
		}
	}
	return lowest
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
		Event:        change.Event,
		ResourceType: change.ResourceType,
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
		if change.Event == actions.ChangeEventUpdate {
			event.PreviousEntityID = nullableTaskEntityID(change.BeforeTask)
		}
		if change.Event == actions.ChangeEventDelete {
			event.EntityID = nullableTaskEntityID(change.BeforeTask)
		}
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

func nullableTaskEntityID(task *models.Task) *string {
	if task == nil {
		return nil
	}
	if task.EntityID == nil {
		return nil
	}
	value := *task.EntityID
	return &value
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
