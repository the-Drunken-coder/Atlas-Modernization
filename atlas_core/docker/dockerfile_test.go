package docker_test

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

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
			name:    "destructive database mode",
			env:     []string{"DATABASE_RECREATE_ON_STARTUP=true", "ENABLE_API_AUTH=true", "API_AUTH_KEY=real-production-secret", "ATLAS_ADMIN_PASSWORD=real-admin-secret"},
			wantErr: true,
		},
		{
			name:    "enabled auth real key and admin password",
			env:     []string{"ENABLE_API_AUTH=TRUE", "API_AUTH_KEY=real-production-secret", "ATLAS_ADMIN_PASSWORD=real-admin-secret"},
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
