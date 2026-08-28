# Resource message

Resource is FieldLink message ID 2. It carries broad Atlas resource operations
without defining a separate FieldLink message for every API endpoint.

The complete message is UTF-8 JSON. FieldLink validates the operation envelope
and that each body is representable as JSON. The receiving Atlas application
validates the Entity, Object, or Task data against the authoritative Atlas API
schema before using it.

The two-radio console sends the exact request to a canned responder on radio B.
That responder preserves the request ID and returns a visible test result. Atlas
SDK execution belongs to the separate Atlas application bridge.

## Implementation status

| Status                   | Scope                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented now          | Resource JSON validation and encoding, Entity and Object CRUD envelopes, Task get and list envelopes, response correlation, request replay protection, CLI and terminal-console input, evidence output, and a transport-only responder. |
| Separate application     | A future Gateway application validates bodies with the Atlas SDK and executes authorized operations against Core. That code is not part of FieldLink.                                                                                   |
| Planned, not implemented | Durable application-level operation journaling through gateway restarts.                                                                                                                                                                |
| Not part of Resource     | Task lifecycle semantics, arbitrary HTTP requests, API credentials, radio authentication, and binary Object content. These need separate system or message designs.                                                                     |

The sections below document the implemented Resource message. References to
future Task, Object-content, and gateway behavior describe boundaries, not
code that exists today.

## Request contract

Every request starts with these fields:

```json
{
  "type": "resource",
  "kind": "request",
  "operation": "get",
  "request_id": "req-123",
  "resource_type": "task"
}
```

`request_id` correlates exactly one response with its request. It is an
application identifier of at most 256 UTF-8 bytes, not a FieldLink transfer ID
or delivery receipt.

| Operation | Resources                  | Additional fields           | Meaning                                               |
| --------- | -------------------------- | --------------------------- | ----------------------------------------------------- |
| `create`  | `entity`, `object`         | `body`                      | Create from Atlas JSON. Object JSON is metadata only. |
| `get`     | `entity`, `object`, `task` | `resource_id`               | Read one resource.                                    |
| `list`    | `entity`, `object`, `task` | `query: { limit, cursor? }` | Read a bounded page of resources.                     |
| `patch`   | `entity`, `object`         | `resource_id`, `body`       | Apply an Atlas JSON patch.                            |
| `delete`  | `entity`, `object`         | `resource_id`               | Delete one resource.                                  |

`list.query.limit` must be from 1 through 1000. A list response normalizes the
selected Atlas resource page to `items`, `has_more`, and optional
`next_cursor`; it does not forward the unrelated Entity, Task, and Object pages
returned by the SDK's full-dataset query.

Create example:

```json
{
  "type": "resource",
  "kind": "request",
  "operation": "create",
  "request_id": "req-create-entity",
  "resource_type": "entity",
  "body": {
    "entity_id": "rescue-1",
    "entity_type": "vehicle"
  }
}
```

List example:

```json
{
  "type": "resource",
  "kind": "request",
  "operation": "list",
  "request_id": "req-list-tasks",
  "resource_type": "task",
  "query": {
    "limit": 50,
    "cursor": "next-page"
  }
}
```

## Response contract

Every operation uses one response shape:

```json
{
  "type": "resource",
  "kind": "response",
  "request_id": "req-123",
  "status": 200,
  "body": {
    "id": "task-123",
    "status": "assigned"
  }
}
```

`status` is the numeric application result. `body` is optional because a success
or error may have no JSON payload. Receiving a response proves neither RF
delivery nor application success beyond the result it reports.

## Boundaries

Resource is a typed operation envelope, not a generic HTTP tunnel. It carries
no method, URL, route, header, API key, or arbitrary query parameter. Receiving
the message on a normal FieldLink node does not execute it. FieldLink's test
adapter returns a canned result and never loads the Atlas SDK.

The following stay outside Resource:

- Task create, assignment, acknowledgement, progress, completion, failure, and
  cancellation. Task lifecycle needs explicit Task semantics.
- Object upload and download bytes. Resource carries Object metadata only.
- Entity check-in and other domain actions that are not CRUD.
- Unsolicited Task push. The push contract remains a separate Task message
  decision.

The test responder accepts requests only from radio A's preflight Node ID. It
caches 64 request IDs for the adapter process lifetime: repeating identical
JSON replays the first response, while using the same ID for different JSON
returns `409` without calling an application. This protects an accidental retry
but is not strong sender authentication. Any channel member can spoof a
FieldLink Node ID, so deployments need an application authorization policy.

Atlas resources can contain Atlas-owned metadata such as a resource version.
That JSON remains an Atlas domain fact; the Resource envelope adds no FieldLink
version or revision field.

## Two-radio transport exercise

Use `--resource-request` to send a JSON file through the real two-radio path:

```bash
npm run fieldlink -- test \
  --a /dev/cu.usbmodem-A \
  --b /dev/cu.usbmodem-B \
  --message resource \
  --resource-request request.json \
  --retry-strategy selective-window \
  --allow-inbox-drain
```

The CLI validates the file before opening either radio. Adapter B returns a
correlated response whose body contains `fieldlink_test_responder: true`. The
run passes only after A receives it, any fragmented transfer finishes, cleanup
succeeds, and neither adapter reports a listener or protocol error. This is RF
transport evidence, not Atlas API evidence.

The encoded Resource message shares FieldLink's 1 MiB limit. Messages over 132
encoded bytes use the normal FieldLink transfer protocol.
