//go:build !windows

package main

import "testing"

func TestOscTitleDropsControlCharacters(t *testing.T) {
	cases := map[string]string{
		"~/dev":                "\x1b]2;~/dev\x07",
		"":                     "\x1b]2;\x07",
		"evil\x07\x1b[2Jtail":  "\x1b]2;evil[2Jtail\x07",
		"tab\there \u0085 ünï": "\x1b]2;tabhere  ünï\x07",
	}
	for in, want := range cases {
		if got := string(oscTitle(in)); got != want {
			t.Errorf("oscTitle(%q) = %q, want %q", in, got, want)
		}
	}
}
