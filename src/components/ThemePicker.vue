<script setup lang="ts">
import { t } from "../i18n";

import { THEME_OPTIONS, type ThemeId } from "../composables/usePreferences";

defineProps<{
    theme: ThemeId;
}>();

const emit = defineEmits<{
    select: [theme: ThemeId];
}>();
</script>

<template>
    <section class="theme-picker" aria-labelledby="theme-picker-title">
        <header class="theme-picker-header">
            <div>
                <h2 id="theme-picker-title">{{ t("选择主题", "Choose theme") }}</h2>
                <p>
                    {{
                        t(
                            "横向滚动浏览，点击后立即切换",
                            "Scroll horizontally and click to switch",
                        )
                    }}
                </p>
            </div>
        </header>

        <div
            class="theme-picker-track"
            role="radiogroup"
            :aria-label="t('界面主题', 'Interface theme')"
        >
            <button
                v-for="option in THEME_OPTIONS"
                :key="option.id"
                type="button"
                class="theme-card"
                role="radio"
                :data-theme-choice="option.id"
                :data-theme-preview="option.id"
                :aria-checked="theme === option.id"
                @click="emit('select', option.id)"
            >
                <span class="theme-card-preview" aria-hidden="true">
                    <span class="theme-card-chrome" />
                    <span class="theme-card-sidebar" />
                    <span class="theme-card-page">
                        <span class="theme-card-heading" />
                        <span class="theme-card-line" />
                        <span class="theme-card-line short" />
                    </span>
                </span>
                <span class="theme-card-label">
                    <span>{{ option.label }}</span>
                    <span class="theme-card-check" aria-hidden="true">✓</span>
                </span>
            </button>
        </div>
    </section>
</template>
