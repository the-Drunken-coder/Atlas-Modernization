import { describe, expect, it, vi } from "vitest";
import { entityFixture } from "../../test/fixtures.js";
import { ENTITY_KINDS } from "./entities.js";
import { entitiesByKind, listEntities } from "./selectors.js";
import type { AtlasSnapshot } from "./store.js";

describe("entitiesByKind", () => {
  it("does not compare names for an absent kind or a single matching entity", () => {
    const asset = entityFixture({ entity_id: "asset", alias: "Z" });
    const track = entityFixture({ entity_id: "track", entity_type: "track", alias: "A" });
    const snapshot: AtlasSnapshot = { entities: { asset, track }, tasks: {} };
    const compare = vi.spyOn(String.prototype, "localeCompare");
    try {
      expect(entitiesByKind(snapshot, "geofeature")).toEqual([]);
      expect(entitiesByKind(snapshot, "asset")).toEqual([asset]);
      expect(compare).not.toHaveBeenCalled();
    } finally {
      compare.mockRestore();
    }
  });

  it.each(ENTITY_KINDS)("sorts only %s names while preserving fallback, ties and the snapshot", (kind) => {
    const matching = [
      entityFixture({ entity_id: "last", entity_type: kind, alias: "Z" }),
      entityFixture({ entity_id: "tie-z", entity_type: kind, alias: "Q" }),
      entityFixture({ entity_id: "M", entity_type: kind }),
      entityFixture({ entity_id: "tie-a", entity_type: kind, alias: "Q" }),
      entityFixture({ entity_id: "first", entity_type: kind, alias: "A" }),
      entityFixture({ entity_id: "empty", entity_type: kind, alias: "" })
    ];
    const unrelated = [...ENTITY_KINDS.filter((entry) => entry !== kind), "unknown"].map((entity_type) =>
      entityFixture({ entity_id: entity_type, entity_type, alias: `unrelated-${entity_type}` })
    );
    const snapshot: AtlasSnapshot = Object.freeze({
      entities: Object.freeze(
        Object.fromEntries([...matching, ...unrelated].map((entity) => [entity.entity_id, Object.freeze(entity)]))
      ),
      tasks: Object.freeze({})
    });
    const before = structuredClone(snapshot);
    const compare = vi.spyOn(String.prototype, "localeCompare");
    try {
      expect(entitiesByKind(snapshot, kind).map((entity) => entity.entity_id)).toEqual([
        "empty",
        "first",
        "M",
        "tie-z",
        "tie-a",
        "last"
      ]);
      expect(compare).toHaveBeenCalled();
      const names = new Set(["Z", "Q", "M", "A", ""]);
      expect(compare.mock.contexts.every((receiver) => names.has(String(receiver)))).toBe(true);
      expect(compare.mock.calls.every(([name]) => names.has(name))).toBe(true);
      expect(snapshot).toEqual(before);
    } finally {
      compare.mockRestore();
    }
  });

  it("preserves the all-kind selector's locale ordering", () => {
    const entities = ["é", "e", "Å", "a", "10", "2"].map((alias, index) =>
      entityFixture({ entity_id: `asset-${index}`, alias })
    );
    const snapshot: AtlasSnapshot = {
      entities: Object.fromEntries(entities.map((entity) => [entity.entity_id, entity])),
      tasks: {}
    };
    expect(entitiesByKind(snapshot, "asset")).toEqual(listEntities(snapshot));
  });
});
