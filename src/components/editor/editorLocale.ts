import type { AIFeatureConfig } from "@milkdown/crepe/feature/ai";
import type { CrepeConfig } from "@milkdown/crepe";
import type { Ctx } from "@milkdown/kit/ctx";
import { codeBlockConfig } from "@milkdown/kit/component/code-block";
import { imageBlockConfig } from "@milkdown/kit/component/image-block";
import { inlineImageConfig } from "@milkdown/kit/component/image-inline";
import { linkTooltipConfig } from "@milkdown/kit/component/link-tooltip";
import { placeholderConfig } from "@milkdown/crepe/feature/placeholder";
import { EditorState } from "@codemirror/state";
import { t } from "../../i18n";

export function codeMirrorLanguage() {
    return EditorState.phrases.of({
        get Find() {
            return t("查找", "Find");
        },
        get Replace() {
            return t("替换", "Replace");
        },
        get "Replace all"() {
            return t("全部替换", "Replace all");
        },
        get next() {
            return t("下一处", "next");
        },
        get previous() {
            return t("上一处", "previous");
        },
        get all() {
            return t("全部", "all");
        },
        get "match case"() {
            return t("区分大小写", "match case");
        },
        get "by word"() {
            return t("整词匹配", "by word");
        },
        get regexp() {
            return t("正则表达式", "regexp");
        },
        get replace() {
            return t("替换", "replace");
        },
        get "replace all"() {
            return t("全部替换", "replace all");
        },
        get close() {
            return t("关闭", "close");
        },
        get "current match"() {
            return t("当前匹配", "current match");
        },
        get "on line"() {
            return t("所在行", "on line");
        },
        get "No matches"() {
            return t("无匹配", "No matches");
        },
        get "Fold line"() {
            return t("折叠行", "Fold line");
        },
        get "Unfold line"() {
            return t("展开行", "Unfold line");
        },
        get to() {
            return t("到", "to");
        },
        get "folded lines"() {
            return t("已折叠的行", "folded lines");
        },
        get unfold() {
            return t("展开", "unfold");
        },
        get "Go to line"() {
            return t("跳转到行", "Go to line");
        },
        get go() {
            return t("跳转", "go");
        },
        get "Selection deleted"() {
            return t("已删除选区", "Selection deleted");
        },
        get Completions() {
            return t("补全", "Completions");
        },
        get Diagnostics() {
            return t("诊断", "Diagnostics");
        },
    });
}
export function editorLanguageConfig(): NonNullable<CrepeConfig["featureConfigs"]> {
    const label = (zh: string, en: string) => ({
        get label() {
            return t(zh, en);
        },
    });
    return {
        placeholder: {
            get text() {
                return t("开始写作…", "Start writing…");
            },
        },
        "block-edit": {
            textGroup: {
                ...label("正文", "Text"),
                text: label("段落", "Text"),
                h1: label("一级标题", "Heading 1"),
                h2: label("二级标题", "Heading 2"),
                h3: label("三级标题", "Heading 3"),
                h4: label("四级标题", "Heading 4"),
                h5: label("五级标题", "Heading 5"),
                h6: label("六级标题", "Heading 6"),
                quote: label("引用块", "Quote"),
                divider: label("分割线", "Divider"),
            },
            listGroup: {
                ...label("列表", "List"),
                bulletList: label("无序列表", "Bullet List"),
                orderedList: label("有序列表", "Ordered List"),
                taskList: label("任务列表", "Task List"),
            },
            advancedGroup: {
                ...label("高级", "Advanced"),
                image: label("图片", "Image"),
                codeBlock: label("代码块", "Code Block"),
                table: label("表格", "Table"),
                math: label("公式", "Math"),
            },
        },
        "code-mirror": {
            get copyText() {
                return t("复制", "Copy");
            },
            get searchPlaceholder() {
                return t("搜索语言", "Search language");
            },
            get noResultText() {
                return t("无匹配结果", "No result");
            },
            get previewLabel() {
                return t("预览", "Preview");
            },
            get previewLoading() {
                return t("正在加载…", "Loading…");
            },
            previewToggleText: (preview: boolean) =>
                preview ? t("编辑", "Edit") : t("隐藏", "Hide"),
            extensions: [codeMirrorLanguage()],
        },
        "image-block": {
            get inlineUploadButton() {
                return t("上传", "Upload");
            },
            get blockUploadButton() {
                return t("上传文件", "Upload file");
            },
            get inlineUploadPlaceholderText() {
                return t("或粘贴链接", "or paste link");
            },
            get blockUploadPlaceholderText() {
                return t("或粘贴链接", "or paste link");
            },
            get blockConfirmButton() {
                return t("确认", "Confirm");
            },
            get blockCaptionPlaceholderText() {
                return t("填写图片说明", "Write Image Caption");
            },
        },
        "link-tooltip": {
            get inputPlaceholder() {
                return t("粘贴链接…", "Paste link…");
            },
        },
    };
}

// 公开配置上下文更新文案；不替换正文、选区或历史插件。
export function applyEditorLanguage(ctx: Ctx) {
    ctx.update(placeholderConfig.key, (prev) => ({
        ...prev,
        get text() {
            return t("开始写作…", "Start writing…");
        },
    }));
    ctx.update(codeBlockConfig.key, (prev) => ({
        ...prev,
        get copyText() {
            return t("复制", "Copy");
        },
        get searchPlaceholder() {
            return t("搜索语言", "Search language");
        },
        get noResultText() {
            return t("无匹配结果", "No result");
        },
        get previewLabel() {
            return t("预览", "Preview");
        },
        get previewLoading() {
            return t("正在加载…", "Loading…");
        },
    }));
    ctx.update(imageBlockConfig.key, (prev) => ({
        ...prev,
        get uploadButton() {
            return t("上传文件", "Upload file");
        },
        get confirmButton() {
            return t("确认", "Confirm");
        },
        get captionPlaceholderText() {
            return t("填写图片说明", "Write Image Caption");
        },
        get uploadPlaceholderText() {
            return t("或粘贴链接", "or paste link");
        },
    }));
    ctx.update(inlineImageConfig.key, (prev) => ({
        ...prev,
        get uploadButton() {
            return t("上传", "Upload");
        },
        get uploadPlaceholderText() {
            return t("或粘贴链接", "or paste link");
        },
    }));
    ctx.update(linkTooltipConfig.key, (prev) => ({
        ...prev,
        get inputPlaceholder() {
            return t("粘贴链接…", "Paste link…");
        },
    }));
}

export function aiLanguageConfig(): AIFeatureConfig {
    return {
        get instructionPlaceholder() {
            return t("让 AI 帮你写作…", "Ask AI to write…");
        },
        get suggestionsHeaderLabel() {
            return t("建议", "Suggestions");
        },
        get sendAsPromptHeaderLabel() {
            return t("发送提示词", "Send as prompt");
        },
        get sendAsPromptLabel() {
            return t("发送提示词", "Send as prompt");
        },
        get submitButtonLabel() {
            return t("发送", "Send");
        },
        get listboxLabel() {
            return t("AI 建议", "AI suggestions");
        },
        diff: {
            get acceptLabel() {
                return t("接受", "Accept");
            },
            get rejectLabel() {
                return t("拒绝", "Reject");
            },
        },
        diffActions: {
            get retryLabel() {
                return t("重试", "Retry");
            },
            get rejectAllLabel() {
                return t("全部拒绝", "Reject all");
            },
            get acceptAllLabel() {
                return t("全部接受", "Accept all");
            },
        },
        streamingIndicator: {
            get fallbackLabel() {
                return t("正在生成…", "Generating…");
            },
            get cancelHint() {
                return t("取消", "Cancel");
            },
        },
        buildAISuggestions(builder) {
            for (const [id, zh, en, progress] of [
                ["improve", "润色文字", "Improve writing", "正在润色"],
                ["grammar", "修正语法和拼写", "Fix grammar & spelling", "正在修正"],
                ["shorter", "精简内容", "Make shorter", "正在精简"],
                ["longer", "扩写内容", "Make longer", "正在扩写"],
            ]) {
                const item = builder.getItem(id);
                if (item)
                    builder.addItem(id, {
                        ...item,
                        get label() {
                            return t(zh, en);
                        },
                        get streamingLabel() {
                            return t(progress, en);
                        },
                    });
            }
            for (const [group, zh, en, entries] of [
                [
                    "tone",
                    "调整语气",
                    "Change tone",
                    [
                        ["professional", "专业", "Professional"],
                        ["casual", "随意", "Casual"],
                        ["confident", "自信", "Confident"],
                        ["friendly", "友好", "Friendly"],
                        ["direct", "直接", "Direct"],
                        ["formal", "正式", "Formal"],
                    ],
                ],
                [
                    "translate",
                    "翻译",
                    "Translate",
                    [
                        ["english", "英语", "English"],
                        ["chinese", "中文", "Chinese"],
                        ["japanese", "日语", "Japanese"],
                        ["korean", "韩语", "Korean"],
                        ["spanish", "西班牙语", "Spanish"],
                        ["french", "法语", "French"],
                        ["german", "德语", "German"],
                    ],
                ],
            ] as const) {
                const sub = builder.getSubmenu(group);
                const items = entries.map(([id, zh, en]) => ({
                    id,
                    zh,
                    en,
                    item: sub?.getItem(id),
                }));
                builder.addSubmenu(
                    group,
                    {
                        icon: "",
                        get label() {
                            return t(zh, en);
                        },
                        get title() {
                            return t(zh, en);
                        },
                        get searchPlaceholder() {
                            return t("搜索…", "Search…");
                        },
                    },
                    (next) => {
                        for (const { id, zh, en, item } of items)
                            if (item)
                                next.addItem(id, {
                                    ...item,
                                    get label() {
                                        return t(zh, en);
                                    },
                                    get streamingLabel() {
                                        return t("正在处理…", "Processing…");
                                    },
                                });
                    },
                );
            }
        },
    };
}
