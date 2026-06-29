package atlasprotocol

import shared "github.com/the-drunken-coder/atlas/atlas_protocol/schema/shared"

#ErrorCode:
	"VALIDATION_ERROR" |
	"INVALID_JSON" |
	"BODY_TOO_LARGE" |
	"INVALID_FORM" |
	"UNAUTHORIZED" |
	"TOO_MANY_ATTEMPTS" |
	"FEED_UNAVAILABLE" |
	"STORAGE_UNAVAILABLE" |
	"STORAGE_ERROR" |
	"CONTENT_TYPE_NOT_VIEWABLE" |
	"FILE_TOO_LARGE" |
	"READ_ERROR" |
	"INTERNAL_SERVER_ERROR" |
	"ENTITY_NOT_FOUND" |
	"ENTITY_ALIAS_NOT_FOUND" |
	"TASK_NOT_FOUND" |
	"OBJECT_NOT_FOUND" |
	"BUCKET_NOT_FOUND" |
	"ENTITY_ALREADY_EXISTS" |
	"TASK_ALREADY_EXISTS" |
	"OBJECT_ALREADY_EXISTS" |
	"OBJECT_PATH_CONFLICT" |
	"PRECONDITION_FAILED"

#ErrorResponse: close({
	success!:    false
	message!:    shared.#NonEmptyString
	error_code!: #ErrorCode
	error_id?:   shared.#NonEmptyString
	timestamp?:  shared.#RFC3339Timestamp
	path?:       string
	details?: {[string]: shared.#JSONValue}
})
