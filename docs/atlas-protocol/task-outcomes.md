# Task outcomes

Task outcomes are small Protocol-owned records. Every failure or cancellation has a closed code and a non-empty human-readable message. Transport and HTTP error codes are separate and are never stored as Task outcomes.

## Failure codes

| Code | Meaning | Applied by |
| --- | --- | --- |
| `unsupported_command` | The current runtime cannot execute the delivered Command. | Asset runtime |
| `precondition_failed` | A Command-specific physical or operational precondition was not met. | Asset runtime |
| `execution_failed` | The handler accepted the Task but could not complete its action. | Asset runtime |
| `asset_restarted` | A new Asset process registration fenced the runtime bound to this nonterminal Task. | Core |
| `immediate_start_timeout` | An immediate Task did not enter `in_progress` within its start window. | Core |
| `invalid_output` | Completion output did not satisfy the Command's output contract. | Core |

When an in-progress Task reports missing or invalid output, Core atomically marks it failed with `invalid_output` and returns that terminal Task. The Asset runtime does not classify or retry a deterministic output-contract failure.

## Cancellation codes

| Code | Meaning | Applied by |
| --- | --- | --- |
| `requested` | A tasking client explicitly withdrew the Task. | Tasking client through Core |
| `superseded` | A later Command-specific policy replaced the Task. | Core policy added with that Command |

Command-specific outcome codes land with the Command that needs them. The empty-catalog cutover contains no dormant stop or safety codes.

The first accepted terminal change wins. Repeating the identical terminal operation is idempotent; a conflicting repeat is rejected. Task output, failure, and cancellation are mutually exclusive terminal facts.
