<script setup lang="ts">
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from "vue";

export type CommandPaletteCommand = {
    id: string;
    category: string;
    label: string;
    shortcut?: string;
    disabled: boolean;
};

const props = withDefaults(
    defineProps<{
        open: boolean;
        commands: CommandPaletteCommand[];
        restoreFocusOnClose?: boolean;
    }>(),
    { restoreFocusOnClose: true },
);
const emit = defineEmits<{
    close: [];
    run: [id: string];
}>();

const query = ref("");
const activeIndex = ref(0);
const input = ref<HTMLInputElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
const optionElements = ref<HTMLElement[]>([]);
let returnFocus: HTMLElement | null = null;

const filteredCommands = computed(() => {
    const needle = query.value.trim().toLocaleLowerCase("zh-CN");
    return props.commands.filter((command) => {
        const haystack = `${command.category} ${command.label}`.toLocaleLowerCase(
            "zh-CN",
        );
        return !needle || haystack.includes(needle);
    });
});

watch(filteredCommands, (commands) => {
    activeIndex.value = Math.min(activeIndex.value, Math.max(commands.length - 1, 0));
});

watch(
    () => props.open,
    (open) => {
        if (open) {
            returnFocus =
                document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
            void nextTick(() => input.value?.focus());
            return;
        }

        query.value = "";
        activeIndex.value = 0;
        void nextTick(() => {
            if (props.restoreFocusOnClose && returnFocus?.isConnected) {
                returnFocus.focus();
            }
            returnFocus = null;
        });
    },
    { immediate: true },
);

function executeActive(): void {
    const command = filteredCommands.value[activeIndex.value];
    if (command && !command.disabled) {
        emit("run", command.id);
    }
}

function moveActive(delta: number): void {
    const count = filteredCommands.value.length;
    if (count === 0) return;
    activeIndex.value = (activeIndex.value + delta + count) % count;
    void nextTick(() => {
        const option = optionElements.value[activeIndex.value];
        if (typeof option?.scrollIntoView === "function") {
            option.scrollIntoView({ block: "nearest" });
        }
    });
}

function setOptionElement(
    element: Element | ComponentPublicInstance | null,
    index: number,
): void {
    if (element instanceof HTMLElement) optionElements.value[index] = element;
}

function requestClose(): void {
    emit("close");
}

function selectCommand(index: number): void {
    activeIndex.value = index;
    executeActive();
}

function handleKeydown(event: KeyboardEvent): void {
    switch (event.key) {
        case "ArrowDown":
            event.preventDefault();
            moveActive(1);
            break;
        case "ArrowUp":
            event.preventDefault();
            moveActive(-1);
            break;
        case "Enter":
            event.preventDefault();
            executeActive();
            break;
    }
}

function handleDialogKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
    }
    if (event.key !== "Tab") return;

    event.preventDefault();
    const active = document.activeElement;
    if (event.shiftKey) {
        (active === input.value ? closeButton.value : input.value)?.focus();
        return;
    }
    (active === closeButton.value ? input.value : closeButton.value)?.focus();
}
</script>

<template>
    <div v-if="open" class="panel-backdrop" @click.self="requestClose">
        <section
            ref="dialog"
            class="command-palette"
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-palette-title"
            @keydown="handleDialogKeydown"
        >
            <header>
                <h2 id="command-palette-title">命令面板</h2>
                <button
                    ref="closeButton"
                    type="button"
                    class="icon-button"
                    aria-label="关闭命令面板"
                    @click="requestClose"
                >
                    ×
                </button>
            </header>
            <input
                ref="input"
                v-model="query"
                aria-label="搜索命令"
                aria-controls="command-palette-list"
                :aria-activedescendant="
                    filteredCommands.length > 0
                        ? `command-palette-option-${activeIndex}`
                        : undefined
                "
                autocomplete="off"
                @keydown="handleKeydown"
            />
            <ul id="command-palette-list" class="command-palette-list" role="listbox">
                <li
                    v-for="(command, index) in filteredCommands"
                    :id="`command-palette-option-${index}`"
                    :key="command.id"
                    :ref="(element) => setOptionElement(element, index)"
                    :data-command-id="command.id"
                    class="command-palette-item"
                    :class="{
                        'is-active': index === activeIndex,
                        'is-disabled': command.disabled,
                    }"
                    role="option"
                    :aria-disabled="command.disabled"
                    :aria-selected="index === activeIndex"
                    @click="selectCommand(index)"
                >
                    <span class="command-palette-label">
                        <small>{{ command.category }}</small>
                        <span>{{ command.label }}</span>
                    </span>
                    <kbd v-if="command.shortcut">{{ command.shortcut }}</kbd>
                </li>
            </ul>
        </section>
    </div>
</template>
