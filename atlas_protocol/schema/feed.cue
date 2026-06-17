package atlasprotocol

import shared "github.com/the-drunken-coder/atlas/atlas_protocol/schema/shared"

#ResourceType: "entity" | "task" | "object"

#FeedEventName: "create" | "update" | "delete"

#FeedVersion: int & >0

#MetadataBlock: close({
	created_at!: shared.#RFC3339Timestamp
	updated_at!: shared.#RFC3339Timestamp
	version!:    #FeedVersion
})

#EntityResource: close({
	entity_id!:   shared.#NonEmptyString
	entity_type!: shared.#NonEmptyString
	subtype!:     null | shared.#NonEmptyString
	alias!:       null | shared.#NonEmptyString
	components!:  #EntityComponents
	metadata!:    #MetadataBlock
	extra?: {[string]: shared.#JSONValue}
})

#TaskResource: close({
	task_id!:    shared.#NonEmptyString
	status!:     shared.#NonEmptyString
	entity_id!:  null | shared.#NonEmptyString
	components!: #TaskComponents
	metadata!:   #MetadataBlock
	extra?: {[string]: shared.#JSONValue}
})

#ObjectResource: close({
	object_id!:    shared.#NonEmptyString
	path!:         null | string
	content_type!: null | string
	type!:         null | string
	size_bytes!:   null | (int & >=0)
	usage_hints!: [...shared.#NonEmptyString]
	referenced_by?: [...#ObjectReference]
	bucket!:   null | string
	metadata!: #MetadataBlock
})

#FeedResource: #EntityResource | #TaskResource | #ObjectResource

#EntityCreateEvent: close({
	event!:         "create"
	resource_type!: "entity"
	id!:            shared.#NonEmptyString
	version!:       #FeedVersion
	resource!:      #EntityResource
})

#EntityUpdateEvent: close({
	event!:         "update"
	resource_type!: "entity"
	id!:            shared.#NonEmptyString
	version!:       #FeedVersion
	resource!:      #EntityResource
})

#TaskCreateEvent: close({
	event!:         "create"
	resource_type!: "task"
	id!:            shared.#NonEmptyString
	version!:       #FeedVersion
	resource!:      #TaskResource
})

#TaskUpdateEvent: close({
	event!:         "update"
	resource_type!: "task"
	id!:            shared.#NonEmptyString
	version!:       #FeedVersion
	// Interop note: Go consumers can distinguish explicit null from absent after
	// decoding raw JSON, but Go producers using *string with omitempty cannot
	// reliably emit explicit null. TypeScript and other non-Go producers may use
	// all three states. Consumers SHOULD normalize null to absent for
	// Go-originated events and MUST treat both states as "no previous entity".
	previous_entity_id?: null | shared.#NonEmptyString
	resource!:           #TaskResource
})

#ObjectCreateEvent: close({
	event!:         "create"
	resource_type!: "object"
	id!:            shared.#NonEmptyString
	version!:       #FeedVersion
	resource!:      #ObjectResource
})

#ObjectUpdateEvent: close({
	event!:         "update"
	resource_type!: "object"
	id!:            shared.#NonEmptyString
	version!:       #FeedVersion
	resource!:      #ObjectResource
})

#EntityDeleteEvent: close({
	event!:         "delete"
	resource_type!: "entity"
	id!:            shared.#NonEmptyString
	version!:       #FeedVersion
})

#TaskDeleteEvent: close({
	event!:         "delete"
	resource_type!: "task"
	id!:            shared.#NonEmptyString
	version!:       #FeedVersion
	// Interop note: Go consumers can distinguish explicit null from absent after
	// decoding raw JSON, but Go producers using *string with omitempty cannot
	// reliably emit explicit null. TypeScript and other non-Go producers may use
	// all three states. Consumers SHOULD normalize null to absent for
	// Go-originated events and MUST treat both states as "no known parent entity".
	entity_id?: null | shared.#NonEmptyString
})

#ObjectDeleteEvent: close({
	event!:         "delete"
	resource_type!: "object"
	id!:            shared.#NonEmptyString
	version!:       #FeedVersion
})

#FeedEvent: #EntityCreateEvent | #EntityUpdateEvent | #TaskCreateEvent | #TaskUpdateEvent | #ObjectCreateEvent | #ObjectUpdateEvent | #EntityDeleteEvent | #TaskDeleteEvent | #ObjectDeleteEvent

#FeedAuthMessage: close({
	action!:  "auth"
	// Sensitive credential material. Producers and consumers must not log,
	// echo, or expose this value in error responses or debug output.
	api_key!: shared.#NonEmptyString
})

#SubscribeAllMessage: close({
	action!: "subscribe"
	filter!: "all"
})

#SubscribeIDMessage: close({
	action!:        "subscribe"
	filter!:        "id"
	resource_type!: #ResourceType
	id!:            shared.#NonEmptyString
})

#SubscribeTypeMessage: close({
	action!:        "subscribe"
	filter!:        "type"
	resource_type!: #ResourceType
})

#SubscribeTasksForEntityMessage: close({
	action!:    "subscribe"
	filter!:    "tasks_for_entity"
	entity_id!: shared.#NonEmptyString
})

#FeedSubscribeMessage: #SubscribeAllMessage | #SubscribeIDMessage | #SubscribeTypeMessage | #SubscribeTasksForEntityMessage

#UnsubscribeAllMessage: close({
	action!: "unsubscribe"
	filter!: "all"
})

#UnsubscribeIDMessage: close({
	action!:        "unsubscribe"
	filter!:        "id"
	resource_type!: #ResourceType
	id!:            shared.#NonEmptyString
})

#UnsubscribeTypeMessage: close({
	action!:        "unsubscribe"
	filter!:        "type"
	resource_type!: #ResourceType
})

#UnsubscribeTasksForEntityMessage: close({
	action!:    "unsubscribe"
	filter!:    "tasks_for_entity"
	entity_id!: shared.#NonEmptyString
})

#FeedUnsubscribeMessage: #UnsubscribeAllMessage | #UnsubscribeIDMessage | #UnsubscribeTypeMessage | #UnsubscribeTasksForEntityMessage

#FeedClientMessage: #FeedAuthMessage | #FeedSubscribeMessage | #FeedUnsubscribeMessage

#FeedHandshakeMessage: close({
	type!:              "hello"
	protocol_revision!: shared.#ProtocolRevision
})
