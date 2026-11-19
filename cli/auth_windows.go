//go:build windows

package main

func relayRuntimeDir() string {
	return ""
}

func defaultLogDir() string {
	return ""
}

func ensurePrivateDir(_ string) error {
	return errWindowsUnsupported
}

func checkSecureRuntimeDir(_ string) error {
	return errWindowsUnsupported
}

func checkSecureTokenFile(_ string) error {
	return errWindowsUnsupported
}

func writeRelayTokenFileInDir(_ string, _ int, _ string) (string, func(), error) {
	return "", nil, errWindowsUnsupported
}

func readRelayTokenFileInDir(_ string, _ int) (string, error) {
	return "", errWindowsUnsupported
}
