package artifacts

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
)

type Meta struct {
	EntityComponentKeys  []string `json:"entityComponentKeys"`
	TaskComponentKeys    []string `json:"taskComponentKeys"`
	GeoJSONTypes         []string `json:"geoJSONTypes"`
	MaxGeometryPositions int      `json:"maxGeometryPositions"`
}

type Artifact struct {
	Path    string
	Content []byte
}

func Generate(root string, write bool) ([]string, error) {
	if err := ValidateExamples(root); err != nil {
		return nil, err
	}

	artifacts, err := BuildArtifacts(root)
	if err != nil {
		return nil, err
	}

	var drift []string
	for _, artifact := range artifacts {
		path := filepath.Join(root, filepath.FromSlash(artifact.Path))
		if write {
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(path, artifact.Content, 0o644); err != nil {
				return nil, err
			}
			continue
		}

		current, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				drift = append(drift, artifact.Path)
				continue
			}
			return nil, fmt.Errorf("read existing artifact %s: %w", artifact.Path, err)
		}
		if !bytes.Equal(current, artifact.Content) {
			drift = append(drift, artifact.Path)
		}
	}

	return drift, nil
}
