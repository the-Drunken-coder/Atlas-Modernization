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
	data, err := os.ReadFile("../../.dockerignore")
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
		"!atlas_core/",
		"!atlas_core/go.mod",
		"!atlas_core/go.sum",
		"!atlas_core/cmd/",
		"!atlas_core/cmd/**",
		"!atlas_core/command_catalog/",
		"!atlas_core/command_catalog/**",
		"!atlas_core/internal/",
		"!atlas_core/internal/**",
		"!atlas_core/atlas_core.settings.json.example",
		"!atlas_core/docker/",
		"!atlas_core/docker/Dockerfile",
		"!atlas_core/docker/production-entrypoint.sh",
		"!atlas_protocol/",
		"!atlas_protocol/go.mod",
		"!atlas_protocol/go.sum",
		"!atlas_protocol/generated/",
		"!atlas_protocol/generated/go/",
		"!atlas_protocol/generated/go/atlasprotocol/",
		"!atlas_protocol/generated/go/atlasprotocol/*.go",
		"!atlas_protocol/schema/",
		"!atlas_protocol/schema/embed.go",
		"!atlas_protocol/schema/jsonschema/",
		"!atlas_protocol/schema/jsonschema/*.json",
		"!atlas_protocol/validator/",
		"!atlas_protocol/validator/*.go",
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
	if !strings.Contains(development, "COPY atlas_core/atlas_core.settings.json.example ./atlas_core.settings.json") {
		t.Fatal("development image should keep the auth-disabled example settings for local compose")
	}

	production := dockerfileStage(t, dockerfile, "production")
	for _, forbidden := range []string{"atlas_core.settings.json.example", "./atlas_core.settings.json"} {
		if strings.Contains(production, forbidden) {
			t.Fatalf("production image must not ship settings file reference %q", forbidden)
		}
	}
	if !strings.Contains(production, "COPY atlas_core/docker/production-entrypoint.sh ./production-entrypoint.sh") {
		t.Fatal("production image should copy the fail-closed auth entrypoint")
	}
	if !strings.Contains(production, `ENTRYPOINT ["./production-entrypoint.sh"]`) {
		t.Fatal("production image should run the fail-closed auth entrypoint")
	}
}

func TestMinIOInitializationUsesSeparateCredentialsAndExplicitPolicy(t *testing.T) {
	development, err := os.ReadFile("docker-compose.yml")
	if err != nil {
		t.Fatalf("read development Compose file: %v", err)
	}
	production, err := os.ReadFile("docker-compose.production.yml")
	if err != nil {
		t.Fatalf("read production Compose file: %v", err)
	}

	for _, test := range []struct {
		filename string
		compose  string
	}{
		{filename: "docker-compose.yml", compose: string(development)},
		{filename: "docker-compose.production.yml", compose: string(production)},
	} {
		t.Run(test.filename, func(t *testing.T) {
			for _, required := range []string{
				`mc alias set myminio http://minio:9000 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD"`,
				`true|1|yes|on) mc anonymous set download "myminio/$$MINIO_BUCKET" ;;`,
				`*) mc anonymous set none "myminio/$$MINIO_BUCKET" ;;`,
			} {
				if !strings.Contains(test.compose, required) {
					t.Fatalf("%s MinIO initialization missing %q", test.filename, required)
				}
			}
			if strings.Contains(test.compose, "MC_HOST_myminio:") {
				t.Fatalf("%s must not embed operator credentials in an MC_HOST URL", test.filename)
			}
		})
	}
}

func TestProductionPersistenceMinIOUsesSeparateCredentials(t *testing.T) {
	data, err := os.ReadFile("../scripts/test_production_persistence.sh")
	if err != nil {
		t.Fatalf("read production persistence script: %v", err)
	}
	script := string(data)
	if strings.Contains(script, "MC_HOST_atlas=") {
		t.Fatal("production persistence test must not embed operator credentials in an MC_HOST URL")
	}
	if !strings.Contains(
		script,
		`mc alias set atlas http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"`,
	) {
		t.Fatal("production persistence test must pass MinIO credentials as separate arguments")
	}
	if strings.Contains(script, `test -z "$(mc diff`) {
		t.Fatal("production persistence test must not hide mc diff command failures")
	}
	for _, required := range []string{
		`if ! minio_diff="$(mc diff`,
		`test -z "${minio_diff}"`,
	} {
		if !strings.Contains(script, required) {
			t.Fatalf("production persistence test must fail closed with %q", required)
		}
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
			name:    "enabled auth case-folded placeholder key",
			env:     []string{"ENABLE_API_AUTH=true", "API_AUTH_KEY=replace_with_secure_key"},
			wantErr: true,
		},
		{
			name:    "enabled auth bootstrap placeholder key",
			env:     []string{"ENABLE_API_AUTH=true", "API_AUTH_KEY=REPLACE_WITH_STRONG_BOOTSTRAP_KEY"},
			wantErr: true,
		},
		{
			name:    "enabled auth documented placeholder key",
			env:     []string{"ENABLE_API_AUTH=true", "API_AUTH_KEY=your-secure-api-key"},
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
