export type LeaveDecision = "save" | "discard" | "cancel";

export async function runLeaveDecision(
    decision: LeaveDecision,
    save: () => Promise<boolean>,
) {
    if (decision === "discard") return true;
    if (decision === "cancel") return false;
    return save();
}
