export function isTextInputTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) return false;

    if (target.closest("input, textarea, select")) return true;

    const editable = target.closest("[contenteditable]");
    return editable !== null && editable.getAttribute("contenteditable") !== "false";
}
