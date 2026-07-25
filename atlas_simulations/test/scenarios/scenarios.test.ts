import { describe, expect, it, vi } from "vitest";
import { boundedNumberInput, boundedPositiveIntegerInput, numberInput, point } from "../../src/scenarios/helpers.js";
import { RunStore } from "../../src/server/run-store.js";
import { parseStartRequest } from "../../src/server/scenario.js";
import { scenarios } from "../../src/server/scenario-registry.js";
import { createFakeAtlasCore } from "../support/fake-atlas.js";

describe("v1 scenarios", () => {
  it.each(
    scenarios.map((scenario) => [scenario.id, scenario])
  )("%s completes against the shared fake Atlas client", async (_id, scenario) => {
    vi.useFakeTimers();
    try {
      const core = createFakeAtlasCore();
      const store = new RunStore(core.factory);
      const parsed = parseStartRequest(scenario, {
        scenarioId: scenario.id,
        inputs: Object.fromEntries(scenario.inputFields.map((field) => [field.key, field.defaultValue])),
        jsonInput: scenario.acceptsJson ? '{"test":"yes"}' : undefined
      });
      const run = store.start(scenario, parsed.input);
      await vi.waitFor(
        () => {
          const current = store.get(run.id);
          expect(["completed", "failed"]).toContain(current?.status);
        },
        { timeout: 5000 }
      );
      const current = store.get(run.id);
      expect(current?.status, current?.lastError).toBe("completed");
      const assertions = current?.assertions ?? [];
      expect(assertions.length).toBeGreaterThan(0);
      expect(assertions.every((assertion) => assertion.passed)).toBe(true);
      const beforeCleanup = await core.factory().queries.full();
      expect(beforeCleanup.entities.length + beforeCleanup.tasks.length + beforeCleanup.objects.length).toBeGreaterThan(
        0
      );
      const expectedDeletes = new Set(
        (store.get(run.id)?.createdResources ?? []).map((resource) => `${resource.type}:${resource.id}`)
      );

      await expect(store.cleanup(run.id)).resolves.toMatchObject({ cleaned: true });
      const afterCleanup = await core.factory().queries.full();
      expect(afterCleanup).toMatchObject({ entities: [], tasks: [], objects: [] });
      expect(core.state.deleted).toHaveLength(expectedDeletes.size);
      expect(new Set(core.state.deleted)).toEqual(expectedDeletes);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(
    scenarios.map((scenario) => [scenario.id, scenario])
  )("%s can run twice before cleanup", async (_id, scenario) => {
    vi.useFakeTimers();
    try {
      const core = createFakeAtlasCore();
      const store = new RunStore(core.factory);
      const start = () => store.start(scenario, parseStartRequest(scenario, defaultStartRequest(scenario)).input);
      const first = start();
      await vi.waitFor(() => expect(store.get(first.id)?.status).toBe("completed"), { timeout: 5000 });
      const second = start();
      await vi.waitFor(() => expect(store.get(second.id)?.status).toBe("completed"), { timeout: 5000 });

      expect(store.get(first.id)?.assertions.every((assertion) => assertion.passed)).toBe(true);
      expect(store.get(second.id)?.assertions.every((assertion) => assertion.passed)).toBe(true);
      await expect(store.cleanup(first.id)).resolves.toMatchObject({ cleaned: true });
      await expect(store.cleanup(second.id)).resolves.toMatchObject({ cleaned: true });
      await expect(core.factory().queries.full()).resolves.toMatchObject({ entities: [], tasks: [], objects: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("moving-assets updates every asset to the final tick geometry and telemetry", async () => {
    vi.useFakeTimers();
    try {
      const { core, current } = await runScenario(
        "moving-assets",
        {
          assetCount: 2,
          ticks: 3,
          tickMs: 0,
          startLatitude: 38,
          startLongitude: -77
        },
        '{"mission":"coverage"}'
      );

      const dataset = await core.factory().queries.full();
      const entities = dataset.entities.slice().sort((left, right) => left.entity_id.localeCompare(right.entity_id));

      expect(current.assertions.every((assertion) => assertion.passed)).toBe(true);
      expect(entities).toHaveLength(2);
      expect(entities.map((entity) => entity.entity_type)).toEqual(["asset", "asset"]);
      expect(entities.map((entity) => entity.subtype)).toEqual(["simulated", "simulated"]);
      expect(entities.map((entity) => (entity.components.telemetry as { speed_m_s?: number }).speed_m_s)).toEqual([
        15, 15
      ]);
      expect(entities.map((entity) => (entity.components.custom_simulation as { mission?: string }).mission)).toEqual([
        "coverage",
        "coverage"
      ]);
      expect((entities[0]!.components.geometry as unknown as { coordinates: [number, number] }).coordinates).toEqual([
        -76.9976, 38.0015
      ]);
      expect((entities[1]!.components.geometry as unknown as { coordinates: [number, number] }).coordinates).toEqual([
        -76.9956, 38.0025
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("multi-client-sync records convergence assertions for each reader client", async () => {
    vi.useFakeTimers();
    try {
      const { core, current } = await runScenario("multi-client-sync", {
        clientCount: 2,
        writes: 3,
        settleMs: 1500
      });
      const assertionByName = new Map(current.assertions.map((assertion) => [assertion.name, assertion]));
      const dataset = await core.factory().queries.full();

      expect(dataset.entities).toHaveLength(3);
      expect(
        dataset.entities
          .map((entity) => (entity.components.custom_simulation as { write_index?: number }).write_index)
          .sort()
      ).toEqual([1, 2, 3]);
      expect(core.state.clients.filter((client) => client.sync === "all").length).toBeGreaterThanOrEqual(2);
      for (const reader of [1, 2]) {
        expect(assertionByName.get(`Client ${reader} saw writer resources`)?.passed).toBe(true);
        expect(assertionByName.get(`Client ${reader} matched writer versions`)?.passed).toBe(true);
        expect(assertionByName.get(`Client ${reader} sync healthy`)?.passed).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("observations-objects links observer assets, tracks, and object metadata", async () => {
    vi.useFakeTimers();
    try {
      const { core, current } = await runScenario(
        "observations-objects",
        {
          assetCount: 2,
          observations: 3,
          tickMs: 0,
          startLatitude: 38,
          startLongitude: -77
        },
        '{"collection":"coverage"}'
      );

      const dataset = await core.factory().queries.full();
      const observers = dataset.entities.filter((entity) => entity.subtype === "simulated-observer");
      const tracks = dataset.entities
        .filter((entity) => entity.entity_type === "track")
        .sort((left, right) => left.entity_id.localeCompare(right.entity_id));
      const observerIds = new Set(observers.map((entity) => entity.entity_id));
      const trackIds = new Set(tracks.map((entity) => entity.entity_id));

      expect(current.assertions.every((assertion) => assertion.passed)).toBe(true);
      expect(observers).toHaveLength(2);
      expect(tracks).toHaveLength(3);
      expect(dataset.objects).toHaveLength(3);
      expect(
        tracks.every((track) =>
          observerIds.has((track.components.custom_simulation as { observer_id?: string }).observer_id ?? "")
        )
      ).toBe(true);
      expect(tracks.map((track) => (track.components.custom_simulation as { collection?: string }).collection)).toEqual(
        ["coverage", "coverage", "coverage"]
      );
      expect(
        dataset.objects.every((object) =>
          (object.referenced_by ?? []).some(
            (reference) => typeof reference.entity_id === "string" && trackIds.has(reference.entity_id)
          )
        )
      ).toBe(true);
      expect(dataset.objects.map((object) => object.size_bytes).sort()).toEqual([256, 257, 258]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid point coordinates", () => {
    expect(() => point(181, 0)).toThrow("longitude must be between -180 and 180");
    expect(() => point(0, -91)).toThrow("latitude must be between -90 and 90");
  });

  it("rejects non-finite scenario number inputs", () => {
    expect(() => numberInput({ fields: { tickMs: Number.NaN } }, "tickMs")).toThrow("tickMs must be a finite number");
    expect(() => numberInput({ fields: { tickMs: Number.POSITIVE_INFINITY } }, "tickMs")).toThrow(
      "tickMs must be a finite number"
    );
  });

  it("rejects scenario number inputs outside runtime bounds", () => {
    expect(() => boundedNumberInput({ fields: { tickMs: -1 } }, "tickMs", 0, 10000)).toThrow(
      "tickMs must be between 0 and 10000"
    );
    expect(() => boundedNumberInput({ fields: { startLatitude: 91 } }, "startLatitude", -90, 90)).toThrow(
      "startLatitude must be between -90 and 90"
    );
    expect(() => boundedPositiveIntegerInput({ fields: { assetCount: 26 } }, "assetCount", 25)).toThrow(
      "assetCount must be <= 25"
    );
  });
});

function defaultStartRequest(scenario: (typeof scenarios)[number]) {
  return {
    scenarioId: scenario.id,
    inputs: Object.fromEntries(scenario.inputFields.map((field) => [field.key, field.defaultValue])),
    jsonInput: scenario.acceptsJson ? '{"test":"yes"}' : undefined
  };
}

async function runScenario(id: string, inputs: Record<string, string | number | boolean>, jsonInput?: string) {
  const scenario = scenarios.find((candidate) => candidate.id === id);
  expect(scenario).toBeDefined();
  const core = createFakeAtlasCore();
  const store = new RunStore(core.factory);
  const parsed = parseStartRequest(scenario!, {
    scenarioId: id,
    inputs,
    ...(jsonInput === undefined ? {} : { jsonInput })
  });
  const started = store.start(scenario!, parsed.input);
  await vi.waitFor(
    () => {
      const current = store.get(started.id);
      expect(["completed", "failed"]).toContain(current?.status);
    },
    { timeout: 5000 }
  );
  const current = store.get(started.id);
  expect(current?.status, current?.lastError).toBe("completed");
  return { core, store, current: current! };
}
