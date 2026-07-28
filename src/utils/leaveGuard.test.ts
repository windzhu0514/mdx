import { describe, expect, it, vi } from "vitest";

import { runLeaveDecision } from "./leaveGuard";

describe("leave guard", () => {
    it("continues after discard", async () => {
        expect(await runLeaveDecision("discard", vi.fn())).toBe(true);
    });

    it("stops after cancel", async () => {
        expect(await runLeaveDecision("cancel", vi.fn())).toBe(false);
    });

    it("continues only when save succeeds", async () => {
        expect(await runLeaveDecision("save", vi.fn().mockResolvedValue(true))).toBe(
            true,
        );
        expect(await runLeaveDecision("save", vi.fn().mockResolvedValue(false))).toBe(
            false,
        );
    });
});
