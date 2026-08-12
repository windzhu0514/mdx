import { watch, type Ref } from "vue";

const SCROLL_IDLE_DELAY_MS = 700;
const SCROLLBAR_HIT_AREA_PX = 12;

export function useScrollActivity(
    scrollElement: Readonly<Ref<HTMLElement | null | undefined>>,
): void {
    watch(
        scrollElement,
        (element, _previousElement, onCleanup) => {
            if (!element) return;

            let hideTimer: number | undefined;
            const hideScrollbar = () => {
                delete element.dataset.scrollActive;
                hideTimer = undefined;
            };
            const showScrollbar = () => {
                element.dataset.scrollActive = "true";
                if (hideTimer !== undefined) window.clearTimeout(hideTimer);
                hideTimer = window.setTimeout(hideScrollbar, SCROLL_IDLE_DELAY_MS);
            };
            const updateScrollbarHover = (event: MouseEvent) => {
                const bounds = element.getBoundingClientRect();
                const insideVertically =
                    event.clientY >= bounds.top && event.clientY <= bounds.bottom;
                const insideHorizontally =
                    event.clientX >= bounds.left && event.clientX <= bounds.right;
                const overVerticalScrollbar =
                    element.scrollHeight > element.clientHeight &&
                    insideVertically &&
                    event.clientX >= bounds.right - SCROLLBAR_HIT_AREA_PX &&
                    event.clientX <= bounds.right;
                const overHorizontalScrollbar =
                    element.scrollWidth > element.clientWidth &&
                    insideHorizontally &&
                    event.clientY >= bounds.bottom - SCROLLBAR_HIT_AREA_PX &&
                    event.clientY <= bounds.bottom;

                if (overVerticalScrollbar || overHorizontalScrollbar) {
                    element.dataset.scrollHover = "true";
                } else {
                    delete element.dataset.scrollHover;
                }
            };
            const clearScrollbarHover = () => {
                delete element.dataset.scrollHover;
            };

            element.addEventListener("scroll", showScrollbar, { passive: true });
            window.addEventListener("mousemove", updateScrollbarHover, {
                passive: true,
            });
            window.addEventListener("blur", clearScrollbarHover);
            onCleanup(() => {
                element.removeEventListener("scroll", showScrollbar);
                window.removeEventListener("mousemove", updateScrollbarHover);
                window.removeEventListener("blur", clearScrollbarHover);
                if (hideTimer !== undefined) window.clearTimeout(hideTimer);
                delete element.dataset.scrollActive;
                delete element.dataset.scrollHover;
            });
        },
        { flush: "post", immediate: true },
    );
}
