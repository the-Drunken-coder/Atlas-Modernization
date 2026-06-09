package actions

// MergeJSONValue deep-merges nested map[string]interface{} values (recursive key merge).
// Non-map values—including slices and scalars—are replaced entirely by the incoming value.
func MergeJSONValue(existing, incoming interface{}) interface{} {
	existingMap, existingOK := existing.(map[string]interface{})
	incomingMap, incomingOK := incoming.(map[string]interface{})
	if !existingOK || !incomingOK {
		return incoming
	}

	merged := make(map[string]interface{}, len(existingMap))
	for k, v := range existingMap {
		merged[k] = v
	}
	for k, v := range incomingMap {
		merged[k] = MergeJSONValue(merged[k], v)
	}

	return merged
}
