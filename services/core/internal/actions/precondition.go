package actions

func checkExpectedVersion(resourceType string, expectedVersion *int64, currentVersion int64) error {
	if expectedVersion == nil {
		return nil
	}
	if *expectedVersion != currentVersion {
		return NewPreconditionFailedError(resourceType)
	}
	return nil
}
