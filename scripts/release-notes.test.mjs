import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { releaseNotesForVersion, releaseSectionForSlack } from "./release-notes.mjs";

describe("release notes", () => {
  it("extracts the requested version and joins wrapped changeset lines", () => {
    const changelog = `# Package

## 0.3.0

### Minor Changes

- d3dac93: Add browser authorization, including secure storage,
  SSH-friendly login, and automatic refresh.
- Updated dependencies [d3dac93]
  - @traice/protocol@0.1.3

## 0.2.9

- Older change.
`;

    assert.deepEqual(releaseNotesForVersion(changelog, "0.3.0"), [
      "Add browser authorization, including secure storage, SSH-friendly login, and automatic refresh.",
    ]);
  });

  it("formats Slack-safe package sections", () => {
    const section = releaseSectionForSlack("@traice/sdk", "1.2.3", ["Handle <unsafe> values & preserve details."]);

    assert.equal(section, "*@traice/sdk@1.2.3*\n• Handle &lt;unsafe&gt; values &amp; preserve details.");
  });

  it("fails when the published version has no changelog section", () => {
    assert.throws(
      () => releaseNotesForVersion("# Package\n\n## 1.0.0\n\n- Initial release.\n", "2.0.0"),
      /Could not find ## 2.0.0/,
    );
  });
});
