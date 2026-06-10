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

	entitySchema, err := jsonSchema(root, "#EntityBlob")
	if err != nil {
		return nil, err
	}
	telemetrySchema, err := jsonSchema(root, "#TelemetryComponent")
	if err != nil {
		return nil, err
	}
	geometrySchema, err := jsonSchema(root, "#GeometryComponent")
	if err != nil {
		return nil, err
	}
	taskCatalogSchema, err := jsonSchema(root, "#TaskCatalogComponent")
	if err != nil {
		return nil, err
	}
	mediaRefsSchema, err := jsonSchema(root, "#MediaRefsComponent")
	if err != nil {
		return nil, err
	}
	milViewSchema, err := jsonSchema(root, "#MilViewComponent")
	if err != nil {
		return nil, err
	}
	healthSchema, err := jsonSchema(root, "#HealthComponent")
	if err != nil {
		return nil, err
	}
	sensorRefsSchema, err := jsonSchema(root, "#SensorRefsComponent")
	if err != nil {
		return nil, err
	}
	communicationsSchema, err := jsonSchema(root, "#CommunicationsComponent")
	if err != nil {
		return nil, err
	}
	taskQueueSchema, err := jsonSchema(root, "#TaskQueueComponent")
	if err != nil {
		return nil, err
	}
	statusSchema, err := jsonSchema(root, "#StatusComponent")
	if err != nil {
		return nil, err
	}
	heartbeatSchema, err := jsonSchema(root, "#HeartbeatComponent")
	if err != nil {
		return nil, err
	}
	entitySchema, err = hydrateEntityComponentDefs(
		entitySchema,
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
	)
	if err != nil {
		return nil, err
	}
	taskSchema, err := jsonSchema(root, "#TaskBlob")
	if err != nil {
		return nil, err
	}
	commandSchema, err := jsonSchema(root, "#CommandComponent")
	if err != nil {
		return nil, err
	}
	taskParametersSchema, err := jsonSchema(root, "#TaskParametersComponent")
	if err != nil {
		return nil, err
	}
	taskProgressSchema, err := jsonSchema(root, "#TaskProgressComponent")
	if err != nil {
		return nil, err
	}
	objectSchema, err := jsonSchema(root, "#ObjectBlob")
	if err != nil {
		return nil, err
	}
	objectReferenceSchema, err := jsonSchema(root, "#ObjectReference")
	if err != nil {
		return nil, err
	}
	artifacts := []Artifact{
		{Path: "generated/jsonschema/entity.schema.json", Content: entitySchema},
		{Path: "generated/jsonschema/task.schema.json", Content: taskSchema},
		{Path: "generated/jsonschema/object.schema.json", Content: objectSchema},
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
