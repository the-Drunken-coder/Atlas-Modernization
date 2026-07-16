package artifacts

import (
	"fmt"
	"reflect"
	"runtime"
	"strings"

	protocolvalidator "github.com/the-drunken-coder/atlas/atlas_protocol/validator"
)

type goValidatorFunction struct {
	name               string
	params             string
	args               string
	validate           func(any) []string
	validateWithPrefix func(any, string) []string
}

var goValidatorFunctions = []goValidatorFunction{
	{name: "ValidateEntityBlob", params: "value any", args: "value", validate: protocolvalidator.ValidateEntityBlob},
	{name: "ValidateTaskBlob", params: "value any", args: "value", validate: protocolvalidator.ValidateTaskBlob},
	{name: "ValidateObjectBlob", params: "value any", args: "value", validate: protocolvalidator.ValidateObjectBlob},
	{name: "ValidateEntityResource", params: "value any", args: "value", validate: protocolvalidator.ValidateEntityResource},
	{name: "ValidateTaskResource", params: "value any", args: "value", validate: protocolvalidator.ValidateTaskResource},
	{name: "ValidateObjectResource", params: "value any", args: "value", validate: protocolvalidator.ValidateObjectResource},
	{name: "ValidateObjectDetailResource", params: "value any", args: "value", validate: protocolvalidator.ValidateObjectDetailResource},
	{name: "ValidateErrorResponse", params: "value any", args: "value", validate: protocolvalidator.ValidateErrorResponse},
	{name: "ValidateFeedEvent", params: "value any", args: "value", validate: protocolvalidator.ValidateFeedEvent},
	{name: "ValidateFeedAuthMessage", params: "value any", args: "value", validate: protocolvalidator.ValidateFeedAuthMessage},
	{name: "ValidateFeedSubscribeMessage", params: "value any", args: "value", validate: protocolvalidator.ValidateFeedSubscribeMessage},
	{name: "ValidateFeedUnsubscribeMessage", params: "value any", args: "value", validate: protocolvalidator.ValidateFeedUnsubscribeMessage},
	{name: "ValidateFeedClientMessage", params: "value any", args: "value", validate: protocolvalidator.ValidateFeedClientMessage},
	{name: "ValidateFeedHandshakeMessage", params: "value any", args: "value", validate: protocolvalidator.ValidateFeedHandshakeMessage},
	{name: "ValidateEntityComponents", params: "value any", args: "value", validate: protocolvalidator.ValidateEntityComponents},
	{name: "ValidateTaskComponents", params: "value any", args: "value", validate: protocolvalidator.ValidateTaskComponents},
	{name: "ValidateCommandComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateCommandComponent},
	{name: "ValidateTaskParametersComponent", params: "value any, fieldPrefix string", args: "value, fieldPrefix", validateWithPrefix: protocolvalidator.ValidateTaskParametersComponent},
	{name: "ValidateTaskProgressComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateTaskProgressComponent},
	{name: "ValidateTaskCatalogComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateTaskCatalogComponent},
	{name: "ValidateMediaRefsComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateMediaRefsComponent},
	{name: "ValidateMilViewComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateMilViewComponent},
	{name: "ValidateHealthComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateHealthComponent},
	{name: "ValidateSensorRefsComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateSensorRefsComponent},
	{name: "ValidateCommunicationsComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateCommunicationsComponent},
	{name: "ValidateTaskQueueComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateTaskQueueComponent},
	{name: "ValidateStatusComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateStatusComponent},
	{name: "ValidateHeartbeatComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateHeartbeatComponent},
	{name: "ValidateTelemetryComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateTelemetryComponent},
	{name: "ValidateGeometryComponent", params: "value any", args: "value", validate: protocolvalidator.ValidateGeometryComponent},
}

func validateGoValidatorFunctions(defs map[string]any) error {
	for _, function := range goValidatorFunctions {
		if (function.validate == nil) == (function.validateWithPrefix == nil) {
			return fmt.Errorf("go validator %s must have exactly one runtime implementation", function.name)
		}
		implementation := any(function.validate)
		expectedParams, expectedArgs := "value any", "value"
		if function.validateWithPrefix != nil {
			implementation = function.validateWithPrefix
			expectedParams, expectedArgs = "value any, fieldPrefix string", "value, fieldPrefix"
		}
		if function.params != expectedParams || function.args != expectedArgs {
			return fmt.Errorf("go validator %s signature manifest does not match its runtime implementation", function.name)
		}
		implementationName := runtime.FuncForPC(reflect.ValueOf(implementation).Pointer()).Name()
		implementationName = implementationName[strings.LastIndex(implementationName, ".")+1:]
		if implementationName != function.name {
			return fmt.Errorf("go validator %s points to runtime implementation %s", function.name, implementationName)
		}
		definition := strings.TrimPrefix(function.name, "Validate")
		if definition == function.name {
			return fmt.Errorf("go validator %s does not follow the Validate<Definition> convention", function.name)
		}
		if _, ok := defs[definition]; !ok {
			return fmt.Errorf("go validator %s references missing schema definition %s", function.name, definition)
		}
	}
	return nil
}

func goValidatorsSource() ([]byte, error) {
	var builder strings.Builder
	builder.WriteString("// Code generated by go run ./tools/generate; DO NOT EDIT.\n\n")
	builder.WriteString("package atlasprotocol\n\n")
	builder.WriteString("import \"github.com/the-drunken-coder/atlas/atlas_protocol/validator\"\n\n")
	for i, fn := range goValidatorFunctions {
		if i > 0 {
			builder.WriteString("\n")
		}
		builder.WriteString("func ")
		builder.WriteString(fn.name)
		builder.WriteString("(")
		builder.WriteString(fn.params)
		builder.WriteString(") []string {\n\treturn validator.")
		builder.WriteString(fn.name)
		builder.WriteString("(")
		builder.WriteString(fn.args)
		builder.WriteString(")\n}\n")
	}
	return formatGeneratedGoSource(builder.String())
}
