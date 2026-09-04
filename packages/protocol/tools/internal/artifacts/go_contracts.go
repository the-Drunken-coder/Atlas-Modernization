package artifacts

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

const authoredGoTypesPath = "generated/go/atlasprotocol/types.go"

type goStructContract struct {
	goType          string
	definitions     []string
	syntheticFields map[string]string
	typeOverrides   map[string]goTypeOverride
}

type goTypeOverride struct {
	schemaType string
	goType     string
}

// goStructContracts is the complete ergonomic struct surface owned by
// types.go. definitions defaults to the Go type name. The exceptions describe
// intentional projections that cannot be inferred from a single schema object.
var goStructContracts = []goStructContract{
	{goType: "ErrorResponse"},
	{goType: "MetadataBlock"},
	{goType: "CommandDefinition"},
	{goType: "CommandManifestEntry"},
	{goType: "PluginOperationInteraction"},
	{goType: "PluginOperationDescriptor", typeOverrides: map[string]goTypeOverride{
		"interaction": {schemaType: "PluginOperationInteraction", goType: "*PluginOperationInteraction"},
	}},
	{goType: "PluginManifest"},
	{goType: "PluginStatus"},
	{goType: "MapArea"},
	{goType: "SpatialField"},
	{goType: "SpatialFeature", typeOverrides: map[string]goTypeOverride{
		"geometry": {schemaType: "map[string]JSONValue", goType: "JSONValue"},
	}},
	{goType: "SpatialSourceProvenance"},
	{goType: "SpatialAttribution"},
	{goType: "SpatialTruncation"},
	{goType: "SpatialOperationResult"},
	{goType: "ProtocolRevisionResponse"},
	{goType: "EntityCheckInRequest", typeOverrides: map[string]goTypeOverride{
		"status":      {schemaType: "string", goType: "*string"},
		"latitude":    {schemaType: "float64", goType: "*float64"},
		"longitude":   {schemaType: "float64", goType: "*float64"},
		"altitude_m":  {schemaType: "float64", goType: "*float64"},
		"speed_m_s":   {schemaType: "float64", goType: "*float64"},
		"heading_deg": {schemaType: "float64", goType: "*float64"},
	}},
	{goType: "EntityResource", typeOverrides: map[string]goTypeOverride{
		"command_manifest": {schemaType: "[]CommandManifestEntry", goType: "*CommandManifest"},
	}},
	{goType: "TaskResource", typeOverrides: map[string]goTypeOverride{
		"progress":     {schemaType: "float64", goType: "*float64"},
		"output":       {schemaType: "JSONValue", goType: "*JSONValue"},
		"failure":      {schemaType: "TaskFailure", goType: "*TaskFailure"},
		"cancellation": {schemaType: "TaskCancellation", goType: "*TaskCancellation"},
	}},
	{goType: "TaskFailure"},
	{goType: "TaskCancellation"},
	{goType: "TaskCreateRequest"},
	{goType: "TaskAcknowledgeRequest"},
	{goType: "TaskStartRequest"},
	{goType: "TaskProgressRequest"},
	{goType: "TaskCompleteRequest"},
	{goType: "TaskFailRequest"},
	{goType: "TaskCancelRequest"},
	{goType: "RuntimeRegistrationRequest"},
	{goType: "RuntimeStopRequest"},
	{goType: "RuntimeReadyRequest"},
	{goType: "RuntimeTaskDeliveryResponse"},
	{goType: "ObjectReference", typeOverrides: map[string]goTypeOverride{
		"entity_id": {schemaType: "string", goType: "*string"},
		"task_id":   {schemaType: "string", goType: "*string"},
	}},
	{goType: "ObjectResource"},
	{goType: "ObjectDetailResource"},
	{goType: "EntityCheckInFullResponse"},
	{goType: "EntityCheckInMinimalResponse"},
	{goType: "FullDatasetResponse"},
	{goType: "ChangedSinceResponse"},
	{goType: "FeedEvent"},
	{goType: "EntityDeleteEvent", syntheticFields: map[string]string{"event": "FeedEventDelete", "resource_type": "ResourceTypeEntity"}},
	{goType: "ObjectDeleteEvent", syntheticFields: map[string]string{"event": "FeedEventDelete", "resource_type": "ResourceTypeObject"}},
	{goType: "FeedAuthMessage"},
	{goType: "FeedSubscriptionMessage", definitions: []string{"FeedSubscribeMessage", "FeedUnsubscribeMessage"}},
	{goType: "FeedHandshakeMessage"},
	{goType: "FeedSubscriptionBarrierMessage"},
	{goType: "FeedSubscriptionsReadyMessage"},
}

type goEnumContract struct {
	goType         string
	definitions    []string
	property       string
	aliasedFields  []string
	constantPrefix string
}

var goEnumContracts = []goEnumContract{
	{goType: "ResourceType", aliasedFields: []string{"resource_type"}},
	{goType: "FeedEventName", definitions: []string{"FeedEvent"}, property: "event", aliasedFields: []string{"event"}, constantPrefix: "FeedEvent"},
	{goType: "EntityChangeReason", definitions: []string{"EntityUpdateEvent"}, property: "change_reason", aliasedFields: []string{"change_reason"}, constantPrefix: "EntityChangeReason"},
	{goType: "ErrorCode"},
	{goType: "PluginStatusState"},
	{goType: "PluginUnavailableReason"},
	{goType: "SpatialTruncationReason"},
	{goType: "CommandScheduling"},
	{goType: "TaskStatus"},
	{goType: "TaskFailureCode"},
	{goType: "TaskCancellationCode"},
	{goType: "FeedAction", definitions: []string{"FeedClientMessage"}, property: "action", aliasedFields: []string{"action"}},
	{goType: "FeedFilter", definitions: []string{"FeedSubscribeMessage", "FeedUnsubscribeMessage"}, property: "filter", aliasedFields: []string{"filter"}},
}

type parsedGoContracts struct {
	structs           map[string]map[string]goField
	stringTypes       map[string]bool
	enums             map[string][]goEnumValue
	aliases           map[string]string
	exportedTypes     map[string]bool
	exportedConstants map[string]bool
}

type goEnumValue struct {
	name  string
	value string
}

type goField struct {
	name     string
	typeName string
	optional bool
}

func validateGoContracts(root string, bundle schemaBundle) error {
	typesPath := filepath.Join(root, filepath.FromSlash(authoredGoTypesPath))
	if _, err := os.Stat(typesPath); err != nil {
		return fmt.Errorf("read authored Go contracts %s: %w", authoredGoTypesPath, err)
	}
	parsed, err := parseGoContracts(filepath.Dir(typesPath))
	if err != nil {
		return err
	}
	if err := validateGoTypeSurface(parsed); err != nil {
		return err
	}
	if parsed.aliases["JSONValue"] != "any" {
		return fmt.Errorf("go contract JSONValue must remain an alias of any, got %q", parsed.aliases["JSONValue"])
	}
	if parsed.aliases["CommandCatalog"] != "[]CommandDefinition" || parsed.aliases["CommandManifest"] != "[]CommandManifestEntry" {
		return fmt.Errorf("go command catalog and manifest aliases must retain their typed array shapes")
	}

	defs, err := schemaDefs(bundle)
	if err != nil {
		return err
	}
	if err := validateGoEnumContracts(parsed, defs); err != nil {
		return err
	}
	return validateGoStructContracts(parsed, defs)
}

func validateGoTypeSurface(parsed parsedGoContracts) error {
	expected := map[string]bool{"JSONValue": true, "CommandCatalog": true, "CommandManifest": true}
	for _, contract := range goStructContracts {
		expected[contract.goType] = true
	}
	for _, contract := range goEnumContracts {
		expected[contract.goType] = true
	}
	if actual, wanted := sortedBoolMapKeys(parsed.exportedTypes), sortedBoolMapKeys(expected); !reflect.DeepEqual(actual, wanted) {
		return fmt.Errorf("authored Go type surface drifted: Go=%v contracts=%v", actual, wanted)
	}
	return nil
}

func validateGoEnumContracts(parsed parsedGoContracts, defs map[string]any) error {
	expectedTypes := make(map[string]bool, len(goEnumContracts))
	expectedConstantNames := make(map[string]bool)
	for _, contract := range goEnumContracts {
		expectedTypes[contract.goType] = true
		if !parsed.stringTypes[contract.goType] {
			return fmt.Errorf("go enum %s must be declared with underlying type string", contract.goType)
		}
		definitions := contract.definitions
		if len(definitions) == 0 {
			definitions = []string{contract.goType}
		}
		expected, err := schemaStringValues(defs, definitions, contract.property)
		if err != nil {
			return fmt.Errorf("go enum %s: %w", contract.goType, err)
		}
		prefix := contract.constantPrefix
		if prefix == "" {
			prefix = contract.goType
		}
		expectedConstants := make([]string, 0, len(expected))
		for _, value := range expected {
			name := prefix + goConstantSuffix(value)
			expectedConstantNames[name] = true
			expectedConstants = append(expectedConstants, name+"="+value)
		}
		actualConstants := make([]string, 0, len(parsed.enums[contract.goType]))
		for _, constant := range parsed.enums[contract.goType] {
			actualConstants = append(actualConstants, constant.name+"="+constant.value)
		}
		sort.Strings(expectedConstants)
		sort.Strings(actualConstants)
		if !reflect.DeepEqual(actualConstants, expectedConstants) {
			return fmt.Errorf("go enum %s drifted from schema: Go=%v schema=%v", contract.goType, actualConstants, expectedConstants)
		}
	}

	var unexpected []string
	for typeName := range parsed.enums {
		if ast.IsExported(typeName) && !expectedTypes[typeName] {
			unexpected = append(unexpected, typeName)
		}
	}
	sort.Strings(unexpected)
	if len(unexpected) > 0 {
		return fmt.Errorf("authored Go enums missing schema contracts: %v", unexpected)
	}
	actualConstants := cloneBoolMap(parsed.exportedConstants)
	delete(actualConstants, "ProtocolRevision")
	delete(actualConstants, "CommandCatalogJSON")
	if actual, expected := sortedBoolMapKeys(actualConstants), sortedBoolMapKeys(expectedConstantNames); !reflect.DeepEqual(actual, expected) {
		return fmt.Errorf("authored Go constant surface drifted: Go=%v contracts=%v", actual, expected)
	}
	return nil
}

func validateGoStructContracts(parsed parsedGoContracts, defs map[string]any) error {
	structTypes := make(map[string]bool, len(goStructContracts))
	for _, contract := range goStructContracts {
		structTypes[contract.goType] = true
	}
	if actual := sortedMapKeys(parsed.structs); !reflect.DeepEqual(actual, sortedBoolMapKeys(structTypes)) {
		return fmt.Errorf("authored Go struct surface drifted: Go=%v contracts=%v", actual, sortedBoolMapKeys(structTypes))
	}

	enumTypes := make(map[string]bool, len(goEnumContracts))
	enumByField := make(map[string]string)
	enumValues := make(map[string]map[string]bool, len(goEnumContracts))
	for _, contract := range goEnumContracts {
		enumTypes[contract.goType] = true
		enumValues[contract.goType] = boolStringSet(goEnumStrings(parsed.enums[contract.goType]))
		for _, field := range contract.aliasedFields {
			enumByField[field] = contract.goType
		}
	}
	context := goSchemaContext{
		defs:        defs,
		structTypes: structTypes,
		enumTypes:   enumTypes,
		enumByField: enumByField,
		enumValues:  enumValues,
	}

	for _, contract := range goStructContracts {
		definitions := contract.definitions
		if len(definitions) == 0 {
			definitions = []string{contract.goType}
		}
		expected, err := context.structFields(definitions)
		if err != nil {
			return fmt.Errorf("go struct %s: %w", contract.goType, err)
		}
		for field, constant := range contract.syntheticFields {
			expectedField, ok := expected[field]
			if !ok || expectedField.optional {
				return fmt.Errorf("go struct %s synthetic field %s must be required by schema", contract.goType, field)
			}
			values, err := schemaStringValues(defs, definitions, field)
			if err != nil {
				return fmt.Errorf("go struct %s synthetic field %s: %w", contract.goType, field, err)
			}
			constantValue, ok := goConstantValue(parsed.enums, constant)
			if !ok || len(values) != 1 || values[0] != constantValue {
				return fmt.Errorf("go struct %s synthetic field %s drifted from %s: schema=%v Go=%q", contract.goType, field, constant, values, constantValue)
			}
			delete(expected, field)
		}
		for field, override := range contract.typeOverrides {
			expectedField, ok := expected[field]
			if !ok {
				return fmt.Errorf("go struct %s type override references unknown schema field %s", contract.goType, field)
			}
			if expectedField.typeName != override.schemaType {
				return fmt.Errorf("go struct %s field %s override requires schema type %s, got %s", contract.goType, field, override.schemaType, expectedField.typeName)
			}
			expectedField.typeName = override.goType
			expected[field] = expectedField
		}
		actual := parsed.structs[contract.goType]
		if actualKeys, expectedKeys := sortedMapKeys(actual), sortedMapKeys(expected); !reflect.DeepEqual(actualKeys, expectedKeys) {
			return fmt.Errorf("go struct %s fields drifted from schema: Go=%v schema=%v", contract.goType, actualKeys, expectedKeys)
		}
		for _, jsonName := range sortedMapKeys(expected) {
			actualField := actual[jsonName]
			expectedField := expected[jsonName]
			if actualField.name != goFieldName(jsonName) {
				return fmt.Errorf("go struct %s field %s must use Go name %s, got %s", contract.goType, jsonName, goFieldName(jsonName), actualField.name)
			}
			if actualField.typeName != expectedField.typeName {
				return fmt.Errorf("go struct %s field %s type drifted from schema: Go=%s schema=%s", contract.goType, jsonName, actualField.typeName, expectedField.typeName)
			}
			if actualField.optional != expectedField.optional {
				return fmt.Errorf("go struct %s field %s optionality drifted from schema: omitempty=%t schema-required=%t", contract.goType, jsonName, actualField.optional, !expectedField.optional)
			}
		}
	}
	return nil
}

func parseGoContracts(directory string) (parsedGoContracts, error) {
	files := token.NewFileSet()
	entries, err := os.ReadDir(directory)
	if err != nil {
		return parsedGoContracts{}, fmt.Errorf("read authored Go package %s: %w", filepath.Dir(authoredGoTypesPath), err)
	}
	var sourceFiles []*ast.File
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(files, filepath.Join(directory, entry.Name()), nil, 0)
		if err != nil {
			return parsedGoContracts{}, fmt.Errorf("parse authored Go package file %s: %w", entry.Name(), err)
		}
		sourceFiles = append(sourceFiles, file)
	}
	parsed := parsedGoContracts{
		structs:           make(map[string]map[string]goField),
		stringTypes:       make(map[string]bool),
		enums:             make(map[string][]goEnumValue),
		aliases:           make(map[string]string),
		exportedTypes:     make(map[string]bool),
		exportedConstants: make(map[string]bool),
	}
	for _, file := range sourceFiles {
		for _, declaration := range file.Decls {
			general, ok := declaration.(*ast.GenDecl)
			if !ok || general.Tok != token.TYPE {
				continue
			}
			for _, rawSpec := range general.Specs {
				spec := rawSpec.(*ast.TypeSpec)
				exported := ast.IsExported(spec.Name.Name)
				if exported {
					parsed.exportedTypes[spec.Name.Name] = true
				}
				typeName, err := goExpression(files, spec.Type)
				if err != nil {
					return parsedGoContracts{}, err
				}
				if spec.Assign.IsValid() {
					parsed.aliases[spec.Name.Name] = typeName
					if exported && spec.Name.Name != "JSONValue" && spec.Name.Name != "CommandCatalog" && spec.Name.Name != "CommandManifest" {
						return parsedGoContracts{}, fmt.Errorf("go contract %s must be a defined type or an approved collection alias", spec.Name.Name)
					}
					continue
				}
				switch typed := spec.Type.(type) {
				case *ast.StructType:
					if exported {
						fields, err := parseGoStructFields(files, typed)
						if err != nil {
							return parsedGoContracts{}, fmt.Errorf("parse Go struct %s: %w", spec.Name.Name, err)
						}
						parsed.structs[spec.Name.Name] = fields
					}
				case *ast.Ident:
					if exported && typed.Name == "string" {
						parsed.stringTypes[spec.Name.Name] = true
					}
				}
			}
		}
	}
	for _, file := range sourceFiles {
		if err := parseGoEnumConstants(file, parsed.stringTypes, parsed.enums, parsed.exportedConstants); err != nil {
			return parsedGoContracts{}, err
		}
	}
	return parsed, nil
}

func parseGoStructFields(files *token.FileSet, declaration *ast.StructType) (map[string]goField, error) {
	fields := make(map[string]goField)
	for _, field := range declaration.Fields.List {
		if len(field.Names) == 0 {
			return nil, fmt.Errorf("embedded fields are not supported")
		}
		if len(field.Names) != 1 {
			return nil, fmt.Errorf("field declarations must contain exactly one name")
		}
		if !ast.IsExported(field.Names[0].Name) {
			continue
		}
		if field.Tag == nil {
			return nil, fmt.Errorf("field %s has no json tag", field.Names[0].Name)
		}
		rawTag, err := strconv.Unquote(field.Tag.Value)
		if err != nil {
			return nil, fmt.Errorf("field %s tag: %w", field.Names[0].Name, err)
		}
		jsonTag, ok := reflect.StructTag(rawTag).Lookup("json")
		if !ok {
			return nil, fmt.Errorf("field %s has no json tag", field.Names[0].Name)
		}
		parts := strings.Split(jsonTag, ",")
		if parts[0] == "-" {
			continue
		}
		if parts[0] == "" {
			return nil, fmt.Errorf("field %s must use an explicit json name", field.Names[0].Name)
		}
		if _, exists := fields[parts[0]]; exists {
			return nil, fmt.Errorf("duplicate json field %s", parts[0])
		}
		options := make(map[string]bool, len(parts)-1)
		for _, option := range parts[1:] {
			if option != "omitempty" {
				return nil, fmt.Errorf("field %s has unsupported json option %q", field.Names[0].Name, option)
			}
			if options[option] {
				return nil, fmt.Errorf("field %s repeats json option %q", field.Names[0].Name, option)
			}
			options[option] = true
		}
		typeName, err := goExpression(files, field.Type)
		if err != nil {
			return nil, err
		}
		fields[parts[0]] = goField{name: field.Names[0].Name, typeName: typeName, optional: options["omitempty"]}
	}
	return fields, nil
}

func parseGoEnumConstants(file *ast.File, stringTypes map[string]bool, enums map[string][]goEnumValue, exported map[string]bool) error {
	for _, declaration := range file.Decls {
		general, ok := declaration.(*ast.GenDecl)
		if !ok || general.Tok != token.CONST {
			continue
		}
		var previousType string
		var previousValues []ast.Expr
		for _, rawSpec := range general.Specs {
			spec := rawSpec.(*ast.ValueSpec)
			for _, name := range spec.Names {
				if ast.IsExported(name.Name) {
					exported[name.Name] = true
				}
			}
			typeName := ""
			if ident, ok := spec.Type.(*ast.Ident); ok {
				typeName = ident.Name
			}
			values := spec.Values
			if len(values) == 0 {
				values = previousValues
				if spec.Type == nil {
					typeName = previousType
				}
			}
			previousType = typeName
			previousValues = values
			if !stringTypes[typeName] {
				continue
			}
			if len(values) != len(spec.Names) {
				return fmt.Errorf("go enum %s constants must each have one explicit string value", typeName)
			}
			for i, name := range spec.Names {
				literal, ok := values[i].(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					return fmt.Errorf("go enum constant %s must be a string literal", name.Name)
				}
				value, err := strconv.Unquote(literal.Value)
				if err != nil {
					return fmt.Errorf("go enum constant %s: %w", name.Name, err)
				}
				enums[typeName] = append(enums[typeName], goEnumValue{name: name.Name, value: value})
			}
		}
	}
	return nil
}

func goExpression(files *token.FileSet, expression ast.Expr) (string, error) {
	var output bytes.Buffer
	if err := format.Node(&output, files, expression); err != nil {
		return "", fmt.Errorf("format Go type expression: %w", err)
	}
	return output.String(), nil
}

func goFieldName(jsonName string) string {
	initialisms := map[string]string{"api": "API", "id": "ID"}
	parts := strings.Split(jsonName, "_")
	for index, part := range parts {
		if initialism := initialisms[part]; initialism != "" {
			parts[index] = initialism
			continue
		}
		if part != "" {
			parts[index] = strings.ToUpper(part[:1]) + part[1:]
		}
	}
	return strings.Join(parts, "")
}

func goConstantSuffix(value string) string {
	initialisms := map[string]string{"api": "API", "id": "ID", "json": "JSON"}
	parts := strings.FieldsFunc(strings.ToLower(value), func(character rune) bool {
		return character < 'a' || character > 'z'
	})
	for index, part := range parts {
		if initialism := initialisms[part]; initialism != "" {
			parts[index] = initialism
			continue
		}
		parts[index] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, "")
}

func boolStringSet(values []string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

func goEnumStrings(values []goEnumValue) []string {
	strings := make([]string, 0, len(values))
	for _, value := range values {
		strings = append(strings, value.value)
	}
	return strings
}

func goConstantValue(enums map[string][]goEnumValue, name string) (string, bool) {
	for _, constants := range enums {
		for _, constant := range constants {
			if constant.name == name {
				return constant.value, true
			}
		}
	}
	return "", false
}

func sortedUniqueStrings(values []string) []string {
	values = append([]string(nil), values...)
	sort.Strings(values)
	result := values[:0]
	for _, value := range values {
		if len(result) == 0 || result[len(result)-1] != value {
			result = append(result, value)
		}
	}
	return result
}

func sortedMapKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortedBoolMapKeys(values map[string]bool) []string {
	return sortedMapKeys(values)
}
