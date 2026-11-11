package main

import "testing"

func TestPackageIdentityRemovesPinnedVersion(t *testing.T) {
	for _, test := range []struct {
		spec string
		want string
	}{
		{spec: "@kb-labs/commit@1.0.0", want: "@kb-labs/commit"},
		{spec: "@kb-labs/commit", want: "@kb-labs/commit"},
		{spec: "commit@1.0.0", want: "commit"},
	} {
		if got := packageIdentity(test.spec); got != test.want {
			t.Errorf("packageIdentity(%q) = %q; want %q", test.spec, got, test.want)
		}
	}
}
