package atlasprotocol

import (
	"struct"

	shared "github.com/the-drunken-coder/atlas/atlas_protocol/schema/shared"
)

#ObjectReference: close({
	entity_id?: shared.#NonEmptyString
	task_id?:   shared.#NonEmptyString
}) & struct.MinFields(1)

#ObjectBlob: {
	bucket?:     string
	size_bytes?: shared.#FiniteNumber & >=0
	usage_hints?: [...shared.#NonEmptyString]
	referenced_by?: [...#ObjectReference]
	[string]: shared.#JSONValue
}
