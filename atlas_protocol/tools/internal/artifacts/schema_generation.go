package artifacts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const cueVersion = "v0.16.1"
const cueCommandTimeout = 2 * time.Minute

func ValidateExamples(root string) error {
	if err := validateExampleSet(root, "entities", "#EntityBlob"); err != nil {
		return err
	}
	if err := validateExampleSet(root, "tasks", "#TaskBlob"); err != nil {
		return err
	}
	if err := validateExampleSet(root, "objects", "#ObjectBlob"); err != nil {
		return err
	}
	if err := validateExampleSet(root, "feed/events", "#FeedEvent"); err != nil {
		return err
	}
	if err := validateExampleSet(root, "feed/messages", "#FeedClientMessage"); err != nil {
		return err
	}
	return validateExampleSet(root, "feed/server", "#FeedHandshakeMessage")
}

func validateExampleSet(root, name, schema string) error {
	examples, err := filepath.Glob(filepath.Join(root, "examples", name, "*.json"))
	if err != nil {
		return err
	}
	if len(examples) == 0 {
		return fmt.Errorf("no %s examples found", name)
	}
	sort.Strings(examples)

	for _, example := range examples {
		rel, err := filepath.Rel(root, example)
		if err != nil {
			return err
		}
		args := []string{"vet", "./schema", filepath.ToSlash(rel), "-d", schema}
		if _, err := runCue(root, args...); err != nil {
			return err
		}
	}
	return nil
}

func LoadMeta(root string) (Meta, error) {
	out, err := runCue(root, "export", "./schema", "-e", "#Meta")
	if err != nil {
		return Meta{}, err
	}

	var meta Meta
	if err := json.Unmarshal(out, &meta); err != nil {
		return Meta{}, err
	}
	if len(meta.EntityComponentKeys) == 0 {
		return Meta{}, fmt.Errorf("protocol metadata has no entity component keys")
	}
	if len(meta.TaskComponentKeys) == 0 {
		return Meta{}, fmt.Errorf("protocol metadata has no task component keys")
	}
	if meta.MaxGeometryPositions < 1 {
		return Meta{}, fmt.Errorf("protocol metadata has invalid maxGeometryPositions: %d", meta.MaxGeometryPositions)
	}
	return meta, nil
}

func jsonSchema(root, expr, revision string) ([]byte, error) {
	args := []string{"def", "./schema", "--out=jsonschema", "-e", expr}
	out, err := runCue(root, args...)
	if err != nil {
		return nil, err
	}
	return markGeneratedJSONSchema(out, revision)
}

func runCue(root string, args ...string) ([]byte, error) {
	goArgs := append([]string{"run", "cuelang.org/go/cmd/cue@" + cueVersion}, args...)
	ctx, cancel := context.WithTimeout(context.Background(), cueCommandTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "go", goArgs...)
	cmd.Dir = root
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		return nil, fmt.Errorf("cue %s failed: %w\n%s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}
