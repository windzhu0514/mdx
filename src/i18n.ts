import { computed, ref } from "vue";

export type LanguagePreference = "system" | "zh-CN" | "en";
export function normalizeLanguage(value: unknown): LanguagePreference {
    return value === "zh-CN" || value === "en" ? value : "system";
}
export function resolveLanguage(
    preference: LanguagePreference,
    systemLanguage = typeof navigator === "undefined" ? "en" : navigator.language,
): "zh-CN" | "en" {
    return preference === "system"
        ? /^zh(?:-|$)/i.test(systemLanguage)
            ? "zh-CN"
            : "en"
        : preference;
}
export const locale = ref(resolveLanguage("system"));
export const appName = computed(() => (locale.value === "zh-CN" ? "墨笺" : "Mora"));
export function t(chinese: string, english: string): string {
    return locale.value === "zh-CN" ? chinese : english;
}
