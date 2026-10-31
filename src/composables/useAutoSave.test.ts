import { ref, nextTick } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoSave, type AutoSaveDocument } from "./useAutoSave";

const disposers: Array<() => void> = [];
afterEach(() => {
    disposers.splice(0).forEach((dispose) => dispose());
    vi.useRealTimers();
});
function setup() {
    vi.useFakeTimers();
    const enabled = ref(false),
        paused = ref(false);
    const documents = ref<AutoSaveDocument[]>([
        {
            id: "a",
            path: "a.md",
            revision: "1",
            dirty: true,
            conflict: false,
            unavailable: false,
        },
    ]);
    const save = vi.fn(async (_document: AutoSaveDocument) => {});
    const failed = vi.fn();
    disposers.push(
        useAutoSave(
            () => ({
                enabled: enabled.value,
                paused: paused.value,
                documents: documents.value,
            }),
            save,
            failed,
        ),
    );
    return { enabled, paused, documents, save, failed };
}
it("默认关闭；修改后重新计时，五秒停笔才保存", async () => {
    const s = setup();
    await vi.advanceTimersByTimeAsync(6000);
    expect(s.save).not.toHaveBeenCalled();
    s.enabled.value = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(4000);
    s.documents.value[0].revision = "2";
    await nextTick();
    await vi.advanceTimersByTimeAsync(4000);
    expect(s.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.save).toHaveBeenCalledTimes(1);
});
it("跳过未命名、干净、冲突及不可用文档；保存其他已打开文档", async () => {
    const s = setup();
    const base = s.documents.value[0];
    s.documents.value = [
        base,
        { ...base, id: "b", path: "b.mdx" },
        { ...base, id: "new", path: null },
        { ...base, id: "clean", dirty: false },
        { ...base, id: "conflict", conflict: true },
        { ...base, id: "missing", unavailable: true },
    ];
    s.enabled.value = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.save.mock.calls.map(([d]) => d.id)).toEqual(["a", "b"]);
});
it("保存中不重叠，期间新编辑仍会在完成后保存", async () => {
    const s = setup();
    let finish!: () => void;
    s.save.mockImplementationOnce(
        () =>
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
    );
    s.enabled.value = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(5000);
    s.documents.value[0].revision = "2";
    await nextTick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.save).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20000);
    expect(s.save).toHaveBeenCalledTimes(2);
});
it("失败后暂停，手动保存成功或重新开启后恢复", async () => {
    const s = setup();
    s.save.mockRejectedValueOnce(new Error("disk full"));
    s.enabled.value = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.failed).toHaveBeenCalledTimes(1);
    s.documents.value[0].revision = "2";
    await nextTick();
    await vi.advanceTimersByTimeAsync(20000);
    expect(s.save).toHaveBeenCalledTimes(1);
    s.documents.value[0].dirty = false;
    await nextTick();
    s.documents.value[0].dirty = true;
    s.documents.value[0].revision = "3";
    await nextTick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.save).toHaveBeenCalledTimes(2);
    s.enabled.value = false;
    await nextTick();
    s.enabled.value = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.save).toHaveBeenCalledTimes(3);
});
it("全局暂停或关闭文档时取消待保存任务，解除暂停后重新计时", async () => {
    const s = setup();
    s.enabled.value = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(4000);
    s.paused.value = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.save).not.toHaveBeenCalled();
    s.paused.value = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.save).toHaveBeenCalledTimes(1);
    s.documents.value[0].revision = "2";
    await nextTick();
    s.documents.value = [];
    await nextTick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.save).toHaveBeenCalledTimes(1);
});
