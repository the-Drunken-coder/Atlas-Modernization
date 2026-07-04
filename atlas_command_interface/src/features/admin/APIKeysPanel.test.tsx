import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StyleSpecification } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptySnapshot } from "../../atlas/store.js";
import { AtlasStaticProvider, type AtlasContextValue } from "../../state/atlas-context.js";
import { APIKeysPanel } from "./APIKeysPanel.js";

const atlasValue: AtlasContextValue = {
	status: "ready",
	config: {
			atlasBaseUrl: "https://core.test",
			protocolRevision: "rev",
			defaultMapSourceId: "openstreetmap-default",
			mapSources: [{ id: "openstreetmap-default", label: "OpenStreetMap Default", style: style("openstreetmap-default") }]
		},
	snapshot: emptySnapshot(),
	health: { running: true, healthy: true, degraded: false },
	submitCommand: async () => {
		throw new Error("not used");
	},
	updateGeometry: async () => {
		throw new Error("not used");
	}
	};

function style(id: string): StyleSpecification {
	return { version: 8, sources: {}, layers: [], metadata: { id } };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Reflect.deleteProperty(navigator, "clipboard");
});

describe("APIKeysPanel", () => {
	it("loads, creates, copies, and revokes API keys with Core admin credentials", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn();
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse([{ id: "atlas_ak_existing", name: "existing", key_prefix: "atlas_ak_existing", created_at: "2026-07-01T12:00:00Z", created_by: "admin" }]))
			.mockResolvedValueOnce(
				jsonResponse({
					id: "atlas_ak_created",
					name: "sim runner",
					key_prefix: "atlas_ak_created",
					created_at: "2026-07-01T12:01:00Z",
					created_by: "admin",
					api_key: "atlas_ak_created.secret"
				})
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(window, "confirm").mockReturnValue(true);

		renderPanel();

		expect(await screen.findByText("existing")).toBeInTheDocument();
		expect(fetchMock.mock.calls[0][0]).toBe("https://core.test/admin/api-keys");
		expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "include" });

		await user.type(screen.getByLabelText("Name"), "sim runner");
		await user.click(screen.getByRole("button", { name: /Create/ }));
		expect(await screen.findByText("atlas_ak_created.secret")).toBeInTheDocument();
		expect(fetchMock.mock.calls[1][0]).toBe("https://core.test/admin/api-keys");
		expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "include" });

		await user.click(screen.getByRole("button", { name: "Copy" }));
		expect(writeText).toHaveBeenCalledWith("atlas_ak_created.secret");

		await user.click(screen.getByRole("button", { name: "Revoke existing" }));
		await waitFor(() => expect(screen.queryByText("existing")).not.toBeInTheDocument());
		expect(fetchMock.mock.calls[2][0]).toBe("https://core.test/admin/api-keys/atlas_ak_existing");
		expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "DELETE", credentials: "include" });
	});

	it("dispatches auth-expired when Core rejects the admin session", async () => {
		const expired = vi.fn();
		window.addEventListener("atlas-auth-expired", expired);
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: false, message: "unauthorized", error_code: "UNAUTHORIZED" }, 401)));

		try {
			renderPanel();
			await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
		} finally {
			window.removeEventListener("atlas-auth-expired", expired);
		}
	});

	it("shows an error when copying the generated key fails", async () => {
		const user = userEvent.setup();
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
			configurable: true
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse([]))
				.mockResolvedValueOnce(
					jsonResponse({
						id: "atlas_ak_created",
						name: "sim runner",
						key_prefix: "atlas_ak_created",
						created_at: "2026-07-01T12:01:00Z",
						created_by: "admin",
						api_key: "atlas_ak_created.secret"
					})
				)
		);

		renderPanel();

		await user.type(await screen.findByLabelText("Name"), "sim runner");
		await user.click(screen.getByRole("button", { name: /Create/ }));
		await user.click(await screen.findByRole("button", { name: "Copy" }));
		expect(await screen.findByText("Failed to copy key to clipboard.")).toBeInTheDocument();
	});
});

function renderPanel() {
	render(
		<AtlasStaticProvider value={atlasValue}>
			<APIKeysPanel />
		</AtlasStaticProvider>
	);
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
