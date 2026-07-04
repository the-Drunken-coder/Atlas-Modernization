package atlasprotocol

import "struct"
import shared "github.com/the-drunken-coder/atlas/atlas_protocol/schema/shared"

#EntityCreateRequest: close({
	entity_id!:    shared.#NonEmptyString
	entity_type!:  shared.#NonEmptyString
	subtype?:      shared.#NonEmptyString
	alias?:        null | shared.#NonEmptyString
	components?:   #EntityComponents
	published_at?: shared.#RFC3339Timestamp
	updated_at?:   shared.#RFC3339Timestamp
	extra?: {[string]: #JSONValue}
})

#EntityUpdateRequest: close({
	entity_type?: shared.#NonEmptyString
	subtype?:     null | shared.#NonEmptyString
	alias?:       null | shared.#NonEmptyString
	components?:  #EntityComponents
	extra?: {[string]: #JSONValue}
}) & struct.MinFields(1)

#TaskCreateRequest: close({
	task_id!:    shared.#NonEmptyString
	status?:     shared.#NonEmptyString
	entity_id?:  null | shared.#NonEmptyString
	components?: #TaskCreateNonCommandComponents
	extra?: {[string]: #JSONValue}
}) | close({
	status?:     shared.#NonEmptyString
	entity_id!:  shared.#NonEmptyString
	components!: #TaskCreateCommandComponents
	extra?: {[string]: #JSONValue}
})

#TaskUpdateRequest: close({
	status?:     shared.#NonEmptyString
	entity_id?:  null | shared.#NonEmptyString
	components?: #TaskComponents
	extra?: {[string]: #JSONValue}
	remove_extra_keys?: [...shared.#NonEmptyString]
}) & struct.MinFields(1)

#ObjectCreateRequest: close({
	object_id!:    shared.#NonEmptyString
	path?:         string
	content_type?: string
	type?:         string
	size_bytes?:   int & >=0
	usage_hints?: [...shared.#NonEmptyString]
	referenced_by?: [...#ObjectReference]
	extra?: {[string]: #JSONValue}
})

#ObjectUpdateRequest: close({
	path?:         string
	content_type?: string
	type?:         string
	size_bytes?:   int & >=0
	usage_hints?: [...shared.#NonEmptyString]
	referenced_by?: [...#ObjectReference]
	extra?: {[string]: #JSONValue}
}) & struct.MinFields(1)
