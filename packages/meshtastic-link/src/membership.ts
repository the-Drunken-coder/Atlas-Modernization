import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readPrivateFile } from "./private-file.js";
import type { PrivateChannelMembership } from "./profile.js";

const membershipMutationTails = new Map<string, Promise<void>>();

export type GatewayMembership = PrivateChannelMembership & {
  gateway_node_id: string;
  gateway_generation: number;
  asset_generations: Record<string, number>;
};

export class GatewayMembershipStore {
  private readonly path: string;

  constructor(path: string) {
    if (!path) throw new TypeError("Gateway membership path must not be empty");
    this.path = resolve(path);
  }

  async initialize(input: Omit<GatewayMembership, "gateway_generation" | "asset_generations">): Promise<void> {
    const membership: GatewayMembership = { ...input, gateway_generation: 0, asset_generations: {} };
    validateMembership(membership);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.path, "wx", 0o600).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(`Gateway membership already exists at ${this.path}`, { cause: error });
      }
      throw error;
    });
    try {
      await handle.writeFile(`${JSON.stringify(membership, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(this.path));
  }

  async load(): Promise<GatewayMembership> {
    let text: string;
    try {
      text = (await readPrivateFile(this.path, "Gateway membership")).toString("utf8");
    } catch (error) {
      throw new Error(`Gateway membership is missing or unreadable at ${this.path}`, { cause: error });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`Gateway membership is corrupt at ${this.path}`, { cause: error });
    }
    validateMembership(value);
    return structuredClone(value);
  }

  async activateGateway(): Promise<GatewayMembership> {
    return this.mutate(async () => {
      const membership = await this.load();
      membership.gateway_generation++;
      await this.write(membership);
      return membership;
    });
  }

  async admitAsset(assetID: string): Promise<{ membership: GatewayMembership; source_generation: number }> {
    if (!assetID.trim()) throw new TypeError("Asset ID must not be empty");
    return this.mutate(async () => {
      const membership = await this.load();
      const sourceGeneration = (membership.asset_generations[assetID] ?? 0) + 1;
      membership.asset_generations[assetID] = sourceGeneration;
      await this.write(membership);
      return { membership, source_generation: sourceGeneration };
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = membershipMutationTails.get(this.path) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    membershipMutationTails.set(this.path, tail);
    void tail.then(() => {
      if (membershipMutationTails.get(this.path) === tail) membershipMutationTails.delete(this.path);
    });
    return result;
  }

  private async write(membership: GatewayMembership): Promise<void> {
    validateMembership(membership);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.path), `.${process.pid}-${Date.now()}-membership.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(membership, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
    await syncDirectory(dirname(this.path));
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateMembership(value: unknown): asserts value is GatewayMembership {
  if (!isRecord(value)) throw new TypeError("Gateway membership must be an object");
  if (
    !isNonEmptyString(value.gateway_node_id) ||
    !Number.isSafeInteger(value.gateway_generation) ||
    Number(value.gateway_generation) < 0 ||
    !Number.isSafeInteger(value.channel_index) ||
    Number(value.channel_index) < 1 ||
    Number(value.channel_index) > 7 ||
    value.channel_name !== "ATLAS" ||
    !isChannelKey(value.channel_key_base64) ||
    !isRecord(value.asset_generations)
  ) {
    throw new TypeError("Gateway membership fields are invalid");
  }
  for (const [assetID, generation] of Object.entries(value.asset_generations)) {
    if (!assetID || !Number.isSafeInteger(generation) || Number(generation) < 1) {
      throw new TypeError("Gateway Asset source generations are invalid");
    }
  }
}

function isChannelKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === 16 || bytes.byteLength === 32;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
