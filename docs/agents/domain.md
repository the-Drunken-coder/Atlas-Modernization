# Domain docs

Atlas uses multi-context domain documentation.

## Before exploring

1. Read `CONTEXT-MAP.md` for the system map.
2. Read the context document for the subsystem being changed.
3. Read applicable decisions in `docs/design-decisions/`.
4. Read subsystem-local documentation named by that context.

If a context or decision document does not exist, proceed using the nearest applicable documentation. Create domain documents only when terminology or a durable decision needs to be recorded.

## Vocabulary

Use terms defined by the relevant `CONTEXT.md`. Do not substitute terminology that the glossary explicitly rejects.

## Decision conflicts

Surface any conflict with an existing decision in `docs/design-decisions/` before proposing an implementation that changes it.
