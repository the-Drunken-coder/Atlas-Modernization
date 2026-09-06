import { canonicalJSON } from "../canonical-json.js";
import { deliveryClass } from "../contract.js";
import type { TransportEvent } from "../transport.js";
import type { LinkOperationResult } from "../types.js";
import { type ExperimentConfig, type ExperimentMessage, responseWorkload } from "./config.js";

export type ReceiverResult = {
  receiver: string;
  complete_messages: number;
  matching_messages: number;
  accepted_messages: number;
  first_delivery_ms: number | null;
  first_acceptance_ms: number | null;
};
export type MessageResult = {
  source: string;
  operation_id: string;
  expected: ExperimentMessage["expect"];
  delivery_class: "best_effort" | "confirmed";
  submitted_at_ms: number | null;
  admitted_to_link: boolean;
  observation_complete: boolean;
  deadline_at_ms: number;
  receiver_results: ReceiverResult[];
  sender_result: LinkOperationResult | null;
  confirmation_ms: number | null;
  packet_admissions: number;
  accepted_packet_bytes: number;
  delivered: boolean;
  delivered_within_deadline: boolean;
  confirmed: boolean;
  confirmed_within_deadline: boolean;
  duplicate_application_acceptances: number;
  outcome:
    | "not_submitted"
    | "not_admitted"
    | "incomplete"
    | "not_delivered"
    | "delivered_late"
    | "delivered"
    | "delivered_unconfirmed";
  passed: boolean;
};

type TelemetrySample = {
  published_at_ms: number;
  accepted_at_ms: number;
};

type AgeSegment = {
  duration_ms: number;
  start_age_ms: number;
  end_age_ms: number;
};

function appendAgeSegments(segments: AgeSegment[], startMs: number, endMs: number, publishedAtMs: number): void {
  if (endMs <= startMs) return;
  const knownAtMs = Math.min(endMs, Math.max(startMs, publishedAtMs));
  if (knownAtMs > startMs) segments.push({ duration_ms: knownAtMs - startMs, start_age_ms: 0, end_age_ms: 0 });
  if (endMs > knownAtMs) {
    const startAgeMs = Math.max(0, knownAtMs - publishedAtMs);
    segments.push({
      duration_ms: endMs - knownAtMs,
      start_age_ms: startAgeMs,
      end_age_ms: startAgeMs + (endMs - knownAtMs)
    });
  }
}

function timeAtOrBelow(segments: AgeSegment[], ageMs: number): number {
  return segments.reduce((total, segment) => {
    if (ageMs < segment.start_age_ms) return total;
    if (segment.start_age_ms === segment.end_age_ms) return total + segment.duration_ms;
    return (
      total +
      segment.duration_ms *
        Math.min(1, Math.max(0, (ageMs - segment.start_age_ms) / (segment.end_age_ms - segment.start_age_ms)))
    );
  }, 0);
}

function timeWeightedAgePercentile(segments: AgeSegment[], percentile: number): number | null {
  const totalDurationMs = segments.reduce((total, segment) => total + segment.duration_ms, 0);
  if (totalDurationMs === 0) return null;
  let low = 0;
  let high = Math.max(...segments.map((segment) => Math.max(segment.start_age_ms, segment.end_age_ms)));
  const target = totalDurationMs * percentile;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timeAtOrBelow(segments, middle) >= target) high = middle;
    else low = middle + 1;
  }
  return low;
}

function telemetryFreshness(scheduledAtMs: number[], samples: TelemetrySample[], observedThroughMs: number) {
  const publicationStartMs = Math.min(...scheduledAtMs);
  const publicationEndMs = Math.max(...scheduledAtMs);
  const activeEndMs = Number.isFinite(observedThroughMs)
    ? Math.min(publicationEndMs, Math.max(publicationStartMs, observedThroughMs))
    : publicationEndMs;
  const activePublicationWindowMs = activeEndMs - publicationStartMs;
  const orderedSamples = [...samples].sort(
    (left, right) => left.accepted_at_ms - right.accepted_at_ms || left.published_at_ms - right.published_at_ms
  );
  const initialSample = orderedSamples.find((sample) => sample.accepted_at_ms <= activeEndMs);
  const unknownBeforeInitialSampleMs =
    initialSample === undefined
      ? activePublicationWindowMs
      : Math.max(0, Math.min(activeEndMs, initialSample.accepted_at_ms) - publicationStartMs);
  const drainWindowMs = Number.isFinite(observedThroughMs) ? Math.max(0, observedThroughMs - publicationEndMs) : null;

  let latestPublishedAtMs: number | null = null;
  for (const sample of orderedSamples) {
    if (sample.accepted_at_ms > publicationStartMs) break;
    if (latestPublishedAtMs === null || sample.published_at_ms > latestPublishedAtMs)
      latestPublishedAtMs = sample.published_at_ms;
  }

  const segments: AgeSegment[] = [];
  let cursorMs = publicationStartMs;
  let lastFresherAcceptedAtMs: number | null = latestPublishedAtMs === null ? null : publicationStartMs;
  let longestGapWithoutFresherAcceptedSampleMs: number | null = null;
  for (const sample of orderedSamples) {
    if (sample.accepted_at_ms <= publicationStartMs) continue;
    if (sample.accepted_at_ms > activeEndMs) break;
    if (latestPublishedAtMs === null) {
      latestPublishedAtMs = sample.published_at_ms;
      cursorMs = sample.accepted_at_ms;
      lastFresherAcceptedAtMs = sample.accepted_at_ms;
      continue;
    }
    if (sample.published_at_ms <= latestPublishedAtMs) continue;
    appendAgeSegments(segments, cursorMs, sample.accepted_at_ms, latestPublishedAtMs);
    if (lastFresherAcceptedAtMs !== null) {
      longestGapWithoutFresherAcceptedSampleMs = Math.max(
        longestGapWithoutFresherAcceptedSampleMs ?? 0,
        sample.accepted_at_ms - lastFresherAcceptedAtMs
      );
    }
    latestPublishedAtMs = sample.published_at_ms;
    cursorMs = sample.accepted_at_ms;
    lastFresherAcceptedAtMs = sample.accepted_at_ms;
  }
  if (latestPublishedAtMs !== null) {
    appendAgeSegments(segments, cursorMs, activeEndMs, latestPublishedAtMs);
    if (lastFresherAcceptedAtMs !== null) {
      longestGapWithoutFresherAcceptedSampleMs = Math.max(
        longestGapWithoutFresherAcceptedSampleMs ?? 0,
        activeEndMs - lastFresherAcceptedAtMs
      );
    }
  }

  return {
    active_publication_window_ms: activePublicationWindowMs,
    drain_window_ms: drainWindowMs,
    known_age_window_ms: segments.reduce((total, segment) => total + segment.duration_ms, 0),
    time_weighted_age_p50_ms: timeWeightedAgePercentile(segments, 0.5),
    time_weighted_age_p95_ms: timeWeightedAgePercentile(segments, 0.95),
    time_weighted_age_max_ms: segments.length
      ? Math.max(...segments.map((segment) => Math.max(segment.start_age_ms, segment.end_age_ms)))
      : null,
    longest_gap_without_fresher_accepted_sample_ms: longestGapWithoutFresherAcceptedSampleMs,
    unknown_before_initial_sample_ms: unknownBeforeInitialSampleMs
  };
}

/** Sender status never substitutes for independently observed receiver acceptance. */
export class ExperimentResults {
  private readonly scheduledMessageCount: number;
  private readonly commands: ExperimentMessage[];
  private readonly rows = new Map<string, { workload: ExperimentMessage; result: MessageResult }>();
  private readonly acceptedTelemetrySamples = new Map<string, TelemetrySample>();
  constructor(config: Pick<ExperimentConfig, "messages">) {
    this.scheduledMessageCount = config.messages.length;
    this.commands = config.messages.filter((message) => message.response !== undefined);
    for (const workload of config.messages.flatMap((message) => {
      const reply = responseWorkload(message);
      return reply ? [message, reply] : [message];
    })) {
      this.rows.set(`${workload.source}:${workload.id}`, {
        workload,
        result: {
          source: workload.source,
          operation_id: workload.id,
          expected: workload.expect,
          delivery_class: deliveryClass(workload.message),
          submitted_at_ms: null,
          admitted_to_link: false,
          observation_complete: false,
          deadline_at_ms: workload.at_ms + workload.deadline_ms,
          receiver_results: workload.receivers.map((receiver) => ({
            receiver,
            complete_messages: 0,
            matching_messages: 0,
            accepted_messages: 0,
            first_delivery_ms: null,
            first_acceptance_ms: null
          })),
          sender_result: null,
          confirmation_ms: null,
          packet_admissions: 0,
          accepted_packet_bytes: 0,
          delivered: false,
          delivered_within_deadline: false,
          confirmed: false,
          confirmed_within_deadline: false,
          duplicate_application_acceptances: 0,
          outcome: "not_submitted",
          passed: false
        }
      });
    }
  }
  submitted(source: string, id: string, at: number, submission: LinkOperationResult) {
    const row = this.rows.get(`${source}:${id}`);
    if (row) {
      row.result.submitted_at_ms = at;
      row.result.admitted_to_link = submission.status === "queued";
      row.result.sender_result = structuredClone(submission);
    }
  }
  observe(node: string, event: TransportEvent, at: number, accept: (settlementID: string) => boolean) {
    if (event.type === "packet_sent") {
      const row = this.rows.get(`${node}:${event.operation_id}`);
      if (row) {
        row.result.packet_admissions++;
        row.result.accepted_packet_bytes += event.bytes;
      }
      return;
    }
    if (event.type === "operation") {
      const row = this.rows.get(`${node}:${event.result.operation_id}`);
      if (row) {
        row.result.sender_result = structuredClone(event.result);
        if (event.result.status === "queued") row.result.admitted_to_link = true;
        if (
          (event.result.status === "confirmed" || event.result.status === "responded") &&
          row.result.confirmation_ms === null
        )
          row.result.confirmation_ms = at;
      }
      return;
    }
    if (
      event.type !== "message" ||
      (!event.addressed_to_local && !(event.message.type === "state" && event.destination === undefined))
    )
      return;
    const row = this.rows.get(`${event.source.id}:${event.operation_id}`);
    const receiver = row?.result.receiver_results.find((result) => result.receiver === node);
    if (!row || !receiver || row.result.submitted_at_ms === null) return;
    receiver.complete_messages++;
    if (canonicalJSON(event.message) !== canonicalJSON(row.workload.message)) return;
    receiver.matching_messages++;
    receiver.first_delivery_ms ??= at;
    if (!event.requires_settlement || accept(event.settlement_id)) {
      const firstAcceptance = receiver.first_acceptance_ms === null;
      receiver.accepted_messages++;
      receiver.first_acceptance_ms ??= at;
      if (firstAcceptance && row.workload.message.type === "state") {
        this.acceptedTelemetrySamples.set(`${row.workload.source}:${row.workload.id}:${node}`, {
          published_at_ms: row.workload.at_ms,
          accepted_at_ms: at
        });
      }
      if (receiver.accepted_messages === 1) return row.workload;
    }
    return undefined;
  }
  finish(observedThroughMs = Infinity) {
    const messages = [...this.rows.values()].map(({ result }) => {
      const row = structuredClone(result);
      row.observation_complete = observedThroughMs >= row.deadline_at_ms;
      row.delivered = row.receiver_results.every((receiver) => receiver.first_acceptance_ms !== null);
      row.delivered_within_deadline = row.receiver_results.every(
        (receiver) => receiver.first_acceptance_ms !== null && receiver.first_acceptance_ms <= row.deadline_at_ms
      );
      row.confirmed = row.confirmation_ms !== null;
      row.confirmed_within_deadline = row.confirmation_ms !== null && row.confirmation_ms <= row.deadline_at_ms;
      row.duplicate_application_acceptances = row.receiver_results.reduce(
        (sum, receiver) => sum + Math.max(0, receiver.accepted_messages - 1),
        0
      );
      row.outcome =
        row.submitted_at_ms === null
          ? "not_submitted"
          : !row.admitted_to_link
            ? "not_admitted"
            : !row.observation_complete
              ? "incomplete"
              : !row.delivered
                ? "not_delivered"
                : !row.delivered_within_deadline
                  ? "delivered_late"
                  : row.delivery_class === "confirmed" && !row.confirmed_within_deadline
                    ? "delivered_unconfirmed"
                    : "delivered";
      row.passed =
        row.outcome === row.expected &&
        row.duplicate_application_acceptances === 0 &&
        row.receiver_results.every((receiver) => receiver.complete_messages === receiver.matching_messages);
      return row;
    });
    const attempted = messages.filter((message) => message.submitted_at_ms !== null);
    const submitted = attempted.filter((message) => message.admitted_to_link && message.observation_complete);
    const confirmed = submitted.filter((message) => message.delivery_class === "confirmed");
    const exchanges = this.commands.map((command) => {
      const outbound = messages.find((row) => row.source === command.source && row.operation_id === command.id);
      const response = messages.find(
        (row) => row.source === command.destination && row.operation_id === command.response?.id
      );
      const receivedAt = response?.receiver_results[0]?.first_acceptance_ms ?? null;
      return {
        command_id: command.id,
        asset: command.destination,
        command_delivered: outbound?.delivered ?? false,
        command_confirmed: outbound?.confirmed ?? false,
        response_submitted: response?.submitted_at_ms !== null && response?.submitted_at_ms !== undefined,
        response_delivered: response?.delivered ?? false,
        response_confirmed: response?.confirmed ?? false,
        round_trip_ms:
          receivedAt === null || outbound?.submitted_at_ms == null ? null : receivedAt - outbound.submitted_at_ms,
        completed_within_deadline: response?.delivered_within_deadline ?? false,
        observation_complete: response?.observation_complete ?? false
      };
    });
    const telemetry = [
      ...new Set(
        [...this.rows.values()]
          .filter(({ workload }) => workload.message.type === "state")
          .map(({ workload }) => workload.source)
      )
    ].map((source) => {
      const rows = [...this.rows.values()].filter(
        ({ workload }) => workload.source === source && workload.message.type === "state"
      );
      return {
        source,
        receivers: [...new Set(rows.flatMap(({ workload }) => workload.receivers))].map((receiver) => {
          const samples = rows.flatMap(({ workload, result }) => {
            const accepted = result.receiver_results.find((row) => row.receiver === receiver)?.first_acceptance_ms;
            return accepted == null ? [] : [{ published: workload.at_ms, latency: accepted - workload.at_ms }];
          });
          const scheduledAtMs = rows
            .filter(({ workload }) => workload.receivers.includes(receiver))
            .map(({ workload }) => workload.at_ms);
          const freshness = telemetryFreshness(
            scheduledAtMs,
            rows.flatMap(({ workload }) => {
              const sample = this.acceptedTelemetrySamples.get(`${workload.source}:${workload.id}:${receiver}`);
              return sample === undefined ? [] : [sample];
            }),
            observedThroughMs
          );
          return {
            receiver,
            scheduled: rows.filter(({ workload }) => workload.receivers.includes(receiver)).length,
            delivered: samples.length,
            maximum_latency_ms: samples.length ? Math.max(...samples.map((sample) => sample.latency)) : null,
            latest_sample_age_ms:
              samples.length && Number.isFinite(observedThroughMs)
                ? observedThroughMs - Math.max(...samples.map((sample) => sample.published))
                : null,
            ...freshness
          };
        })
      };
    });
    return {
      exchanges,
      telemetry,
      passed: messages.every((message) => message.passed),
      messages,
      summary: {
        scheduled_messages: this.scheduledMessageCount,
        expected_messages: messages.length,
        expected_responses: exchanges.length,
        triggered_responses: exchanges.filter((exchange) => exchange.response_submitted).length,
        submission_attempts: attempted.length,
        admitted_messages: attempted.filter((message) => message.admitted_to_link).length,
        fully_observed_messages: submitted.length,
        submission_rejections: attempted.filter((message) => !message.admitted_to_link).length,
        delivered_messages: submitted.filter((message) => message.delivered).length,
        message_delivery_failure_rate: submitted.length
          ? submitted.filter((message) => !message.delivered).length / submitted.length
          : null,
        delivery_deadline_failure_rate: submitted.length
          ? submitted.filter((message) => !message.delivered_within_deadline).length / submitted.length
          : null,
        confirmation_deadline_failure_rate: confirmed.length
          ? confirmed.filter((message) => !message.confirmed_within_deadline).length / confirmed.length
          : null,
        confirmed_messages: confirmed.filter((message) => message.confirmed).length,
        confirmation_failure_rate: confirmed.length
          ? confirmed.filter((message) => !message.confirmed).length / confirmed.length
          : null,
        delivered_unconfirmed_messages: submitted.filter((message) => message.outcome === "delivered_unconfirmed")
          .length,
        duplicate_application_acceptances: messages.reduce(
          (sum, message) => sum + message.duplicate_application_acceptances,
          0
        )
      }
    };
  }
}
