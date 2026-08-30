package docker_test

import (
	"os"
	"os/exec"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestRootDockerignoreAllowsOnlyDockerfileInputs(t *testing.T) {
	data, err := os.ReadFile("../../../.dockerignore")
	if err != nil {
		t.Fatalf("read root .dockerignore: %v", err)
	}

	var patterns []string
	var included []string
	for _, line := range strings.Split(string(data), "\n") {
		pattern := strings.TrimSpace(line)
		if pattern == "" || strings.HasPrefix(pattern, "#") {
			continue
		}
		patterns = append(patterns, pattern)
		if strings.HasPrefix(pattern, "!") {
			included = append(included, pattern)
		}
	}

	if len(patterns) == 0 || patterns[0] != "*" {
		t.Fatal("root .dockerignore must exclude the build context before adding required inputs")
	}
	wantIncluded := []string{
		"!services/core/",
		"!services/core/go.mod",
		"!services/core/go.sum",
		"!services/core/cmd/",
		"!services/core/cmd/**",
		"!services/core/internal/",
		"!services/core/internal/**",
		"!services/core/atlas_core.settings.json.example",
		"!services/core/docker/",
		"!services/core/docker/Dockerfile",
		"!services/core/docker/production-entrypoint.sh",
		"!packages/protocol/",
		"!packages/protocol/go.mod",
		"!packages/protocol/go.sum",
		"!packages/protocol/generated/",
		"!packages/protocol/generated/go/",
		"!packages/protocol/generated/go/atlasprotocol/",
		"!packages/protocol/generated/go/atlasprotocol/*.go",
		"!packages/protocol/generated/typescript/",
		"!packages/protocol/generated/typescript/*.ts",
		"!packages/protocol/schema/",
		"!packages/protocol/schema/embed.go",
		"!packages/protocol/schema/jsonschema/",
		"!packages/protocol/schema/jsonschema/*.json",
		"!packages/protocol/validator/",
		"!packages/protocol/validator/*.go",
		"!package.json",
		"!package-lock.json",
		"!packages/sdk/",
		"!packages/sdk/package.json",
		"!packages/sdk/tsconfig.json",
		"!packages/sdk/src/",
		"!packages/sdk/src/**",
		"!packages/sdk/scripts/",
		"!packages/sdk/scripts/**",
		"!packages/plugin-runtime/",
		"!packages/plugin-runtime/package.json",
		"!packages/plugin-runtime/tsconfig.json",
		"!packages/plugin-runtime/src/",
		"!packages/plugin-runtime/src/**",
		"!plugins/",
		"!plugins/reference/",
		"!plugins/reference/package.json",
		"!plugins/reference/tsconfig.json",
		"!plugins/reference/src/",
		"!plugins/reference/src/**",
		"!plugins/reference/fixture-source.mjs",
		"!plugins/reference/Dockerfile",
		"!packages/fieldlink/package.json",
		"!surfaces/",
		"!surfaces/command-interface/",
		"!surfaces/command-interface/package.json",
		"!simulations/package.json",
	}
	if !slices.Equal(included, wantIncluded) {
		t.Fatalf("root .dockerignore includes = %v, want only Dockerfile inputs %v", included, wantIncluded)
	}
}

func TestDockerfileKeepsAuthDisabledSettingsOutOfProductionImage(t *testing.T) {
	data, err := os.ReadFile("Dockerfile")
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	dockerfile := string(data)

	development := dockerfileStage(t, dockerfile, "development")
	if !strings.Contains(development, "COPY services/core/atlas_core.settings.json.example ./atlas_core.settings.json") {
		t.Fatal("development image should keep the auth-disabled example settings for local compose")
	}

	production := dockerfileStage(t, dockerfile, "production")
	for _, forbidden := range []string{"atlas_core.settings.json.example", "./atlas_core.settings.json"} {
		if strings.Contains(production, forbidden) {
			t.Fatalf("production image must not ship settings file reference %q", forbidden)
		}
	}
	if !strings.Contains(production, "COPY services/core/docker/production-entrypoint.sh ./production-entrypoint.sh") {
		t.Fatal("production image should copy the fail-closed auth entrypoint")
	}
	if !strings.Contains(production, "COPY --from=builder /app/atlas_source_gateway .") {
		t.Fatal("production image should include the Source Gateway binary for packaged Compose")
	}
	if !strings.Contains(production, `ENTRYPOINT ["./production-entrypoint.sh"]`) {
		t.Fatal("production image should run the fail-closed auth entrypoint")
	}
}

func TestProductionEntrypointRequiresExplicitAPIAuth(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("production entrypoint is a POSIX shell script")
	}

	tests := []struct {
		name    string
		env     []string
		wantErr bool
	}{
		{
			name:    "missing auth env",
			wantErr: true,
		},
		{
			name:    "disabled auth env",
			env:     []string{"ENABLE_API_AUTH=false", "API_AUTH_KEY=real-production-secret"},
			wantErr: true,
		},
		{
			name:    "enabled auth empty key",
			env:     []string{"ENABLE_API_AUTH=true", "API_AUTH_KEY="},
			wantErr: true,
		},
		{
			name:    "enabled auth placeholder key",
			env:     []string{"ENABLE_API_AUTH=true", "API_AUTH_KEY=REPLACE_WITH_SECURE_KEY"},
			wantErr: true,
		},
		{
			name:    "enabled auth real key missing admin password",
			env:     []string{"ENABLE_API_AUTH=true", "API_AUTH_KEY=real-production-secret"},
			wantErr: true,
		},
		{
			name:    "development admin password",
			env:     []string{"ENABLE_API_AUTH=true", "API_AUTH_KEY=real-production-secret", "ATLAS_ADMIN_PASSWORD=password"},
			wantErr: true,
		},
		{
			name:    "eleven-character admin password",
			env:     []string{"ENABLE_API_AUTH=true", "API_AUTH_KEY=real-production-secret", "ATLAS_ADMIN_PASSWORD=aaaaaaaaaaa"},
			wantErr: true,
		},
		{
			name:    "example admin password placeholder",
			env:     []string{"ENABLE_API_AUTH=true", "API_AUTH_KEY=real-production-secret", "ATLAS_ADMIN_PASSWORD=REPLACE_WITH_SECURE_ADMIN_PASSWORD"},
			wantErr: true,
		},
		{
			name:    "documented admin password placeholder",
			env:     []string{"ENABLE_API_AUTH=true", "API_AUTH_KEY=real-production-secret", "ATLAS_ADMIN_PASSWORD=your-secure-admin-password"},
			wantErr: true,
		},
		{
			name:    "deployment runbook admin password placeholder",
			env:     []string{"ENABLE_API_AUTH=true", "API_AUTH_KEY=real-production-secret", "ATLAS_ADMIN_PASSWORD=replace-with-secure-admin-password"},
			wantErr: true,
		},
		{
			name:    "destructive database mode",
			env:     []string{"DATABASE_RECREATE_ON_STARTUP=true", "ENABLE_API_AUTH=true", "API_AUTH_KEY=real-production-secret", "ATLAS_ADMIN_PASSWORD=real-admin-secret"},
			wantErr: true,
		},
		{
			name:    "enabled auth real key and twelve-character admin password",
			env:     []string{"ENABLE_API_AUTH=TRUE", "API_AUTH_KEY=real-production-secret", "ATLAS_ADMIN_PASSWORD=aaaaaaaaaaaa"},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := exec.Command("/bin/sh", "production-entrypoint.sh", "/bin/sh", "-c", "exit 0")
			cmd.Env = append([]string{"PATH=" + os.Getenv("PATH")}, tt.env...)
			output, err := cmd.CombinedOutput()

			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected entrypoint to fail, output: %s", output)
				}
				if !strings.Contains(string(output), "Refusing to start production Atlas Core image") {
					t.Fatalf("expected fail-closed message, got: %s", output)
				}
				return
			}
			if err != nil {
				t.Fatalf("expected entrypoint to run command, err: %v, output: %s", err, output)
			}
		})
	}
}

func dockerfileStage(t *testing.T, dockerfile, stage string) string {
	t.Helper()

	var lines []string
	inStage := false
	for _, line := range strings.Split(dockerfile, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "FROM ") {
			if inStage {
				break
			}
			inStage = strings.HasSuffix(trimmed, " AS "+stage)
		}
		if inStage {
			lines = append(lines, line)
		}
	}

	if len(lines) == 0 {
		t.Fatalf("Dockerfile stage %q not found", stage)
	}
	return strings.Join(lines, "\n")
}
