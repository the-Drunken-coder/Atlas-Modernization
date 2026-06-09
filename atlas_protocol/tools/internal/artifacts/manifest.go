package artifacts

func BuildArtifacts(root string, meta Meta) ([]Artifact, error) {
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
	goSource, err := generatedGo(meta)
	if err != nil {
		return nil, err
	}

	return []Artifact{
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
		{Path: "generated/go/atlasprotocol/protocol.generated.go", Content: goSource},
	}, nil
}
