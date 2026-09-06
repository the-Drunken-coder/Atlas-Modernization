import type { TransportEvent } from "../transport.js";
import type { LinkOperationResult } from "../types.js";
import { type ExperimentConfig, type ExperimentMessage, responseWorkload } from "./config.js";
import { ExperimentResults } from "./results.js";

/** The same test application drives native and deterministic radios. */
export class ExperimentWorkload {
  readonly results: ExperimentResults;
  private readonly responded = new Set<string>();
  private readonly commands: Map<string, ExperimentMessage>;
  constructor(
    config: ExperimentConfig,
    private readonly now: () => number,
    private readonly send: (message: ExperimentMessage) => LinkOperationResult
  ) {
    this.results = new ExperimentResults(config);
    this.commands = new Map(
      config.messages
        .filter((message) => message.response)
        .map((message) => [`${message.source}:${message.id}`, message])
    );
  }
  submit(message: ExperimentMessage) {
    const at = this.now();
    this.results.submitted(message.source, message.id, at, this.send(message));
  }
  observe(
    node: string,
    event: TransportEvent,
    accept: (settlementID: string) => boolean,
    acceptWithReport?: (settlementID: string, report: ExperimentMessage) => LinkOperationResult | undefined
  ) {
    const at = this.now();
    const accepted = this.results.observe(node, event, at, (settlementID) => {
      const key = event.type === "message" ? `${event.source.id}:${event.operation_id}` : "";
      const command = this.commands.get(key);
      const response = command && responseWorkload(command);
      if (!acceptWithReport || !response || this.responded.has(key)) return accept(settlementID);
      const submitted = acceptWithReport(settlementID, response);
      if (!submitted || submitted.status !== "queued") return false;
      this.responded.add(key);
      this.results.submitted(response.source, response.id, at, submitted);
      return true;
    });
    if (!accepted) return;
    const response = responseWorkload(accepted);
    const key = `${accepted.source}:${accepted.id}`;
    if (!response || this.responded.has(key)) return;
    this.responded.add(key);
    this.submit(response);
  }
}
