package ui

import "testing"

func TestResolveColorPolicyCases(t *testing.T) {
	for _, testCase := range generatedColorPolicyCases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := resolveColorSupport(testCase.tty, testCase.noColor, testCase.forceColor, testCase.forceColorSet, testCase.term); got != testCase.want {
				t.Fatalf("resolveColorSupport() = %t, want %t", got, testCase.want)
			}
		})
	}
}
