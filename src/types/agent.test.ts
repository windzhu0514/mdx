import { describe, expect, it } from "vitest";

import { AGENT_ERROR_CODES } from "./agent";

describe("agent protocol types", () => {
    it("exports every stable error code used by the shared protocol", () => {
        expect(AGENT_ERROR_CODES).toEqual([
            "AGENT_ACCESS_DISABLED",
            "MORA_NOT_RUNNING",
            "BRIDGE_UNAVAILABLE",
            "BRIDGE_ALREADY_RUNNING",
            "DOCUMENT_NOT_FOUND",
            "DOCUMENT_NOT_OPEN",
            "DOCUMENT_BUSY",
            "SAVE_AS_REQUIRED",
            "REVISION_CONFLICT",
            "DISK_CONFLICT",
            "INVALID_MDX",
            "REQUEST_TOO_LARGE",
            "PERMISSION_DENIED",
            "TIMEOUT",
            "PROTOCOL_MISMATCH",
        ]);
    });
});
