import type { CommandSubmitRequest, CommandSubmitResponse, APIErrorResponse } from "./command-model.js";

export type AtlasCommandConfig = {
  atlasBaseUrl: string;
  protocolRevision: string;
};

export class CommandAPIError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: APIErrorResponse["details"];

  constructor(status: number, body: APIErrorResponse) {
    super(body.message);
    this.name = "CommandAPIError";
    this.status = status;
    this.code = body.error_code;
    this.details = body.details;
  }
}

export async function fetchCommandConfig(): Promise<AtlasCommandConfig> {
  return await readJSON<AtlasCommandConfig>(await fetch("/api/config", { headers: { Accept: "application/json" } }));
}

export async function submitCommand(request: CommandSubmitRequest): Promise<CommandSubmitResponse> {
  return await readJSON<CommandSubmitResponse>(
    await fetch("/api/commands", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request)
    })
  );
}

async function readJSON<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | APIErrorResponse;
  if (!response.ok) {
    throw new CommandAPIError(response.status, body as APIErrorResponse);
  }
  return body as T;
}
