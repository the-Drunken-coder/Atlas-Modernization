import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AtlasAdminClient, type AdminAPIKey, type AdminCreatedAPIKey } from "../../../../atlas_sdk/src/admin.js";
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

	const admin = useMemo(() => (config ? new AtlasAdminClient({ baseUrl: config.atlasBaseUrl, credentials: "include" }) : undefined), [config]);

	useEffect(() => {
		if (!admin) return;
		let cancelled = false;
		setLoadState("loading");
		setError(undefined);
		void admin.apiKeys
			.list()
			.then((next) => {
				if (!cancelled) {
					setKeys(next);
					setLoadState("ready");
				}
			})
			.catch((cause) => {
				if (!cancelled) {
					handleAdminError(cause);
					setError(errorMessage(cause));
					setLoadState("error");
				}
			});
		return () => {
			cancelled = true;
		};
	}, [admin]);

	const createKey = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!admin || name.trim() === "") return;
		setSubmitting(true);
		setGenerated(undefined);
		setCopied(false);
		setError(undefined);
		try {
			const created = await admin.apiKeys.create({ name });
			setGenerated(created);
			setKeys((current) => [created, ...current.filter((key) => key.id !== created.id)]);
			setName("");
			setLoadState("ready");
		} catch (cause) {
			handleAdminError(cause);
			setError(errorMessage(cause));
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
		if (!admin || revoking || !window.confirm(`Revoke ${key.name}?`)) return;
		setRevoking(key.id);
		setError(undefined);
		try {
			await admin.apiKeys.revoke(key.id);
			setKeys((current) => current.filter((entry) => entry.id !== key.id));
			if (generated?.id === key.id) setGenerated(undefined);
		} catch (cause) {
			handleAdminError(cause);
			setError(errorMessage(cause));
		} finally {
			setRevoking(undefined);
		}
	};

	if (loadState === "loading") {
		return <div className="panel__empty">Loading API keys...</div>;
	}

	return (
		<div className="api-keys-panel">
			<form className="api-key-create" onSubmit={createKey}>
				<TextField label="Name" value={name} onChange={(event) => setName(event.target.value)} />
				<Button type="submit" variant="primary" disabled={submitting || name.trim() === ""}>
					<PlusIcon size={16} />
					<span>{submitting ? "Creating" : "Create"}</span>
				</Button>
			</form>

			{error ? <div className="banner banner--error">{error}</div> : null}

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

			{loadState === "error" ? null : keys.length === 0 ? (
				<div className="panel__empty">No API keys.</div>
			) : (
				<ul className="api-key-list" aria-label="API keys">
					{keys.map((key) => (
						<li key={key.id} className="api-key-row">
							<div className="api-key-row__main">
								<strong>{key.name}</strong>
								<span>{key.key_prefix}</span>
								<span>{formatCreatedAt(key.created_at)} - {key.created_by}</span>
							</div>
							<IconButton label={`Revoke ${key.name}`} disabled={revoking === key.id} onClick={() => void revokeKey(key)}>
								<TrashIcon size={16} />
							</IconButton>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function handleAdminError(error: unknown) {
	if (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 401) {
		window.dispatchEvent(new Event("atlas-auth-expired"));
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatCreatedAt(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
