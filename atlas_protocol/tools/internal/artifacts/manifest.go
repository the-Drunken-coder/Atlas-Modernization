package artifacts

import (
	"fmt"
	"sort"
)

var entityComponentSchemaKeys = []string{
	// Mirrors atlas_protocol/schema/entity.cue #KnownEntityComponents. Update
	// this list and rerun go run ./tools/check when entity components change.
	"telemetry",
	"geometry",
	"task_catalog",
	"media_refs",
	"mil_view",
	"health",
	"sensor_refs",
	"communications",
	"task_queue",
	"status",
	"heartbeat",
}

func BuildArtifacts(root string, meta Meta) ([]Artifact, error) {
	if err := validateEntityComponentSchemaKeys(meta.EntityComponentKeys); err != nil {
		return nil, err
	}
	revision, err := protocolRevision(root)
	if err != nil {
		return nil, err
	}

	entitySchema, err := jsonSchema(root, "#EntityBlob", revision)
	if err != nil {
		return nil, err
	}
	telemetrySchema, err := jsonSchema(root, "#TelemetryComponent", revision)
	if err != nil {
		return nil, err
	}
	geometrySchema, err := jsonSchema(root, "#GeometryComponent", revision)
	if err != nil {
		return nil, err
	}
	taskCatalogSchema, err := jsonSchema(root, "#TaskCatalogComponent", revision)
	if err != nil {
		return nil, err
	}
	mediaRefsSchema, err := jsonSchema(root, "#MediaRefsComponent", revision)
	if err != nil {
		return nil, err
	}
	milViewSchema, err := jsonSchema(root, "#MilViewComponent", revision)
	if err != nil {
		return nil, err
	}
	healthSchema, err := jsonSchema(root, "#HealthComponent", revision)
	if err != nil {
		return nil, err
	}
	sensorRefsSchema, err := jsonSchema(root, "#SensorRefsComponent", revision)
	if err != nil {
		return nil, err
	}
	communicationsSchema, err := jsonSchema(root, "#CommunicationsComponent", revision)
	if err != nil {
		return nil, err
	}
	taskQueueSchema, err := jsonSchema(root, "#TaskQueueComponent", revision)
	if err != nil {
		return nil, err
	}
	statusSchema, err := jsonSchema(root, "#StatusComponent", revision)
	if err != nil {
		return nil, err
	}
	heartbeatSchema, err := jsonSchema(root, "#HeartbeatComponent", revision)
	if err != nil {
		return nil, err
	}
	componentSchemas := [][]byte{
		telemetrySchema,
		geometrySchema,
		taskCatalogSchema,
		mediaRefsSchema,
		milViewSchema,
		healthSchema,
		sensorRefsSchema,
		communicationsSchema,
		taskQueueSchema,
		statusSchema,
		heartbeatSchema,
	}
	entitySchema, err = hydrateEntityComponentDefs(
		entitySchema,
		componentSchemas...,
	)
	if err != nil {
		return nil, err
	}
	taskSchema, err := jsonSchema(root, "#TaskBlob", revision)
	if err != nil {
		return nil, err
	}
	commandSchema, err := jsonSchema(root, "#CommandComponent", revision)
	if err != nil {
		return nil, err
	}
	taskParametersSchema, err := jsonSchema(root, "#TaskParametersComponent", revision)
	if err != nil {
		return nil, err
	}
	taskProgressSchema, err := jsonSchema(root, "#TaskProgressComponent", revision)
	if err != nil {
		return nil, err
	}
	objectSchema, err := jsonSchema(root, "#ObjectBlob", revision)
	if err != nil {
		return nil, err
	}
	objectReferenceSchema, err := jsonSchema(root, "#ObjectReference", revision)
	if err != nil {
		return nil, err
	}
	metadataBlockSchema, err := jsonSchema(root, "#MetadataBlock", revision)
	if err != nil {
		return nil, err
	}
	entityResourceSchema, err := jsonSchema(root, "#EntityResource", revision)
	if err != nil {
		return nil, err
	}
	entityResourceSchema, err = hydrateEntityComponentDefs(entityResourceSchema, componentSchemas...)
	if err != nil {
		return nil, err
	}
	taskResourceSchema, err := jsonSchema(root, "#TaskResource", revision)
	if err != nil {
		return nil, err
	}
	objectResourceSchema, err := jsonSchema(root, "#ObjectResource", revision)
	if err != nil {
		return nil, err
	}
	feedEventSchema, err := jsonSchema(root, "#FeedEvent", revision)
	if err != nil {
		return nil, err
	}
	feedEventSchema, err = hydrateEntityComponentDefs(feedEventSchema, componentSchemas...)
	if err != nil {
		return nil, err
	}
	feedAuthMessageSchema, err := jsonSchema(root, "#FeedAuthMessage", revision)
	if err != nil {
		return nil, err
	}
	feedSubscribeMessageSchema, err := jsonSchema(root, "#FeedSubscribeMessage", revision)
	if err != nil {
		return nil, err
	}
	feedUnsubscribeMessageSchema, err := jsonSchema(root, "#FeedUnsubscribeMessage", revision)
	if err != nil {
		return nil, err
	}
	feedClientMessageSchema, err := jsonSchema(root, "#FeedClientMessage", revision)
	if err != nil {
		return nil, err
	}
	feedHandshakeMessageSchema, err := jsonSchema(root, "#FeedHandshakeMessage", revision)
	if err != nil {
		return nil, err
	}
	typescriptSource, err := typeScriptSource(revision, map[string][]byte{
		"EntityBlob":             entitySchema,
		"TaskBlob":               taskSchema,
		"ObjectBlob":             objectSchema,
		"EntityResource":         entityResourceSchema,
		"TaskResource":           taskResourceSchema,
		"ObjectResource":         objectResourceSchema,
		"FeedEvent":              feedEventSchema,
		"FeedAuthMessage":        feedAuthMessageSchema,
		"FeedSubscribeMessage":   feedSubscribeMessageSchema,
		"FeedUnsubscribeMessage": feedUnsubscribeMessageSchema,
		"FeedClientMessage":      feedClientMessageSchema,
		"FeedHandshakeMessage":   feedHandshakeMessageSchema,
	})
	if err != nil {
		return nil, err
	}
	artifacts := []Artifact{
		{Path: "generated/revision.txt", Content: revisionTextSource(revision)},
		{Path: "generated/go/atlasprotocol/revision.go", Content: goRevisionSource(revision)},
		{Path: "generated/go/atlasprotocol/types.go", Content: goTypesSource()},
		{Path: "generated/go/atlasprotocol/validators.go", Content: goValidatorsSource()},
		{Path: "generated/typescript/index.ts", Content: typescriptSource},
		{Path: "generated/jsonschema/entity.schema.json", Content: entitySchema},
		{Path: "generated/jsonschema/task.schema.json", Content: taskSchema},
		{Path: "generated/jsonschema/object.schema.json", Content: objectSchema},
		{Path: "generated/jsonschema/feed/client-message.schema.json", Content: feedClientMessageSchema},
		{Path: "generated/jsonschema/feed/event.schema.json", Content: feedEventSchema},
		{Path: "generated/jsonschema/feed/handshake-message.schema.json", Content: feedHandshakeMessageSchema},
		{Path: "generated/jsonschema/feed/auth-message.schema.json", Content: feedAuthMessageSchema},
		{Path: "generated/jsonschema/feed/subscribe-message.schema.json", Content: feedSubscribeMessageSchema},
		{Path: "generated/jsonschema/feed/unsubscribe-message.schema.json", Content: feedUnsubscribeMessageSchema},
		{Path: "generated/jsonschema/resources/entity-resource.schema.json", Content: entityResourceSchema},
		{Path: "generated/jsonschema/resources/metadata-block.schema.json", Content: metadataBlockSchema},
		{Path: "generated/jsonschema/resources/object-resource.schema.json", Content: objectResourceSchema},
		{Path: "generated/jsonschema/resources/task-resource.schema.json", Content: taskResourceSchema},
		{Path: "generated/jsonschema/components/telemetry.schema.json", Content: telemetrySchema},
		{Path: "generated/jsonschema/components/geometry.schema.json", Content: geometrySchema},
		{Path: "generated/jsonschema/components/task-catalog.schema.json", Content: taskCatalogSchema},
		{Path: "generated/jsonschema/components/media-refs.schema.json", Content: mediaRefsSchema},
		{Path: "generated/jsonschema/components/mil-view.schema.json", Content: milViewSchema},
		{Path: "generated/jsonschema/components/health.schema.json", Content: healthSchema},
		{Path: "generated/jsonschema/components/sensor-refs.schema.json", Content: sensorRefsSchema},
		{Path: "generated/jsonschema/components/communications.schema.json", Content: communicationsSchema},
		{Path: "generated/jsonschema/components/task-queue.schema.json", Content: taskQueueSchema},
		{Path: "generated/jsonschema/components/status.schema.json", Content: statusSchema},
		{Path: "generated/jsonschema/components/heartbeat.schema.json", Content: heartbeatSchema},
		{Path: "generated/jsonschema/components/command.schema.json", Content: commandSchema},
		{Path: "generated/jsonschema/components/task-parameters.schema.json", Content: taskParametersSchema},
		{Path: "generated/jsonschema/components/task-progress.schema.json", Content: taskProgressSchema},
		{Path: "generated/jsonschema/components/object-reference.schema.json", Content: objectReferenceSchema},
	}
	sort.Slice(artifacts, func(i, j int) bool {
		return artifacts[i].Path < artifacts[j].Path
	})
	return artifacts, nil
}

func validateEntityComponentSchemaKeys(metaKeys []string) error {
	expected := stringSet(entityComponentSchemaKeys)
	actual := stringSet(metaKeys)

	var missing []string
	for key := range actual {
		if !expected[key] {
			missing = append(missing, key)
		}
	}

	var stale []string
	for key := range expected {
		if !actual[key] {
			stale = append(stale, key)
		}
	}

	if len(missing) == 0 && len(stale) == 0 {
		return nil
	}

	sort.Strings(missing)
	sort.Strings(stale)
	return fmt.Errorf("entity component schema manifest mismatch: CUE keys missing from entityComponentSchemaKeys: %v; entityComponentSchemaKeys entries missing from CUE: %v", missing, stale)
}

func stringSet(values []string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}
