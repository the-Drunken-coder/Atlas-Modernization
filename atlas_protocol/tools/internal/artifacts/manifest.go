package artifacts

import (
	"fmt"
	"sort"
)

var entityComponentSchemaKeys = []string{
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

var artifactDefinitions = []string{
	"EntityBlob",
	"TaskBlob",
	"ObjectBlob",
	"ErrorResponse",
	"FeedClientMessage",
	"FeedEvent",
	"FeedHandshakeMessage",
	"FeedAuthMessage",
	"FeedSubscribeMessage",
	"FeedUnsubscribeMessage",
	"EntityResource",
	"MetadataBlock",
	"ObjectResource",
	"TaskResource",
	"TelemetryComponent",
	"GeometryComponent",
	"TaskCatalogComponent",
	"MediaRefsComponent",
	"MilViewComponent",
	"HealthComponent",
	"SensorRefsComponent",
	"CommunicationsComponent",
	"TaskQueueComponent",
	"StatusComponent",
	"HeartbeatComponent",
	"CommandComponent",
	"TaskParametersComponent",
	"TaskProgressComponent",
	"ObjectReference",
	"EntityCreateRequest",
	"EntityUpdateRequest",
	"ObjectCreateRequest",
	"ObjectUpdateRequest",
	"TaskCreateRequest",
	"TaskUpdateRequest",
}

func BuildArtifacts(root string) ([]Artifact, error) {
	bundle, err := LoadSchemaBundle(root)
	if err != nil {
		return nil, err
	}
	if err := validateEntityComponentSchemaKeys(bundle); err != nil {
		return nil, err
	}
	revision, err := protocolRevision(root)
	if err != nil {
		return nil, err
	}

	typescriptSchemas := make(map[string][]byte, len(artifactDefinitions))
	for _, definition := range artifactDefinitions {
		schema, err := schemaDocumentForDefinition(bundle, definition, revision)
		if err != nil {
			return nil, err
		}
		typescriptSchemas[definition] = schema
	}
	typescriptSource, err := typeScriptSource(revision, typescriptSchemas)
	if err != nil {
		return nil, err
	}
	goRevision, err := goRevisionSource(revision)
	if err != nil {
		return nil, err
	}
	goTypes, err := goTypesSource()
	if err != nil {
		return nil, err
	}
	goValidators, err := goValidatorsSource()
	if err != nil {
		return nil, err
	}

	artifacts := []Artifact{
		{Path: "generated/revision.txt", Content: revisionTextSource(revision)},
		{Path: "generated/go/atlasprotocol/revision.go", Content: goRevision},
		{Path: "generated/go/atlasprotocol/types.go", Content: goTypes},
		{Path: "generated/go/atlasprotocol/validators.go", Content: goValidators},
		{Path: "generated/typescript/index.ts", Content: typescriptSource},
	}
	sort.Slice(artifacts, func(i, j int) bool {
		return artifacts[i].Path < artifacts[j].Path
	})
	return artifacts, nil
}

func validateEntityComponentSchemaKeys(bundle schemaBundle) error {
	defs, err := schemaDefs(bundle)
	if err != nil {
		return err
	}
	entityComponents, ok := defs["EntityComponents"].(map[string]any)
	if !ok {
		return fmt.Errorf("EntityComponents schema definition not found")
	}
	properties, ok := entityComponents["properties"].(map[string]any)
	if !ok {
		return fmt.Errorf("EntityComponents schema has no properties")
	}

	expected := stringSet(entityComponentSchemaKeys)
	actual := make(map[string]bool, len(properties))
	for key := range properties {
		actual[key] = true
	}

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
	return fmt.Errorf("entity component schema manifest mismatch: schema keys missing from entityComponentSchemaKeys: %v; entityComponentSchemaKeys entries missing from schema: %v", missing, stale)
}

func stringSet(values []string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}
