package pluginid

import "testing"

func TestIdentifierAndToolAssetID(t *testing.T) {
	for _, valid := range []string{"a", "reference", "adsb_monitor", "a0_b1"} {
		if !Valid(valid) {
			t.Fatalf("Valid(%q) = false", valid)
		}
	}
	for _, invalid := range []string{"", "A", "a-b", "a.b", "a__b", "a_", "0a"} {
		if Valid(invalid) {
			t.Fatalf("Valid(%q) = true", invalid)
		}
	}
	if got, want := DeriveToolAssetID("adsb"), "plugin_rfSey5Te4YU6Prz-hpGcwRnuSBuF9z1COTHZJt_s0G4"; got != want {
		t.Fatalf("DeriveToolAssetID(adsb) = %q, want %q", got, want)
	}
}
