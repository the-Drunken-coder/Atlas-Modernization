import { AtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import { AtlasAdminClient } from "@the-drunken-coder/atlas-sdk/admin";
import { Component, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { ConnectionBadge } from "../../ui/ConnectionBadge.js";
import { Button } from "../../ui/primitives/controls.js";
import { AccountMenu } from "./AccountMenu.js";

type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; username: string }
  | { status: "unauthenticated"; error?: string }
  | { status: "error"; error: string };

type SessionResponse = { authenticated: false } | { authenticated: true; user: { username: string } };

export function AuthGate({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const focusErrorAfterRetryRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const checkSession = async () => {
      try {
        const data = await loadSession(baseUrl);
        if (cancelled) return;
        if (data.authenticated) {
          setState({ status: "authenticated", username: data.user.username });
        } else {
          setState({ status: "unauthenticated" });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ status: "error", error: sanitizeConnectionError(error) });
        }
      }
    };
    const expireSession = () =>
      setState({ status: "unauthenticated", error: "Your session has expired. Please sign in again." });

    void checkSession();
    window.addEventListener("atlas-auth-expired", expireSession);
    return () => {
      cancelled = true;
      window.removeEventListener("atlas-auth-expired", expireSession);
    };
  }, [baseUrl, sessionAttempt]);

  if (state.status === "loading") {
    return (
      <div className="app-loading">
        <span>Checking session...</span>
      </div>
    );
  }

  if (state.status === "authenticated") {
    return (
      <AuthenticatedShell
        baseUrl={baseUrl}
        username={state.username}
        onLoggedOut={() => setState({ status: "unauthenticated" })}
      >
        {children}
      </AuthenticatedShell>
    );
  }

  if (state.status === "error") {
    return (
      <main className="login-shell">
        <ConnectionBadge
          health={{ running: false, healthy: false, degraded: false }}
          error={{ source: "startup", message: state.error }}
          focusOnMount={focusErrorAfterRetryRef.current}
          onRetry={() => {
            focusErrorAfterRetryRef.current = true;
            setState({ status: "loading" });
            setSessionAttempt((attempt) => attempt + 1);
          }}
        />
        <div className="login-panel" role="alert">
          <div className="login-panel__header">
            <span className="login-panel__eyebrow">Atlas</span>
            <h1>Core unavailable</h1>
          </div>
          <p>Open the connection error for details and retry.</p>
        </div>
      </main>
    );
  }

  return (
    <LoginPanel
      baseUrl={baseUrl}
      initialError={state.error}
      onAuthenticated={(username) => setState({ status: "authenticated", username })}
    />
  );
}

function AuthenticatedShell({
  baseUrl,
  username,
  children,
  onLoggedOut
}: {
  baseUrl: string;
  username: string;
  children: ReactNode;
  onLoggedOut: () => void;
}) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string>();

  const logout = async () => {
    setLoggingOut(true);
    setError(undefined);
    try {
      await new AtlasAdminClient({ baseUrl, credentials: "include" }).auth.logout();
      onLoggedOut();
    } catch (cause) {
      setError(sanitizeConnectionError(cause));
      setLoggingOut(false);
    }
  };

  return (
    <section className="authenticated-shell">
      <AccountMenu username={username} loggingOut={loggingOut} error={error} onLogout={() => void logout()} />
      <WorkspaceErrorBoundary
        loggingOut={loggingOut}
        logoutError={error}
        onRetry={() => window.location.reload()}
        onLogout={() => void logout()}
      >
        {children}
      </WorkspaceErrorBoundary>
    </section>
  );
}

export class WorkspaceErrorBoundary extends Component<
  { children: ReactNode; loggingOut: boolean; logoutError?: string; onRetry: () => void; onLogout: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="app-error" role="alert">
        <span>The map workspace failed to load.</span>
        <div>
          <Button variant="primary" onClick={this.props.onRetry}>
            Retry
          </Button>
          <Button variant="ghost" disabled={this.props.loggingOut} onClick={this.props.onLogout}>
            {this.props.loggingOut ? "Logging out..." : "Log out"}
          </Button>
        </div>
        {this.props.logoutError ? <span className="app-error__detail">{this.props.logoutError}</span> : null}
      </div>
    );
  }
}

async function loadSession(baseUrl: string): Promise<SessionResponse> {
  try {
    const data = await new AtlasAdminClient({ baseUrl, credentials: "include" }).auth.me();
    return { authenticated: true, user: { username: data.user.username } };
  } catch (error) {
    if (error instanceof AtlasAPIError && error.status === 401) return { authenticated: false };
    throw error;
  }
}

function LoginPanel({
  baseUrl,
  initialError,
  onAuthenticated
}: {
  baseUrl: string;
  initialError?: string;
  onAuthenticated: (username: string) => void;
}) {
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
      setError(sanitizeConnectionError(cause));
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
          <input
            className="input"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
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
