package artifacts

import (
	"bytes"
	"fmt"
	"go/format"
	"strings"
	"text/template"
)

type goTemplateData struct {
	EntityComponentConstants string
	TaskComponentConstants   string
	EntityComponentKeyArray  string
	TaskComponentKeyArray    string
	MaxGeometryPositions     int
	ComponentsJSONTag        string
	PublishedAtJSONTag       string
	ExtraJSONTag             string
	BucketJSONTag            string
	SizeBytesJSONTag         string
	UsageHintsJSONTag        string
	ReferencedByJSONTag      string
	EntityIDJSONTag          string
	TaskIDJSONTag            string
	LatitudeJSONTag          string
	LongitudeJSONTag         string
	AltitudeMJSONTag         string
	SpeedMSJSONTag           string
	HeadingDegJSONTag        string
	LastUpdateJSONTag        string
	SupportedTasksJSONTag    string
	ObjectIDJSONTag          string
	RoleJSONTag              string
	ClassificationJSONTag    string
	LastSeenJSONTag          string
	BatteryPercentJSONTag    string
	SensorIDJSONTag          string
	TypeJSONTag              string
	HorizontalFOVJSONTag     string
	VerticalFOVJSONTag       string
	HorizontalOrientJSONTag  string
	VerticalOrientJSONTag    string
	LinkStateJSONTag         string
	CurrentTaskIDJSONTag     string
	QueuedTaskIDsJSONTag     string
	ValueJSONTag             string
}

func generatedGo(meta Meta) ([]byte, error) {
	data := goTemplateData{
		EntityComponentConstants: componentConstants("Component", meta.EntityComponentKeys),
		TaskComponentConstants:   componentConstants("TaskComponent", meta.TaskComponentKeys),
		EntityComponentKeyArray:  quotedArray(meta.EntityComponentKeys),
		TaskComponentKeyArray:    quotedArray(meta.TaskComponentKeys),
		MaxGeometryPositions:     meta.MaxGeometryPositions,
		ComponentsJSONTag:        "`json:\"components,omitempty\"`",
		PublishedAtJSONTag:       "`json:\"published_at,omitempty\"`",
		ExtraJSONTag:             "`json:\"-\"`",
		BucketJSONTag:            "`json:\"bucket,omitempty\"`",
		SizeBytesJSONTag:         "`json:\"size_bytes,omitempty\"`",
		UsageHintsJSONTag:        "`json:\"usage_hints,omitempty\"`",
		ReferencedByJSONTag:      "`json:\"referenced_by,omitempty\"`",
		EntityIDJSONTag:          "`json:\"entity_id,omitempty\"`",
		TaskIDJSONTag:            "`json:\"task_id,omitempty\"`",
		LatitudeJSONTag:          "`json:\"latitude,omitempty\"`",
		LongitudeJSONTag:         "`json:\"longitude,omitempty\"`",
		AltitudeMJSONTag:         "`json:\"altitude_m,omitempty\"`",
		SpeedMSJSONTag:           "`json:\"speed_m_s,omitempty\"`",
		HeadingDegJSONTag:        "`json:\"heading_deg,omitempty\"`",
		LastUpdateJSONTag:        "`json:\"last_update,omitempty\"`",
		SupportedTasksJSONTag:    "`json:\"supported_tasks,omitempty\"`",
		ObjectIDJSONTag:          "`json:\"object_id\"`",
		RoleJSONTag:              "`json:\"role\"`",
		ClassificationJSONTag:    "`json:\"classification,omitempty\"`",
		LastSeenJSONTag:          "`json:\"last_seen,omitempty\"`",
		BatteryPercentJSONTag:    "`json:\"battery_percent,omitempty\"`",
		SensorIDJSONTag:          "`json:\"sensor_id\"`",
		TypeJSONTag:              "`json:\"type\"`",
		HorizontalFOVJSONTag:     "`json:\"horizontal_fov,omitempty\"`",
		VerticalFOVJSONTag:       "`json:\"vertical_fov,omitempty\"`",
		HorizontalOrientJSONTag:  "`json:\"horizontal_orientation,omitempty\"`",
		VerticalOrientJSONTag:    "`json:\"vertical_orientation,omitempty\"`",
		LinkStateJSONTag:         "`json:\"link_state,omitempty\"`",
		CurrentTaskIDJSONTag:     "`json:\"current_task_id,omitempty\"`",
		QueuedTaskIDsJSONTag:     "`json:\"queued_task_ids,omitempty\"`",
		ValueJSONTag:             "`json:\"value\"`",
	}

	tmpl, err := template.New("go").Parse(generatedGoTemplate)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return nil, err
	}

	formatted, err := format.Source(buf.Bytes())
	if err != nil {
		return nil, fmt.Errorf("format generated Go: %w", err)
	}
	return formatted, nil
}

func componentConstants(prefix string, keys []string) string {
	var buf strings.Builder
	for _, key := range keys {
		fmt.Fprintf(&buf, "\t%s%s = %q\n", prefix, goIdentifier(key), key)
	}
	return strings.TrimRight(buf.String(), "\n")
}

func quotedArray(values []string) string {
	var buf strings.Builder
	buf.WriteString("[]string{")
	for i, value := range values {
		if i > 0 {
			buf.WriteString(", ")
		}
		fmt.Fprintf(&buf, "%q", value)
	}
	buf.WriteString("}")
	return buf.String()
}

func goIdentifier(value string) string {
	parts := strings.Split(value, "_")
	var out strings.Builder
	for _, part := range parts {
		if part == "" {
			out.WriteString("Underscore")
			continue
		}
		out.WriteString(strings.ToUpper(part[:1]) + part[1:])
	}
	return out.String()
}
