import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseVersions } from "./check-release-version.mjs";

test("accepts matching repository and tag versions", () => {
    assert.equal(
        validateReleaseVersions({
            packageVersion: "0.1.0",
            cargoVersion: "0.1.0",
            tauriVersion: "0.1.0",
            releaseTag: "app-v0.1.0",
        }),
        "0.1.0",
    );
});

test("rejects a mismatched repository version", () => {
    assert.throws(
        () =>
            validateReleaseVersions({
                packageVersion: "0.1.0",
                cargoVersion: "0.1.1",
                tauriVersion: "0.1.0",
                releaseTag: "app-v0.1.0",
            }),
        /版本不一致/,
    );
});

test("rejects a malformed or mismatched release tag", () => {
    assert.throws(
        () =>
            validateReleaseVersions({
                packageVersion: "0.1.0",
                cargoVersion: "0.1.0",
                tauriVersion: "0.1.0",
                releaseTag: "v0.2.0",
            }),
        /app-v0\.1\.0/,
    );
});
