import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AtlasAdminClient } from "../../../../atlas_sdk/src/admin.js";
import { Button } from "../../ui/primitives/controls.js";

type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; username: string }
  | { status: "unauthenticated"; error?: string }
  | { status: "error"; error: string };

type SessionResponse = { authenticated: false } | { authenticated: true; user: { username: string } };

export function AuthGate({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const checkSession = async () => {
      try {
        const data = await loadSession();
        if (cancelled) return;
        if (data.authenticated) {
          setState({ status: "authenticated", username: data.user.username });
        } else {
          setState({ status: "unauthenticated" });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ status: "error", error: errorMessage(error) });
        }
      }
    };
    const expireSession = () => setState({ status: "unauthenticated", error: "Your session has expired. Please sign in again." });

    void checkSession();
    window.addEventListener("atlas-auth-expired", expireSession);
    return () => {
      cancelled = true;
      window.removeEventListener("atlas-auth-expired", expireSession);
    };
  }, [baseUrl]);

  if (state.status === "loading") {
    return (
      <div className="app-loading">
        <span>Checking session...</span>
      </div>
    );
  }

  if (state.status === "authenticated") {
    return <>{children}</>;
  }

  if (state.status === "error") {
    return (
      <main className="login-shell">
        <div className="login-panel" role="alert">
          <div className="login-panel__header">
            <span className="login-panel__eyebrow">Atlas</span>
            <h1>Core unavailable</h1>
          </div>
          <div className="banner banner--error">{state.error}</div>
        </div>
      </main>
    );
  }

  return <LoginPanel baseUrl={baseUrl} initialError={state.error} onAuthenticated={(username) => setState({ status: "authenticated", username })} />;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSession(): Promise<SessionResponse> {
  const response = await fetch("/api/auth/me", { credentials: "include", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Session check failed (${response.status})`);
  const data = (await response.json()) as Partial<SessionResponse>;
  if (data.authenticated === false) return { authenticated: false };
  if (data.authenticated === true && data.user && typeof data.user.username === "string") {
    return { authenticated: true, user: { username: data.user.username } };
  }
  throw new Error("Session check returned an unexpected shape");
}

function LoginPanel({ baseUrl, initialError, onAuthenticated }: { baseUrl: string; initialError?: string; onAuthenticated: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);

  useEffect(() => {
    setError(initialError);
  }, [initialError]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const data = await new AtlasAdminClient({ baseUrl, credentials: "include" }).auth.login({ username, password });
      onAuthenticated(data.user.username);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell">
      <form className="login-panel" aria-label="Atlas login" onSubmit={submit}>
        <div className="login-panel__header">
          <span className="login-panel__eyebrow">Atlas</span>
          <h1>Sign in</h1>
        </div>
        <label className="field">
          <span className="field__label">Username</span>
          <input className="input" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? <div className="banner banner--error">{error}</div> : null}
        <Button type="submit" variant="primary" disabled={submitting || username.trim() === "" || password === ""}>
          {submitting ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
