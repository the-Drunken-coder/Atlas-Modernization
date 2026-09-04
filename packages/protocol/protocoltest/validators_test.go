package protocoltest

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	protocolvalidator "github.com/the-drunken-coder/atlas/packages/protocol/validator"
)

func TestEntityExamplesValidate(t *testing.T) {
	root := moduleRoot(t)
	assertExamplesValidate(t, filepath.Join(root, "examples", "entities"), protocol.ValidateEntityBlob)
}

func TestObjectExamplesValidate(t *testing.T) {
	root := moduleRoot(t)
	assertExamplesValidate(t, filepath.Join(root, "examples", "objects"), protocol.ValidateObjectBlob)
}

func TestGeneratedValidatorsRejectCyclicValues(t *testing.T) {
	cyclicMap := map[string]any{}
	cyclicMap["self"] = cyclicMap
	cyclicSlice := make([]any, 1)
	cyclicSlice[0] = cyclicSlice
	var cyclicPointer any
	cyclicPointer = &cyclicPointer

	for name, value := range map[string]any{
		"map":     cyclicMap,
		"slice":   cyclicSlice,
		"pointer": cyclicPointer,
	} {
		t.Run(name, func(t *testing.T) {
			assertErrorContains(t, protocol.ValidateEntityBlob(value), "cyclic value")
		})
	}
}

func TestGeneratedMapAreaValidatorAppliesSemanticLimits(t *testing.T) {
	valid := map[string]any{"west": -71.001, "south": 42.0, "east": -71.0, "north": 42.001}
	if errors := protocol.ValidateMapArea(valid); len(errors) != 0 {
		t.Fatalf("ValidateMapArea(valid) errors = %v", errors)
	}

	assertErrorContains(t, protocol.ValidateMapArea(map[string]any{
		"west": 10.0, "south": 42.0, "east": -10.0, "north": 42.001,
	}), "west must be less than east")
	assertErrorContains(t, protocol.ValidateMapArea(map[string]any{
		"west": -71.001, "south": 42.001, "east": -71.0, "north": 42.0,
	}), "south must be less than north")
	assertErrorContains(t, protocol.ValidateMapArea(map[string]any{
		"west": -71.1, "south": 42.0, "east": -71.0, "north": 42.1,
	}), "area must not exceed 5 km²")
	assertErrorContains(t, protocol.ValidateMapArea(json.RawMessage(`{"west":1,"south":0,"east":0,"north":1}`)), "west must be less than east")
}

func TestCommandManifestCommandNamesMustBeUnique(t *testing.T) {
	entry := func(command string) map[string]any {
		return map[string]any{
			"command":           command,
			"description":       "Fixture command",
			"scheduling":        "immediate",
			"supports_cancel":   false,
			"supports_progress": false,
		}
	}

	if errors := protocol.ValidateCommandManifest([]any{entry("fixture.first"), entry("fixture.second")}); len(errors) > 0 {
		t.Fatalf("distinct command manifest entries rejected: %v", errors)
	}
	assertErrorContains(t, protocol.ValidateCommandManifest([]any{entry("fixture.first"), entry("fixture.first")}), `command "fixture.first" is duplicated`)
}

func TestNonEmptyStringRejectsUnicodeWhitespaceOnlyValues(t *testing.T) {
	for _, value := range []string{
		"\u00a0", "\u1680", "\u2000", "\u2028", "\u2029", "\ufeff", " ", "\t", "\n",
	} {
		t.Run(fmt.Sprintf("U+%04X", []rune(value)[0]), func(t *testing.T) {
			if errors := protocolvalidator.ValidateDefinition("NonEmptyString", value); len(errors) == 0 {
				t.Fatalf("whitespace-only value %q passed validation", value)
			}
		})
	}
	if errors := protocolvalidator.ValidateDefinition("NonEmptyString", "\u200b"); len(errors) > 0 {
		t.Fatalf("zero-width space should remain content: %v", errors)
	}
}

func TestRFC3339TimestampMatchesCanonicalDateTimeRules(t *testing.T) {
	for _, value := range []string{
		"2026-01-02T03:04:05Z",
		"2026-01-02t03:04:05Z",
		"2026-01-02T03:04:05z",
		"2026-01-02T23:59:60Z",
		"2026-01-02T00:59:60+01:00",
		"2026-01-02T22:59:60-01:00",
	} {
		if errors := protocolvalidator.ValidateDefinition("RFC3339Timestamp", value); len(errors) > 0 {
			t.Errorf("canonical timestamp %q rejected: %v", value, errors)
		}
	}
	for _, value := range []string{
		"2026-01-02T03:04:60Z",
		"2026-01-02T23:59:60+01:01",
		"2026-01-02T22:59:60-02:00",
		"2026-02-29T03:04:05Z",
		"2026-01-02T23:59:59+24:00",
	} {
		if errors := protocolvalidator.ValidateDefinition("RFC3339Timestamp", value); len(errors) == 0 {
			t.Errorf("invalid timestamp %q passed validation", value)
		}
	}
}

func TestGeneratedSpatialValidatorsApplySemanticLimits(t *testing.T) {
	openMultiPolygon := map[string]any{
		"type": "MultiPolygon",
		"coordinates": []any{[]any{[]any{
			[]any{0.0, 0.0}, []any{1.0, 0.0}, []any{1.0, 1.0}, []any{0.0, 1.0},
		}}},
	}
	assertErrorContains(t, protocol.ValidateSpatialGeometry(openMultiPolygon), "polygon ring must be closed")

	positions := make([]any, protocolvalidator.MaxGeometryPositions+1)
	for index := range positions {
		positions[index] = []any{0.0, 0.0}
	}
	assertErrorContains(t, protocol.ValidateSpatialGeometry(map[string]any{
		"type":        "MultiPolygon",
		"coordinates": []any{[]any{positions}},
	}), "polygon positions must not exceed")

	geometry := map[string]any{
		"type": "Polygon",
		"coordinates": []any{[]any{
			[]any{0.0, 0.0}, []any{1.0, 0.0}, []any{1.0, 1.0}, []any{0.0, 0.0},
		}},
	}
	result := map[string]any{
		"features": []any{
			map[string]any{"id": "duplicate", "title": "First", "geometry": geometry, "fields": []any{map[string]any{"label": "Type", "value": "building"}}},
			map[string]any{"id": "duplicate", "title": "Second", "geometry": geometry, "fields": []any{map[string]any{"label": "Type", "value": "building"}}},
		},
		"provenance":   map[string]any{"connector_id": "fixture", "source": "Fixture"},
		"attribution":  map[string]any{"text": "Fixture", "url": "https://example.test/attribution"},
		"retrieved_at": "2026-08-31T12:00:00Z",
		"truncation":   nil,
	}
	assertErrorContains(t, protocol.ValidateSpatialOperationResult(result), "feature ID \"duplicate\" is duplicated")
}

func TestErrorExamplesValidate(t *testing.T) {
	root := moduleRoot(t)
	assertExamplesValidate(t, filepath.Join(root, "examples", "errors"), protocol.ValidateErrorResponse)
}

func TestFeedEventExamplesValidate(t *testing.T) {
	root := moduleRoot(t)
	assertExamplesValidate(t, filepath.Join(root, "examples", "feed", "events"), protocol.ValidateFeedEvent)
}

func TestFeedClientMessageExamplesValidate(t *testing.T) {
	root := moduleRoot(t)
	assertExamplesValidate(t, filepath.Join(root, "examples", "feed", "messages"), protocol.ValidateFeedClientMessage)
}

func TestHandshakeProtocolRevisionMatchesProtocolRevision(t *testing.T) {
	root := moduleRoot(t)
	data, err := os.ReadFile(filepath.Join(root, "examples", "feed", "server", "handshake.json"))
	if err != nil {
		t.Fatalf("read handshake example: %v", err)
	}
	var handshake protocol.FeedHandshakeMessage
	if err := json.Unmarshal(data, &handshake); err != nil {
		t.Fatalf("decode handshake example: %v", err)
	}
	if errors := protocol.ValidateFeedHandshakeMessage(json.RawMessage(data)); len(errors) > 0 {
		t.Fatalf("handshake example did not validate: %v", errors)
	}
	if handshake.ProtocolRevision != protocol.ProtocolRevision {
		t.Fatalf("handshake protocol_revision = %q, want generated ProtocolRevision %q", handshake.ProtocolRevision, protocol.ProtocolRevision)
	}
}

func TestPluginStatusStateFieldsStayConsistent(t *testing.T) {
	valid := []string{
		`{"plugin_id":"reference","display_name":null,"status":"starting","reason_code":null,"checked_at":null,"operations":[],"tool_asset_id":null}`,
		`{"plugin_id":"reference","display_name":"Reference","status":"starting","reason_code":null,"checked_at":"2026-08-28T12:00:00Z","operations":[],"tool_asset_id":null}`,
		`{"plugin_id":"reference","display_name":"Reference","status":"available","reason_code":null,"checked_at":"2026-08-28T12:00:00Z","operations":[],"tool_asset_id":null}`,
		`{"plugin_id":"reference","display_name":null,"status":"unavailable","reason_code":"invalid_manifest","checked_at":"2026-08-28T12:00:00Z","operations":[],"tool_asset_id":null}`,
	}
	for _, value := range valid {
		if errors := protocol.ValidatePluginStatus(json.RawMessage(value)); len(errors) > 0 {
			t.Errorf("valid Plugin status rejected: %s: %v", value, errors)
		}
	}

	invalid := []string{
		`{"plugin_id":"reference","display_name":null,"status":"starting","reason_code":"transport_timeout","checked_at":null,"operations":[],"tool_asset_id":null}`,
		`{"plugin_id":"reference","display_name":"Reference","status":"available","reason_code":"transport_timeout","checked_at":"2026-08-28T12:00:00Z","operations":[],"tool_asset_id":null}`,
		`{"plugin_id":"reference","display_name":null,"status":"available","reason_code":null,"checked_at":"2026-08-28T12:00:00Z","operations":[],"tool_asset_id":null}`,
		`{"plugin_id":"reference","display_name":"Reference","status":"available","reason_code":null,"checked_at":null,"operations":[],"tool_asset_id":null}`,
		`{"plugin_id":"reference","display_name":null,"status":"unavailable","reason_code":null,"checked_at":"2026-08-28T12:00:00Z","operations":[],"tool_asset_id":null}`,
		`{"plugin_id":"reference","display_name":null,"status":"unavailable","reason_code":"invalid_manifest","checked_at":null,"operations":[],"tool_asset_id":null}`,
	}
	for _, value := range invalid {
		if errors := protocol.ValidatePluginStatus(json.RawMessage(value)); len(errors) == 0 {
			t.Errorf("contradictory Plugin status accepted: %s", value)
		}
	}
}

func TestSubscriptionsReadyExampleValidates(t *testing.T) {
	root := moduleRoot(t)
	data, err := os.ReadFile(filepath.Join(root, "examples", "feed", "server-ready", "subscriptions-ready.json"))
	if err != nil {
		t.Fatalf("read subscriptions-ready example: %v", err)
	}
	if errors := protocol.ValidateFeedSubscriptionsReadyMessage(json.RawMessage(data)); len(errors) > 0 {
		t.Fatalf("subscriptions-ready example did not validate: %v", errors)
	}
}

func TestFeedControlMessageMarshalingPinsAndValidatesDiscriminators(t *testing.T) {
	auth, err := json.Marshal(protocol.FeedAuthMessage{Action: protocol.FeedActionSubscribe, APIKey: "secret"})
	if err != nil {
		t.Fatalf("marshal auth message: %v", err)
	}
	var authPayload map[string]any
	if err := json.Unmarshal(auth, &authPayload); err != nil {
		t.Fatalf("decode auth payload: %v", err)
	}
	if authPayload["action"] != string(protocol.FeedActionAuth) {
		t.Fatalf("auth action = %v, want %q", authPayload["action"], protocol.FeedActionAuth)
	}
	if _, err := json.Marshal(protocol.FeedAuthMessage{}); err == nil {
		t.Fatal("expected empty auth message to fail validation")
	}

	subscribe := protocol.FeedSubscriptionMessage{Action: protocol.FeedActionSubscribe, Filter: protocol.FeedFilterAll}
	if data, err := json.Marshal(subscribe); err != nil {
		t.Fatalf("marshal subscribe message: %v", err)
	} else if errors := protocol.ValidateFeedSubscribeMessage(json.RawMessage(data)); len(errors) > 0 {
		t.Fatalf("subscribe message did not validate: %v", errors)
	}
	if _, err := json.Marshal(protocol.FeedSubscriptionMessage{Action: protocol.FeedActionAuth, Filter: protocol.FeedFilterAll}); err == nil {
		t.Fatal("expected auth action in subscription message to fail validation")
	}

	barrier, err := json.Marshal(protocol.FeedSubscriptionBarrierMessage{Action: protocol.FeedActionAuth})
	if err != nil {
		t.Fatalf("marshal subscription barrier: %v", err)
	}
	if errors := protocol.ValidateFeedSubscriptionBarrierMessage(json.RawMessage(barrier)); len(errors) > 0 {
		t.Fatalf("subscription barrier did not validate: %v", errors)
	}
	var barrierPayload map[string]any
	if err := json.Unmarshal(barrier, &barrierPayload); err != nil {
		t.Fatalf("decode subscription barrier: %v", err)
	}
	if barrierPayload["action"] != string(protocol.FeedActionSubscriptionBarrier) {
		t.Fatalf("subscription barrier action = %v, want %q", barrierPayload["action"], protocol.FeedActionSubscriptionBarrier)
	}
	for _, invalid := range []string{
		`{"action":"ready"}`,
		`{"action":"subscriptions_ready"}`,
		`{"action":"subscription_barrier","filter":"all"}`,
		`{"action":"subscription_barrier"} trailing`,
	} {
		if errors := protocol.ValidateFeedSubscriptionBarrierMessage(json.RawMessage(invalid)); len(errors) == 0 {
			t.Fatalf("invalid subscription barrier passed validation: %s", invalid)
		}
	}
	if errors := protocol.ValidateFeedClientMessage(barrierPayload); len(errors) > 0 {
		t.Fatalf("subscription barrier is not an accepted client message: %v", errors)
	}
	invalidBarrierPayload := map[string]any{"action": "subscription_barrier", "filter": "all"}
	if errors := protocol.ValidateFeedClientMessage(invalidBarrierPayload); len(errors) == 0 {
		t.Fatal("subscription barrier with an extra property passed client-message validation")
	}

	ready, err := json.Marshal(protocol.FeedSubscriptionsReadyMessage{Type: "not-ready", Version: 42})
	if err != nil {
		t.Fatalf("marshal subscription acknowledgement: %v", err)
	}
	if errors := protocol.ValidateFeedSubscriptionsReadyMessage(json.RawMessage(ready)); len(errors) > 0 {
		t.Fatalf("subscription acknowledgement did not validate: %v", errors)
	}
	var readyPayload map[string]any
	if err := json.Unmarshal(ready, &readyPayload); err != nil {
		t.Fatalf("decode subscription acknowledgement: %v", err)
	}
	if readyPayload["type"] != "subscriptions_ready" {
		t.Fatalf("subscription acknowledgement type = %v, want subscriptions_ready", readyPayload["type"])
	}
	if _, err := json.Marshal(protocol.FeedSubscriptionsReadyMessage{Version: -1}); err == nil {
		t.Fatal("expected negative subscription acknowledgement version to fail validation")
	}
	for _, invalid := range []string{
		`{"type":"ready","version":42}`,
		`{"type":"subscriptions-ready","version":42}`,
		`{"type":"subscriptions_ready","version":-1}`,
		`{"type":"subscriptions_ready"}`,
		`{"type":"subscriptions_ready","version":1.5}`,
		`{"type":"subscriptions_ready","version":42} trailing`,
	} {
		if errors := protocol.ValidateFeedSubscriptionsReadyMessage(json.RawMessage(invalid)); len(errors) == 0 {
			t.Fatalf("invalid subscription acknowledgement passed validation: %s", invalid)
		}
	}
	if errors := protocol.ValidateFeedSubscriptionsReadyMessage(json.RawMessage(`{"type":"subscriptions_ready","version":1.0}`)); len(errors) > 0 {
		t.Fatalf("mathematically integral JSON number did not validate: %v", errors)
	}

	hello, err := json.Marshal(protocol.FeedHandshakeMessage{Type: "not-hello", ProtocolRevision: protocol.ProtocolRevision})
	if err != nil {
		t.Fatalf("marshal handshake message: %v", err)
	}
	var helloPayload map[string]any
	if err := json.Unmarshal(hello, &helloPayload); err != nil {
		t.Fatalf("decode handshake payload: %v", err)
	}
	if helloPayload["type"] != "hello" {
		t.Fatalf("handshake type = %v, want hello", helloPayload["type"])
	}
	if _, err := json.Marshal(protocol.FeedHandshakeMessage{ProtocolRevision: "not-a-sha"}); err == nil {
		t.Fatal("expected invalid handshake revision to fail validation")
	}
}

func TestEntityComponentKeys(t *testing.T) {
	valid := map[string]any{
		"components": map[string]any{
			"telemetry":    map[string]any{},
			"custom_notes": "free-form",
		},
	}
	if errors := protocol.ValidateEntityBlob(valid); len(errors) > 0 {
		t.Fatalf("ValidateEntityBlob(valid) errors = %v", errors)
	}

	invalid := map[string]any{
		"components": map[string]any{
			"geomtry": map[string]any{},
		},
	}
	assertErrorContains(t, protocol.ValidateEntityBlob(invalid), "geomtry")
}

func TestComponentValidationUnknownKeysAreSorted(t *testing.T) {
	entityErrors := protocol.ValidateEntityComponents(map[string]any{
		"z_unknown":   true,
		"a_unknown":   true,
		"custom_free": true,
	})
	wantEntityErrors := []string{`Unknown component "a_unknown"`, `Unknown component "z_unknown"`}
	if !reflect.DeepEqual(entityErrors, wantEntityErrors) {
		t.Fatalf("ValidateEntityComponents unknown errors = %v, want %v", entityErrors, wantEntityErrors)
	}

}

func TestTelemetryValidation(t *testing.T) {
	valid := map[string]any{
		"latitude":    40.7,
		"longitude":   -73.9,
		"altitude_m":  120.0,
		"speed_m_s":   8.2,
		"heading_deg": 165.0,
		"last_update": "2026-05-29T10:00:00Z",
	}
	if errors := protocol.ValidateTelemetryComponent(valid); len(errors) > 0 {
		t.Fatalf("ValidateTelemetryComponent(valid) errors = %v", errors)
	}

	tests := []struct {
		name      string
		telemetry map[string]any
		contains  []string
	}{
		{name: "latitude out of range", telemetry: map[string]any{"latitude": 91.0}, contains: []string{"latitude"}},
		{name: "longitude out of range", telemetry: map[string]any{"longitude": -181.0}, contains: []string{"longitude"}},
		{name: "non finite", telemetry: map[string]any{"speed_m_s": math.NaN()}, contains: []string{"speed_m_s"}},
		{name: "negative speed", telemetry: map[string]any{"speed_m_s": -1.0}, contains: []string{"speed_m_s"}},
		{name: "invalid heading", telemetry: map[string]any{"heading_deg": 360.0}, contains: []string{"heading_deg"}},
		{name: "invalid last_update", telemetry: map[string]any{"last_update": "not-a-date"}, contains: []string{"last_update"}},
		{name: "legacy alias rejected", telemetry: map[string]any{"speed_ms": 10.0}, contains: []string{"speed_ms"}},
		{name: "null rejected", telemetry: map[string]any{"latitude": nil}, contains: []string{"latitude"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertErrorsContainAll(t, protocol.ValidateTelemetryComponent(tt.telemetry), tt.contains...)
		})
	}

}

func TestGeometryValidation(t *testing.T) {
	validGeoJSON := map[string]any{
		"type":        "Polygon",
		"coordinates": []any{[]any{[]any{-74.0, 40.0}, []any{-73.0, 40.0}, []any{-73.0, 41.0}, []any{-74.0, 40.0}}},
	}
	if errors := protocol.ValidateGeometryComponent(validGeoJSON); len(errors) > 0 {
		t.Fatalf("ValidateGeometryComponent(valid GeoJSON) errors = %v", errors)
	}

	validCircle := map[string]any{
		"type":     "Feature",
		"geometry": map[string]any{"type": "Point", "coordinates": []any{-73.9, 40.7}},
		"properties": map[string]any{
			"shape":    "circle",
			"radius_m": 25.0,
		},
	}
	if errors := protocol.ValidateGeometryComponent(validCircle); len(errors) > 0 {
		t.Fatalf("ValidateGeometryComponent(valid circle Feature) errors = %v", errors)
	}

	validCircle3D := map[string]any{
		"type":     "Feature",
		"geometry": map[string]any{"type": "Point", "coordinates": []any{-73.9, 40.7, 120.0}},
		"properties": map[string]any{
			"shape":    "circle",
			"radius_m": 25.0,
		},
	}
	if errors := protocol.ValidateGeometryComponent(validCircle3D); len(errors) > 0 {
		t.Fatalf("ValidateGeometryComponent(valid 3D circle Feature) errors = %v", errors)
	}

	tests := []struct {
		name     string
		geometry map[string]any
		contains []string
	}{
		{name: "bad longitude", geometry: map[string]any{"type": "Point", "coordinates": []any{181.0, 40.0}}, contains: []string{"coordinates"}},
		{name: "non finite", geometry: map[string]any{"type": "Point", "coordinates": []any{math.Inf(1), 40.0}}, contains: []string{"coordinates[0]"}},
		{
			name:     "bad circle radius",
			geometry: map[string]any{"type": "Feature", "geometry": map[string]any{"type": "Point", "coordinates": []any{-73.0, 40.0}}, "properties": map[string]any{"shape": "circle", "radius_m": 0.0}},
			contains: []string{"radius_m"},
		},
		{
			name:     "raw point rejects radius",
			geometry: map[string]any{"type": "Point", "coordinates": []any{-73.0, 40.0}, "radius_m": 25.0},
		},
		{
			name:     "circle missing shape",
			geometry: map[string]any{"type": "Feature", "geometry": map[string]any{"type": "Point", "coordinates": []any{-73.0, 40.0}}, "properties": map[string]any{"radius_m": 25.0}},
			contains: []string{"shape"},
		},
		{
			name:     "circle requires point geometry",
			geometry: map[string]any{"type": "Feature", "geometry": map[string]any{"type": "LineString", "coordinates": []any{[]any{-73.0, 40.0}, []any{-73.1, 40.1}}}, "properties": map[string]any{"shape": "circle", "radius_m": 25.0}},
			contains: []string{"geometry"},
		},
		{
			name:     "circle rejects extra properties",
			geometry: map[string]any{"type": "Feature", "geometry": map[string]any{"type": "Point", "coordinates": []any{-73.0, 40.0}}, "properties": map[string]any{"shape": "circle", "radius_m": 25.0, "units": "meters"}},
		},
		{name: "partial GeoJSON", geometry: map[string]any{"type": "Point"}, contains: []string{"coordinates"}},
		{name: "empty", geometry: map[string]any{}, contains: []string{"type"}},
		{name: "unclosed polygon", geometry: map[string]any{"type": "Polygon", "coordinates": []any{[]any{[]any{0.0, 0.0}, []any{1.0, 0.0}, []any{1.0, 1.0}, []any{0.0, 1.0}}}}, contains: []string{"closed"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertErrorsContainAll(t, protocol.ValidateGeometryComponent(tt.geometry), tt.contains...)
		})
	}
}

func TestEntityCheckInRequestRejectsAggregatePolygonPositionLimit(t *testing.T) {
	exterior := make([]any, 5_001)
	interior := make([]any, 5_001)
	for index := range exterior {
		exterior[index] = []any{0.0, 0.0}
		interior[index] = []any{0.0, 0.0}
	}
	rings := []any{exterior, interior}
	request := map[string]any{
		"components": map[string]any{
			"geometry": map[string]any{"type": "Polygon", "coordinates": rings},
		},
	}
	assertErrorContains(t, protocol.ValidateEntityCheckInRequest(request), "must not exceed 10000")
}

func TestResponseValidatorsApplyNestedGeometrySemantics(t *testing.T) {
	entity := responseEntity(map[string]any{
		"geometry": map[string]any{
			"type":        "Polygon",
			"coordinates": []any{[]any{[]any{0.0, 0.0}, []any{1.0, 0.0}, []any{1.0, 1.0}, []any{0.0, 1.0}}},
		},
	})
	checkIn := map[string]any{"entity": entity}
	fullDataset := map[string]any{
		"entities": []any{entity}, "tasks": []any{}, "objects": []any{}, "version": 1,
		"has_more_entities": false, "has_more_tasks": false, "has_more_objects": false,
	}
	changedSince := map[string]any{
		"events": []any{map[string]any{
			"event": "update", "resource_type": "entity", "id": "entity-1", "version": 1, "resource": entity,
		}},
		"has_more": false, "version": 1,
	}

	for name, validate := range map[string]func(any) []string{
		"check-in full":    protocol.ValidateEntityCheckInFullResponse,
		"check-in minimal": protocol.ValidateEntityCheckInMinimalResponse,
		"check-in union":   protocol.ValidateEntityCheckInResponse,
	} {
		t.Run(name, func(t *testing.T) {
			assertErrorContains(t, validate(checkIn), "closed")
		})
	}
	assertErrorContains(t, protocol.ValidateFullDatasetResponse(fullDataset), "closed")
	assertErrorContains(t, protocol.ValidateChangedSinceResponse(changedSince), "closed")
}

func TestResponseValidatorsRequireContinuationCursors(t *testing.T) {
	assertErrorContains(t, protocol.ValidateChangedSinceResponse(map[string]any{
		"events": []any{}, "has_more": true, "version": 1,
	}), "next_cursor")
	if errors := protocol.ValidateChangedSinceResponse(map[string]any{
		"events": []any{}, "has_more": false, "next_cursor": "orphan", "version": 1,
	}); len(errors) == 0 {
		t.Fatal("ChangedSinceResponse accepted an orphan next_cursor")
	}

	for _, flag := range []string{"has_more_entities", "has_more_tasks", "has_more_objects"} {
		t.Run(flag, func(t *testing.T) {
			fullDataset := map[string]any{
				"entities": []any{}, "tasks": []any{}, "objects": []any{}, "version": 1,
				"has_more_entities": false, "has_more_tasks": false, "has_more_objects": false,
			}
			fullDataset[flag] = true
			assertErrorContains(t, protocol.ValidateFullDatasetResponse(fullDataset), "cursor")
		})
	}

	for _, test := range []struct {
		flag   string
		cursor string
	}{
		{flag: "has_more_entities", cursor: "next_entity_cursor"},
		{flag: "has_more_objects", cursor: "next_object_cursor"},
		{flag: "has_more_tasks", cursor: "next_task_cursor"},
	} {
		t.Run(test.flag+" orphan cursor", func(t *testing.T) {
			fullDataset := map[string]any{
				"entities": []any{}, "tasks": []any{}, "objects": []any{}, "version": 1,
				"has_more_entities": false, "has_more_tasks": false, "has_more_objects": false,
			}
			fullDataset[test.cursor] = "orphan"
			if errors := protocol.ValidateFullDatasetResponse(fullDataset); len(errors) == 0 {
				t.Fatalf("FullDatasetResponse accepted an orphan %s", test.cursor)
			}
		})
	}
}

func responseEntity(components map[string]any) map[string]any {
	return map[string]any{
		"entity_id": "entity-1", "entity_type": "geofeature", "subtype": nil, "alias": nil,
		"components": components,
		"metadata": map[string]any{
			"created_at": "2026-08-11T00:00:00Z", "updated_at": "2026-08-11T00:00:00Z", "version": 1,
		},
	}
}

func TestCanonicalJSONSchemaConstraints(t *testing.T) {
	root := moduleRoot(t)

	geometryDefs := readSchemaDefs(t, root)
	geoJSONPosition := schemaObject(t, geometryDefs["GeoJSONPosition"])
	assertSchemaNumber(t, geoJSONPosition, "minItems", 2)
	assertSchemaMissing(t, geoJSONPosition, "minLength")

	circleProperties := schemaObject(t, geometryDefs["CircleProperties"])
	if got, want := circleProperties["additionalProperties"], false; got != want {
		t.Fatalf("CircleProperties additionalProperties = %v, want %v", got, want)
	}
	circlePropertyFields := schemaObject(t, circleProperties["properties"])
	shape := schemaObject(t, circlePropertyFields["shape"])
	if got, want := shape["const"], "circle"; got != want {
		t.Fatalf("CircleProperties.shape const = %v, want %q", got, want)
	}
	radius := schemaObject(t, circlePropertyFields["radius_m"])
	assertSchemaNumber(t, radius, "exclusiveMinimum", 0)

	circleFeature := schemaObject(t, geometryDefs["GeoJSONCircleFeature"])
	circleFeatureProps := schemaObject(t, circleFeature["properties"])
	circleFeatureGeometry := schemaObject(t, circleFeatureProps["geometry"])
	if got, want := circleFeatureGeometry["$ref"], "#/$defs/GeoJSONPoint"; got != want {
		t.Fatalf("GeoJSONCircleFeature.geometry ref = %v, want %q", got, want)
	}

	objectReferenceSchema := schemaObject(t, geometryDefs["ObjectReference"])
	assertSchemaNumber(t, objectReferenceSchema, "minProperties", 1)

	objectReferenceDef := schemaObject(t, geometryDefs["ObjectReference"])
	assertSchemaNumber(t, objectReferenceDef, "minProperties", 1)
	objectSchema := schemaObject(t, geometryDefs["ObjectBlob"])
	objectProps := schemaObject(t, objectSchema["properties"])
	sizeBytes := schemaObject(t, objectProps["size_bytes"])
	if got, want := sizeBytes["type"], "integer"; got != want {
		t.Fatalf("object size_bytes type = %v, want %s", got, want)
	}

	telemetryDef := schemaObject(t, geometryDefs["TelemetryComponent"])
	assertSchemaMissing(t, telemetryDef, "$ref")
	telemetryProps := schemaObject(t, telemetryDef["properties"])
	latitude := schemaObject(t, telemetryProps["latitude"])
	if got, want := latitude["$ref"], "#/$defs/Latitude"; got != want {
		t.Fatalf("telemetry latitude ref = %v, want %s", got, want)
	}
	healthDef := schemaObject(t, geometryDefs["HealthComponent"])
	assertSchemaMissing(t, healthDef, "$ref")
	healthProps := schemaObject(t, healthDef["properties"])
	batteryPercent := schemaObject(t, healthProps["battery_percent"])
	assertSchemaNumber(t, batteryPercent, "maximum", 100)
}

func TestEntityComponentPayloadValidation(t *testing.T) {
	valid := map[string]any{
		"health": map[string]any{
			"battery_percent": 76.0,
		},
		"mil_view": map[string]any{
			"classification": "friendly",
			"last_seen":      "2026-05-29T10:05:00Z",
		},
		"communications": map[string]any{
			"link_state": "connected",
		},
		"status": map[string]any{
			"value":       "available",
			"last_update": "2026-05-29T10:05:00Z",
		},
		"heartbeat": map[string]any{
			"last_seen": "2026-05-29T10:05:00Z",
		},
		"media_refs": []any{
			map[string]any{"object_id": "obj-1", "role": "thumbnail"},
		},
		"sensor_refs": []any{
			map[string]any{
				"sensor_id":              "sensor-1",
				"type":                   "radar",
				"horizontal_fov":         90.0,
				"vertical_fov":           60.0,
				"horizontal_orientation": 45.0,
				"vertical_orientation":   10.0,
			},
		},
	}
	if errors := protocol.ValidateEntityComponents(valid); len(errors) > 0 {
		t.Fatalf("ValidateEntityComponents(valid) errors = %v", errors)
	}

	tests := []struct {
		name       string
		components map[string]any
		contains   string
	}{
		{name: "bad health", components: map[string]any{"health": map[string]any{"battery_percent": 101.0}}, contains: "health.battery_percent"},
		{name: "null health battery", components: map[string]any{"health": map[string]any{"battery_percent": nil}}, contains: "health.battery_percent"},
		{name: "bad classification", components: map[string]any{"mil_view": map[string]any{"classification": "enemy"}}, contains: "mil_view.classification"},
		{name: "null classification", components: map[string]any{"mil_view": map[string]any{"classification": nil}}, contains: "mil_view.classification"},
		{name: "null last seen", components: map[string]any{"mil_view": map[string]any{"last_seen": nil}}, contains: "mil_view.last_seen"},
		{name: "bad link state", components: map[string]any{"communications": map[string]any{"link_state": "offline"}}, contains: "communications.link_state"},
		{name: "null link state", components: map[string]any{"communications": map[string]any{"link_state": nil}}, contains: "communications.link_state"},
		{name: "bad status", components: map[string]any{"status": map[string]any{"value": ""}}, contains: "status.value"},
		{name: "bad heartbeat", components: map[string]any{"heartbeat": map[string]any{}}, contains: "heartbeat.last_seen"},
		{name: "bad media role", components: map[string]any{"media_refs": []any{map[string]any{"object_id": "obj-1", "role": "bad"}}}, contains: "media_refs.0.role"},
		{name: "legacy sensor alias rejected", components: map[string]any{"sensor_refs": []any{map[string]any{"sensor_id": "sensor-1", "type": "radar", "fov_horizontal": 90.0}}}, contains: "fov_horizontal"},
		{name: "null sensor number", components: map[string]any{"sensor_refs": []any{map[string]any{"sensor_id": "sensor-1", "type": "radar", "horizontal_fov": nil}}}, contains: "sensor_refs.0.horizontal_fov"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertErrorContains(t, protocol.ValidateEntityComponents(tt.components), tt.contains)
		})
	}
}

func TestTaskValidation(t *testing.T) {
	valid := map[string]any{
		"task_id": "task-1", "asset_id": "asset-1", "command": "fixture.immediate",
		"input": map[string]any{"value": 1}, "status": "in_progress", "progress": 0.75,
		"created_at": "2026-05-29T10:00:00Z", "updated_at": "2026-05-29T10:01:00Z",
		"acknowledged_at": "2026-05-29T10:00:10Z", "started_at": "2026-05-29T10:00:20Z",
	}
	if errors := protocol.ValidateTaskResource(valid); len(errors) > 0 {
		t.Fatalf("ValidateTaskResource(valid) errors = %v", errors)
	}

	tests := []struct {
		name     string
		resource map[string]any
		contains string
	}{
		{name: "null task id", resource: map[string]any{"task_id": nil}, contains: "task_id"},
		{name: "bad progress", resource: map[string]any{"progress": 1.1}, contains: "progress"},
		{name: "legacy components", resource: map[string]any{"components": map[string]any{}}, contains: "components"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resource := make(map[string]any, len(valid)+len(tt.resource))
			for key, value := range valid {
				resource[key] = value
			}
			for key, value := range tt.resource {
				resource[key] = value
			}
			assertErrorContains(t, protocol.ValidateTaskResource(resource), tt.contains)
		})
	}

	impossible := map[string]map[string]any{
		"pending with lifecycle timestamps": {
			"status": "pending", "acknowledged_at": "2026-05-29T10:00:10Z", "started_at": "2026-05-29T10:00:20Z",
		},
		"acknowledged without timestamp": {"status": "acknowledged", "acknowledged_at": nil},
		"in progress without start":      {"status": "in_progress", "started_at": nil},
		"completed without finish":       {"status": "completed"},
		"failed without failure":         {"status": "failed"},
		"cancelled without cancellation": {"status": "cancelled"},
		"failed start without acknowledgement": {
			"status": "failed", "acknowledged_at": nil, "progress": nil,
			"failure":     map[string]any{"code": "execution_failed", "message": "bad"},
			"finished_at": "2026-05-29T10:01:00Z",
		},
		"cancelled progress without start": {
			"status": "cancelled", "started_at": nil,
			"cancellation": map[string]any{"code": "requested", "message": "stop"},
			"finished_at":  "2026-05-29T10:01:00Z",
		},
		"cancelled progress without acknowledgement": {
			"status": "cancelled", "acknowledged_at": nil,
			"cancellation": map[string]any{"code": "requested", "message": "stop"},
			"finished_at":  "2026-05-29T10:01:00Z",
		},
		"completed with failure": {
			"status": "completed", "finished_at": "2026-05-29T10:01:00Z",
			"failure": map[string]any{"code": "execution_failed", "message": "bad"},
		},
	}
	for name, patch := range impossible {
		t.Run(name, func(t *testing.T) {
			resource := make(map[string]any, len(valid)+len(patch))
			for key, value := range valid {
				resource[key] = value
			}
			for key, value := range patch {
				if value == nil {
					delete(resource, key)
					continue
				}
				resource[key] = value
			}
			if errors := protocol.ValidateTaskResource(resource); len(errors) == 0 {
				t.Fatalf("ValidateTaskResource accepted impossible %s Task: %#v", resource["status"], resource)
			}
		})
	}
}

func TestObjectValidation(t *testing.T) {
	valid := map[string]any{
		"bucket":     "atlas-media",
		"size_bytes": 2048,
		"usage_hints": []any{
			"camera_feed",
			"thumbnail",
		},
		"referenced_by": []any{
			map[string]any{"entity_id": "entity-1"},
			map[string]any{"task_id": "task-1"},
			map[string]any{"entity_id": "entity-2", "task_id": "task-2"},
		},
		"checksum": "sha256:test",
	}
	if errors := protocol.ValidateObjectBlob(valid); len(errors) > 0 {
		t.Fatalf("ValidateObjectBlob(valid) errors = %v", errors)
	}

	tests := []struct {
		name     string
		blob     map[string]any
		contains []string
	}{
		{name: "bad size", blob: map[string]any{"size_bytes": -1}, contains: []string{"size_bytes"}},
		{name: "fractional size", blob: map[string]any{"size_bytes": 1.5}, contains: []string{"size_bytes"}},
		{name: "usage hints not array", blob: map[string]any{"usage_hints": "camera_feed"}, contains: []string{"usage_hints"}},
		{name: "empty usage hint", blob: map[string]any{"usage_hints": []any{""}}, contains: []string{"usage_hints"}},
		{name: "references not array", blob: map[string]any{"referenced_by": "entity-1"}, contains: []string{"referenced_by"}},
		{name: "reference not object", blob: map[string]any{"referenced_by": []any{"entity-1"}}, contains: []string{"referenced_by.0"}},
		{name: "reference missing ids", blob: map[string]any{"referenced_by": []any{map[string]any{}}}, contains: []string{"referenced_by.0"}},
		{name: "reference blank id", blob: map[string]any{"referenced_by": []any{map[string]any{"entity_id": " "}}}, contains: []string{"referenced_by"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertErrorsContainAll(t, protocol.ValidateObjectBlob(tt.blob), tt.contains...)
		})
	}
}

func TestRawJSONValidatorsRejectTrailingValues(t *testing.T) {
	tests := []struct {
		name     string
		raw      json.RawMessage
		validate func(any) []string
		contains string
	}{
		{
			name:     "entity",
			raw:      json.RawMessage(`{"components":{}}{"extra":true}`),
			validate: protocol.ValidateEntityBlob,
			contains: "trailing JSON value",
		},
		{name: "task", raw: json.RawMessage(`{"asset_id":"asset-1","command":"fixture.immediate","input":{}}{"extra":true}`), validate: protocol.ValidateTaskCreateRequest, contains: "trailing JSON value"},
		{
			name:     "object",
			raw:      json.RawMessage(`{"size_bytes":1}{"bad":true}`),
			validate: protocol.ValidateObjectBlob,
			contains: "trailing JSON value",
		},
		{
			name:     "feed event",
			raw:      json.RawMessage(`{"event":"delete","resource_type":"entity","id":"asset-1","version":1}{"extra":true}`),
			validate: protocol.ValidateFeedEvent,
			contains: "trailing JSON value",
		},
		{
			name:     "array component",
			raw:      json.RawMessage(`[{"object_id":"object-1","role":"thumbnail"}][]`),
			validate: protocol.ValidateMediaRefsComponent,
			contains: "trailing JSON value",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertErrorContains(t, tt.validate(tt.raw), tt.contains)
		})
	}
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), ".."))
}

func assertExamplesValidate(t *testing.T, dir string, validate func(any) []string) {
	t.Helper()
	examples, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(examples) == 0 {
		t.Fatalf("expected examples in %s", dir)
	}

	for _, example := range examples {
		t.Run(filepath.Base(example), func(t *testing.T) {
			data, err := os.ReadFile(example)
			if err != nil {
				t.Fatal(err)
			}
			if errors := validate(json.RawMessage(data)); len(errors) > 0 {
				t.Fatalf("validate() errors = %v", errors)
			}
		})
	}
}

func readSchemaDefs(t *testing.T, root string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "schema", "jsonschema", "atlas.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatal(err)
	}
	return schemaObject(t, schema["$defs"])
}

func schemaObject(t *testing.T, value any) map[string]any {
	t.Helper()
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("expected schema object, got %T", value)
	}
	return object
}

func assertSchemaNumber(t *testing.T, schema map[string]any, key string, want float64) {
	t.Helper()
	got, ok := schema[key].(float64)
	if !ok {
		t.Fatalf("schema[%q] = %T, want number", key, schema[key])
	}
	if got != want {
		t.Fatalf("schema[%q] = %v, want %v", key, got, want)
	}
}

func assertSchemaMissing(t *testing.T, schema map[string]any, key string) {
	t.Helper()
	if _, ok := schema[key]; ok {
		t.Fatalf("schema[%q] should be absent, got %v", key, schema[key])
	}
}

func assertErrorContains(t *testing.T, errors []string, want string) {
	t.Helper()
	for _, err := range errors {
		if strings.Contains(err, want) {
			return
		}
	}
	t.Fatalf("expected error containing %q, got %v", want, errors)
}

func assertErrorsContainAll(t *testing.T, errors []string, want ...string) {
	t.Helper()
	if len(errors) == 0 {
		t.Fatalf("expected validation errors containing %v, got none", want)
	}
	joined := strings.Join(errors, "\n")
	for _, fragment := range want {
		if !strings.Contains(joined, fragment) {
			t.Fatalf("expected errors containing %q, got %v", fragment, errors)
		}
	}
}
