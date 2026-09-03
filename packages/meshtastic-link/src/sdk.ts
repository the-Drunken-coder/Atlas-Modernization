import type {
  AtlasRadioInputByOperation,
  AtlasRadioMutationOperation,
  AtlasRadioOperationName,
  AtlasRadioOutputByOperation,
  AtlasRadioRequestOperation
} from "./generated/radio-contract.generated.js";
import type { SubmitOptions } from "./transport.js";
import type {
  DataRequest,
  DataResponse,
  LinkMessage,
  LinkNode,
  LinkOperationResult,
  ObjectContent,
  ResourceOperation,
  StatePublication,
  SubscriptionOperation,
  TaskDelivery,
  TaskReport
} from "./types.js";

type OperationInput<Operation extends keyof AtlasRadioInputByOperation> =
  AtlasRadioInputByOperation[Operation] extends undefined
    ? { input?: never }
    : { input: AtlasRadioInputByOperation[Operation] };

export type AtlasRadioRequest<Operation extends AtlasRadioRequestOperation> = DataRequest & {
  operation: Operation;
} & OperationInput<Operation> &
  OperationContext<Operation>;

export type AtlasRadioMutation<Operation extends AtlasRadioMutationOperation> = ResourceOperation & {
  operation: Operation;
} & OperationInput<Operation> &
  OperationContext<Operation>;

export type AtlasRadioResponse<Operation extends AtlasRadioOperationName> = DataResponse & {
  operation: Operation;
} & OperationOutput<Operation>;

type OperationOutput<Operation extends AtlasRadioOperationName> =
  AtlasRadioOutputByOperation[Operation] extends undefined
    ? { output?: never }
    : { output: AtlasRadioOutputByOperation[Operation] };

type OperationContext<Operation extends AtlasRadioOperationName> = Operation extends
  | "entity.get"
  | "entity.update"
  | "entity.delete"
  | "task.get"
  | "task.cancel"
  | "object.get"
  | "object.update"
  | "object.delete"
  | "object.content"
  ? { target_id: string }
  : Operation extends "entity.check_in"
    ? { target_id: string; fields?: "full" | "minimal" }
    : Operation extends "task.acknowledge" | "task.start" | "task.progress" | "task.complete" | "task.fail"
      ? { target_id: string; runtime_id: string }
      : Operation extends "runtime.begin" | "runtime.stop" | "runtime.ready"
        ? { target_id: string }
        : Operation extends "runtime.tasks"
          ? { target_id: string; runtime_id: string }
          : Operation extends "task.create"
            ? { idempotency_key: string }
            : Operation extends "query.changed_since"
              ? { since_version: number; cursor?: string; limit?: number }
              : Operation extends "query.full"
                ? {
                    entity_cursor?: string;
                    task_cursor?: string;
                    object_cursor?: string;
                    entity_limit?: number;
                    task_limit?: number;
                    object_limit?: number;
                  }
                : Operation extends "plugin.invoke" | "plugin.invoke_spatial"
                  ? { plugin_id: string; plugin_operation_id: string }
                  : Record<never, never>;

export interface RadioOperationSubmitter {
  submit(message: LinkMessage, options?: SubmitOptions): LinkOperationResult;
}

/** Typed application entry point into the Radio contract and production transport. */
export class AtlasRadioSDK {
  constructor(private readonly submitter: RadioOperationSubmitter) {}

  publish(publication: StatePublication, operationID = publication.operation_id): LinkOperationResult {
    return this.submitter.submit(publication, operationID === undefined ? {} : { operationID });
  }

  request<Operation extends AtlasRadioRequestOperation>(
    request: AtlasRadioRequest<Operation>,
    destination: LinkNode
  ): LinkOperationResult {
    return this.submitter.submit(request, { destination, operationID: request.request_id });
  }

  respond<Operation extends AtlasRadioOperationName>(
    response: AtlasRadioResponse<Operation>,
    destination: LinkNode,
    operationID?: string
  ): LinkOperationResult {
    return this.submitter.submit(response, {
      destination,
      ...(operationID === undefined ? {} : { operationID })
    });
  }

  mutate<Operation extends AtlasRadioMutationOperation>(
    mutation: AtlasRadioMutation<Operation>,
    destination: LinkNode,
    operationID?: string
  ): LinkOperationResult {
    return this.submitter.submit(mutation, {
      destination,
      ...(operationID === undefined ? {} : { operationID })
    });
  }

  deliverTask(delivery: TaskDelivery, destination: LinkNode, operationID?: string): LinkOperationResult {
    return this.addressed(delivery, destination, operationID);
  }

  reportTask(report: TaskReport, destination: LinkNode, operationID?: string): LinkOperationResult {
    return this.addressed(report, destination, operationID);
  }

  subscribe(subscription: SubscriptionOperation, destination: LinkNode, operationID?: string): LinkOperationResult {
    return this.addressed(subscription, destination, operationID);
  }

  transferObject(content: ObjectContent, destination: LinkNode, operationID?: string): LinkOperationResult {
    return this.addressed(content, destination, operationID);
  }

  private addressed(message: LinkMessage, destination: LinkNode, operationID?: string): LinkOperationResult {
    return this.submitter.submit(message, {
      destination,
      ...(operationID === undefined ? {} : { operationID })
    });
  }
}
