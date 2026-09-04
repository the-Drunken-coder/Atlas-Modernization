import { Alert, Callout } from "@blueprintjs/core";
import type { AdminAPIKey, AdminCreatedAPIKey } from "@the-drunken-coder/atlas-sdk/admin";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { createAuthenticatedAtlasAdminClient } from "../../auth/atlas.js";
import { useAtlas } from "../../state/atlas-context.js";
import { Button, IconButton, TextField } from "../../ui/primitives/controls.js";
import { CopyIcon, PlusIcon, TrashIcon } from "../../ui/primitives/icons.js";

type LoadState = "loading" | "ready" | "error";

export function APIKeysPanel() {
  const { config } = useAtlas();
  const [keys, setKeys] = useState<AdminAPIKey[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [name, setName] = useState("");
  const [generated, setGenerated] = useState<AdminCreatedAPIKey>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const [keyToRevoke, setKeyToRevoke] = useState<AdminAPIKey>();
  const [listAttempt, setListAttempt] = useState(0);
  const mutationRevisionRef = useRef(0);
  const refreshing = loadState === "loading";

  const admin = useMemo(
    () => (config ? createAuthenticatedAtlasAdminClient(config.atlasBaseUrl) : undefined),
    [config]
  );

  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    const mutationRevision = mutationRevisionRef.current;
    setLoadState("loading");
    setError(undefined);
    setKeyToRevoke(undefined);
    void admin.apiKeys
      .list()
      .then((next) => {
        if (!cancelled) {
          if (mutationRevisionRef.current === mutationRevision) setKeys(next);
          setLoadState("ready");
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(sanitizeConnectionError(cause));
          setLoadState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [admin, listAttempt]);

  const createKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!admin || refreshing || name.trim() === "") return;
    setSubmitting(true);
    setGenerated(undefined);
    setCopied(false);
    setError(undefined);
    try {
      const created = await admin.apiKeys.create({ name });
      mutationRevisionRef.current += 1;
      setGenerated(created);
      setKeys((current) => [created, ...current.filter((key) => key.id !== created.id)]);
      setName("");
      setLoadState((current) => (current === "loading" ? current : "ready"));
    } catch (cause) {
      setError(sanitizeConnectionError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const copyGenerated = async () => {
    if (!generated) return;
    setError(undefined);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(generated.api_key);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("Failed to copy key to clipboard.");
    }
  };

  const revokeKey = async (key: AdminAPIKey) => {
    if (!admin || refreshing || revoking) return;
    setRevoking(key.id);
    setError(undefined);
    try {
      await admin.apiKeys.revoke(key.id);
      mutationRevisionRef.current += 1;
      setKeys((current) => current.filter((entry) => entry.id !== key.id));
      if (generated?.id === key.id) setGenerated(undefined);
    } catch (cause) {
      setError(sanitizeConnectionError(cause));
    } finally {
      setRevoking(undefined);
    }
  };

  if (refreshing && keys.length === 0) {
    return <div className="panel__empty">Loading API keys...</div>;
  }

  return (
    <div className="api-keys-panel">
      <form className="api-key-create" onSubmit={createKey}>
        <TextField label="Name" value={name} disabled={refreshing} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" variant="primary" disabled={refreshing || submitting || name.trim() === ""}>
          <PlusIcon size={16} />
          <span>{submitting ? "Creating" : "Create"}</span>
        </Button>
      </form>

      {error ? (
        <Callout className="banner banner--error" intent="danger" icon={null} compact role="alert">
          {error}
          {loadState === "error" ? (
            <Button variant="ghost" onClick={() => setListAttempt((current) => current + 1)}>
              Retry
            </Button>
          ) : null}
        </Callout>
      ) : null}

      {generated ? (
        <div className="generated-key" role="status">
          <div className="generated-key__meta">
            <span>Generated key</span>
            <strong>{generated.name}</strong>
          </div>
          <code>{generated.api_key}</code>
          <Button type="button" onClick={() => void copyGenerated()}>
            <CopyIcon size={16} />
            <span>{copied ? "Copied" : "Copy"}</span>
          </Button>
        </div>
      ) : null}

      {keys.length === 0 && loadState !== "error" ? (
        <div className="panel__empty">No API keys.</div>
      ) : keys.length > 0 ? (
        <ul className="api-key-list" aria-label="API keys">
          {keys.map((key) => (
            <li key={key.id} className="api-key-row">
              <div className="api-key-row__main">
                <strong>{key.name}</strong>
                <span>{key.key_prefix}</span>
                <span>
                  {formatCreatedAt(key.created_at)} - {key.created_by}
                </span>
              </div>
              <IconButton
                label={`Revoke ${key.name}`}
                disabled={refreshing || revoking !== undefined}
                onClick={() => setKeyToRevoke(key)}
              >
                <TrashIcon size={16} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
      <Alert
        isOpen={keyToRevoke !== undefined}
        intent="danger"
        icon="trash"
        cancelButtonText="Cancel"
        confirmButtonText="Revoke"
        canEscapeKeyCancel
        canOutsideClickCancel
        transitionDuration={0}
        onCancel={() => setKeyToRevoke(undefined)}
        onConfirm={() => {
          const key = keyToRevoke;
          setKeyToRevoke(undefined);
          if (key) void revokeKey(key);
        }}
      >
        Revoke {keyToRevoke?.name}? Existing clients using this key will lose access.
      </Alert>
    </div>
  );
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
