package atlasprotocol

import shared "github.com/the-drunken-coder/atlas/atlas_protocol/schema/shared"

#KnownTaskComponents: [
	"command",
	"parameters",
	"progress",
	"target",
	"status_message",
]

#CommandComponent: close({
	type!:       shared.#NonEmptyString
	id?:         shared.#NonEmptyString
	target?:     #JSONValue
	parameters?: #JSONValue
})

#TaskParametersComponent: {
	latitude?:  shared.#Latitude
	longitude?: shared.#Longitude
	[string]:   #JSONValue
}

#TaskProgressComponent: {
	percent?:    shared.#FiniteNumber & >=0 & <=100
	updated_at?: shared.#RFC3339Timestamp
	[string]:    #JSONValue
}

#TaskComponents: {
	command?:        #CommandComponent
	parameters?:     #TaskParametersComponent
	progress?:       #TaskProgressComponent
	target?:         #TaskParametersComponent
	status_message?: string
	[=~"^custom_"]:  #JSONValue
}

#TaskBlob: {
	components?: #TaskComponents
	[string]:    #JSONValue
}
