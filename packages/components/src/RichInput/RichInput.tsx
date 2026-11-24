'use client';

import { clamp, cn } from '@clowdy/lib';
import { mergeAttributes, Node, textblockTypeInputRule } from '@tiptap/core';
import Bold from '@tiptap/extension-bold';
import Code from '@tiptap/extension-code';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import History from '@tiptap/extension-history';
import Italic from '@tiptap/extension-italic';
import { ListKit, OrderedList } from '@tiptap/extension-list';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
import { PluginKey } from '@tiptap/pm/state';
import { EditorContent, useEditor } from '@tiptap/react';
import {
    createElement,
    type ReactNode,
    type Ref,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';

import { docsEqual, docToPlainText, emptyComposerDoc, mentionNodes, pastedTextToMentionContent } from './composerDoc';
import { handleComposerKeyDown } from './composerKeymap';
import { ComposerMention } from './composerMention';
import {
    defaultRenderMention,
    defaultSerializeMention,
    mentionAttrsFromNode,
    RichInputMentionContext,
} from './mentionRender';
import styles from './RichInput.module.css';
import { type RichInputTriggerAnchor, RichInputTriggerMenu } from './RichInputTriggerMenu';

import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import type {
    ComposerDoc,
    ComposerMentionAttrs,
    RichInputHandle,
    RichInputMentionRenderer,
    RichInputMentionSerializer,
    RichInputTrigger,
    RichInputTriggerItem,
    RichInputTriggerPlacement,
} from './types';

export type RichInputProps = {
    value?: ComposerDoc;
    onChange?: (doc: ComposerDoc) => void;
    triggers?: readonly RichInputTrigger[];
    /**
     * How to paint an inline mention/command atom. TipTap NodeViews portal under
     * {@link EditorContent}, so this is provided via context (not extension config).
     * Default: plain label text.
     */
    renderMention?: RichInputMentionRenderer;
    /**
     * Plain-text form of a mention for copy/paste and {@link docToPlainText}.
     * Default: omit (`''`) — chips are atoms, not typed characters.
     */
    serializeMention?: RichInputMentionSerializer;
    placeholder?: string;
    className?: string;
    disabled?: boolean;
    /** Markdown input rules: bold/italic/code, lists (`- ` / `1. `) and quotes (`> `). Default true. */
    markdown?: boolean;
    autoFocus?: boolean;
    minHeight?: number;
    maxHeight?: number;
    /** Enter submits. Default false — Enter starts a new paragraph; Cmd/Ctrl+Enter submits when `onSubmit` is set. */
    submitOnEnter?: boolean;
    'aria-label'?: string;
    onSubmit?: (doc: ComposerDoc, origin?: { mod: boolean }) => void;
    onEscape?: () => void;
    onPasteFiles?: (files: File[]) => void;
    /**
     * Plain-text paste hook. Return true to consume the paste (no doc insert).
     * File pastes are handled by {@link onPasteFiles} first.
     */
    onPasteText?: (text: string) => boolean;
    id?: string;
    ref?: Ref<RichInputHandle>;
};

type MenuState = {
    char: string;
    accessibilityLabel: string;
    items: RichInputTriggerItem[];
    selectedKey: string | null;
    anchor: RichInputTriggerAnchor;
    placement: RichInputTriggerPlacement;
    command: (item: RichInputTriggerItem) => void;
};

type Bridge = {
    triggers: readonly RichInputTrigger[];
    submitOnEnter: boolean;
    placeholder: string;
    onChange?: (doc: ComposerDoc) => void;
    onPasteFiles?: (files: File[]) => void;
    onPasteText?: (text: string) => boolean;
    renderMention?: RichInputMentionRenderer;
    serializeMention?: RichInputMentionSerializer;
    onSubmit?: (doc: ComposerDoc, origin?: { mod: boolean }) => void;
    onEscape?: () => void;
    setMenu: (menu: MenuState | null) => void;
    getMenu: () => MenuState | null;
    setMenuItems: (items: RichInputTriggerItem[]) => void;
    getEditorDoc: () => ComposerDoc;
    insertContent: (content: ComposerDoc | ComposerDoc[]) => void;
};

const EMPTY_TRIGGERS: readonly RichInputTrigger[] = [];

const ComposerQuote = Node.create<{ markdown: boolean }>({
    name: 'composerQuote',
    group: 'block',
    content: 'inline*',
    defining: true,
    parseHTML: () => [{ tag: 'blockquote[data-composer-quote]' }],
    renderHTML: () => ['blockquote', { 'data-composer-quote': '' }, 0],
    addOptions: () => ({ markdown: true }),
    addInputRules() {
        return this.options.markdown ? [textblockTypeInputRule({ find: /^> $/, type: this.type })] : [];
    },
});

function createBridge(setMenu: (menu: MenuState | null) => void): Bridge {
    let menu: MenuState | null = null;

    const bridge: Bridge = {
        triggers: EMPTY_TRIGGERS,
        submitOnEnter: false,
        placeholder: '',
        getMenu: () => menu,
        setMenu: next => {
            menu = next;
            setMenu(next);
        },
        setMenuItems: items => {
            const current = menu;

            if (!current) {
                return;
            }

            menu = {
                ...current,
                items,
                selectedKey: items.some(i => i.value === current.selectedKey)
                    ? current.selectedKey
                    : (items[0]?.value ?? null),
            };
            setMenu(menu);
        },
        getEditorDoc: () => emptyComposerDoc(),
        insertContent: () => undefined,
    };

    return bridge;
}

function triggerAnchor(
    trigger: RichInputTrigger,
    caret: DOMRect | null | undefined,
    fallback?: RichInputTriggerAnchor
): RichInputTriggerAnchor {
    const host = trigger.getAnchorRect?.();

    if (host) {
        return { x: host.left, top: host.top, bottom: host.bottom, width: host.width };
    }

    if (caret) {
        return { x: caret.left, top: caret.top, bottom: caret.bottom };
    }

    return fallback ?? { x: 0, top: 0, bottom: 0 };
}

function buildSuggestionRender(bridge: Bridge, triggerChar: string) {
    return () => {
        let activeChar = triggerChar;
        let searchSeq = 0;

        const runSearch = (trigger: RichInputTrigger, query: string) => {
            const seq = ++searchSeq;

            void Promise.resolve(trigger.onSearch(query)).then(items => {
                if (seq !== searchSeq) {
                    return;
                }

                bridge.setMenuItems(items);
            });
        };

        return {
            onStart: (props: SuggestionProps<RichInputTriggerItem>) => {
                const match = bridge.triggers.find(t => t.char === activeChar);
                const rect = props.clientRect?.();

                if (!match) {
                    return;
                }

                activeChar = match.char;
                bridge.setMenu({
                    char: match.char,
                    accessibilityLabel: match.accessibilityLabel,
                    items: [],
                    selectedKey: null,
                    placement: match.placement ?? 'auto',
                    anchor: triggerAnchor(match, rect),
                    command: item => props.command(item),
                });
                runSearch(match, props.query);
            },
            onUpdate: (props: SuggestionProps<RichInputTriggerItem>) => {
                const match = bridge.triggers.find(t => t.char === activeChar);
                const rect = props.clientRect?.();
                const current = bridge.getMenu();

                if (!match || !current) {
                    return;
                }

                bridge.setMenu({
                    ...current,
                    placement: match.placement ?? current.placement,
                    anchor: triggerAnchor(match, rect, current.anchor),
                    command: item => props.command(item),
                });
                runSearch(match, props.query);
            },
            onExit: () => {
                searchSeq += 1;
                bridge.triggers.find(t => t.char === activeChar)?.onClose?.();
                bridge.setMenu(null);
            },
            onKeyDown: ({ event }: SuggestionKeyDownProps) => {
                const current = bridge.getMenu();

                if (!current) {
                    return false;
                }

                if (event.key === 'Escape') {
                    if (current.items.length === 0) {
                        return false;
                    }

                    bridge.setMenu(null);

                    return true;
                }

                if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && current.items.length > 0) {
                    const index = current.items.findIndex(i => i.value === current.selectedKey);
                    const next =
                        event.key === 'ArrowDown'
                            ? current.items[Math.min(index + 1, current.items.length - 1)]
                            : current.items[Math.max(index - 1, 0)];

                    bridge.setMenu({ ...current, selectedKey: next?.value ?? null });

                    return true;
                }

                if ((event.key === 'Enter' || event.key === 'Tab' || event.key === ' ') && current.items.length > 0) {
                    const item = current.items.find(i => i.value === current.selectedKey) ?? current.items[0];

                    if (!item) {
                        return false;
                    }

                    if (event.key === ' ' && item.kind !== 'link') {
                        return false;
                    }

                    if (item.action) {
                        item.action({
                            setItems: items => bridge.setMenuItems(items),
                        });

                        return true;
                    }

                    current.command(item);

                    return true;
                }

                return false;
            },
        };
    };
}

const FOREIGN_TEXT_ENTRY = [
    'textarea',
    'input:not([type="hidden"])',
    '[contenteditable]:not([contenteditable="false"])',
    '.cm-editor',
    '.monaco-editor',
].join(', ');

type MountedEditor = {
    isDestroyed: boolean;
    view: { dom: Element };
};

function mountedEditorDom(editor: MountedEditor | null): Element | null {
    if (!editor || editor.isDestroyed) {
        return null;
    }

    try {
        return editor.view.dom;
    } catch {
        return null;
    }
}

function isTextEntry(active: Element): boolean {
    if (active.closest(FOREIGN_TEXT_ENTRY)) {
        return true;
    }

    if (!(active instanceof HTMLIFrameElement)) {
        return false;
    }

    try {
        const inner = active.contentDocument?.activeElement;

        return Boolean(
            inner &&
                inner !== active.contentDocument?.body &&
                inner !== active.contentDocument?.documentElement &&
                inner.closest(FOREIGN_TEXT_ENTRY)
        );
    } catch {
        return false;
    }
}

/**
 * An editor recreate (triggers or markdown change) must not pull focus
 * out of a comment, code editor, or other field. First mount has no root yet and still autofocuses.
 */
export function shouldYieldRichInputAutofocus(ownRoot: Element | null): boolean {
    if (!ownRoot || typeof document === 'undefined') {
        return false;
    }

    const active = document.activeElement;

    if (!active || active === document.body || active === document.documentElement) {
        return false;
    }

    if (active === ownRoot || ownRoot.contains(active)) {
        return false;
    }

    return isTextEntry(active);
}

/**
 * TipTap composer input. Inline mention chrome comes from {@link RichInputProps.renderMention}.
 */
export function RichInput({
    value,
    onChange,
    triggers = EMPTY_TRIGGERS,
    renderMention,
    serializeMention,
    placeholder = '',
    className,
    disabled,
    markdown = true,
    autoFocus,
    minHeight = 24,
    maxHeight,
    submitOnEnter = false,
    'aria-label': ariaLabel,
    onSubmit,
    onEscape,
    onPasteFiles,
    onPasteText,
    id,
    ref,
}: RichInputProps): ReactNode {
    const [menu, setMenu] = useState<MenuState | null>(null);
    const [getBridge] = useState(() => {
        const live = createBridge(setMenu);

        return () => live;
    });
    const bridge = getBridge();
    // Stable for TipTap portals — always delegates to the latest prop / default.
    // Must `createElement` (not call): front `observer`/compiler wrappers are objects.
    const [mentionRenderer] = useState(() => {
        const render: RichInputMentionRenderer = props => {
            const Impl = getBridge().renderMention ?? defaultRenderMention;

            return createElement(Impl, props);
        };

        return render;
    });
    /** Last caret pos — used when pinning layers/files while the editor is blurred. */
    const lastPosRef = useRef(1);

    const rememberPos = (tipTapEditor: { state: { selection: { head: number } } }) => {
        lastPosRef.current = tipTapEditor.state.selection.head;
    };

    bridge.triggers = triggers;
    bridge.submitOnEnter = submitOnEnter;
    bridge.placeholder = placeholder;
    bridge.onChange = onChange;
    bridge.onPasteFiles = onPasteFiles;
    bridge.onPasteText = onPasteText;
    bridge.renderMention = renderMention;
    bridge.serializeMention = serializeMention;
    bridge.onSubmit = onSubmit;
    bridge.onEscape = onEscape;

    const triggerKey = triggers.map(t => `${t.char}:${t.position ?? 'any'}`).join('|');
    // Previous editor root, so a recreate can see where focus was before TipTap swaps the DOM.
    const [yieldRoot, setYieldRoot] = useState<Element | null>(null);

    const editor = useEditor(
        {
            immediatelyRender: false,
            editable: !disabled,
            autofocus: autoFocus && !shouldYieldRichInputAutofocus(yieldRoot) ? 'end' : false,
            extensions: [
                Document,
                Paragraph,
                Text,
                ComposerQuote.configure({ markdown }),
                HardBreak.extend({
                    addKeyboardShortcuts() {
                        return {};
                    },
                }),
                History,
                ...(markdown
                    ? [
                          Bold,
                          Italic,
                          Code,
                          ListKit.configure({ orderedList: false, taskItem: false, taskList: false }),
                          OrderedList.extend({
                              // CSS draws the numbers (see `.editor ol`); seed the counter from `start`.
                              renderHTML({ node, HTMLAttributes }) {
                                  return [
                                      'ol',
                                      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
                                          style: `counter-reset: rich-input-ol ${node.attrs.start - 1}`,
                                      }),
                                      0,
                                  ];
                              },
                          }),
                      ]
                    : []),
                Placeholder.configure({ placeholder: () => bridge.placeholder }),
                ComposerMention.configure({
                    // Backspace on a chip must not leave a stray `@` / `/` trigger char.
                    deleteTriggerWithBackspace: true,
                    renderText: ({ node }) =>
                        (bridge.serializeMention ?? defaultSerializeMention)(mentionAttrsFromNode(node.attrs)),
                    suggestions: triggers.map(trigger => ({
                        char: trigger.char,
                        pluginKey: new PluginKey(`rich-input-${trigger.char}`),
                        startOfLine: trigger.position === 'start',
                        allowedPrefixes: trigger.position === 'start' ? null : undefined,
                        items: () => [],
                        render: buildSuggestionRender(bridge, trigger.char),
                        command: ({ editor: tipTapEditor, range, props }) => {
                            const item = props as unknown as RichInputTriggerItem;

                            if (item.action) {
                                return;
                            }

                            if (item.run) {
                                tipTapEditor.chain().focus().deleteRange(range).run();
                                item.run();

                                return;
                            }

                            if (!item.kind) {
                                return;
                            }

                            tipTapEditor
                                .chain()
                                .focus()
                                .insertContentAt(
                                    range,
                                    mentionNodes({
                                        id: item.value,
                                        label: item.displayText ?? item.label,
                                        kind: item.kind,
                                        trigger: trigger.char,
                                        data: item.data,
                                    })
                                )
                                .run();
                        },
                    })),
                }),
            ],
            content: value ?? emptyComposerDoc(),
            editorProps: {
                attributes: {
                    ...(id ? { id } : {}),
                    ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
                    class: styles.editor,
                    style: [
                        `min-height:${minHeight}px`,
                        maxHeight != null ? `max-height:${maxHeight}px` : null,
                        maxHeight != null ? 'overflow-y:auto' : null,
                    ]
                        .filter(Boolean)
                        .join(';'),
                },
                handleKeyDown: (view, event) =>
                    handleComposerKeyDown(view, event, {
                        submitOnEnter: bridge.submitOnEnter,
                        hasMenuItems: Boolean(bridge.getMenu()?.items.length),
                        onSubmit: origin => bridge.onSubmit?.(bridge.getEditorDoc(), origin),
                        onEscape: bridge.onEscape,
                        closeMenu: () => bridge.setMenu(null),
                    }),
                handlePaste: (_view, event) => {
                    const files = event.clipboardData?.files;

                    if (files && files.length > 0 && bridge.onPasteFiles) {
                        bridge.onPasteFiles([...files]);
                        event.preventDefault();

                        return true;
                    }

                    const text = event.clipboardData?.getData('text/plain') ?? '';

                    if (text && bridge.onPasteText?.(text)) {
                        event.preventDefault();

                        return true;
                    }

                    const mention = bridge.triggers.find(trigger => trigger.char === '@');

                    if (!mention || !text || !/@https?:\/\/\S/i.test(text)) {
                        return false;
                    }

                    event.preventDefault();
                    void pastedTextToMentionContent(text, mention).then(content => {
                        bridge.setMenu(null);
                        bridge.insertContent(content);
                    });

                    return true;
                },
            },
            onUpdate: ({ editor: tipTapEditor }) => {
                rememberPos(tipTapEditor);
                bridge.onChange?.(tipTapEditor.getJSON() as ComposerDoc);
            },
            onSelectionUpdate: ({ editor: tipTapEditor }) => {
                rememberPos(tipTapEditor);
            },
            onBlur: ({ editor: tipTapEditor }) => {
                rememberPos(tipTapEditor);
            },
        },
        [triggerKey, markdown]
    );

    useLayoutEffect(() => {
        setYieldRoot(mountedEditorDom(editor));
    }, [editor]);

    bridge.getEditorDoc = () => (editor?.getJSON() as ComposerDoc | undefined) ?? emptyComposerDoc();
    bridge.insertContent = content => {
        editor?.chain().focus().insertContent(content).run();
    };

    useLayoutEffect(() => {
        if (!editor || value == null) {
            return;
        }

        if (!docsEqual(editor.getJSON() as ComposerDoc, value)) {
            // External/controlled sync must not push history steps — otherwise Cmd+Z
            // undoes the sync, then the prop re-applies and undo looks broken.
            editor.chain().setMeta('addToHistory', false).setContent(value, { emitUpdate: false }).run();

            const pos = clamp(1, lastPosRef.current, editor.state.doc.content.size);

            lastPosRef.current = pos;

            if (editor.isFocused) {
                editor.commands.setTextSelection(pos);
            }
        }
    }, [editor, value]);

    useEffect(() => {
        editor?.setEditable(!disabled);
    }, [editor, disabled]);

    // Redraw the placeholder decoration in place; recreating the editor would drop focus.
    useEffect(() => {
        if (editor && !editor.isDestroyed) {
            editor.view.dispatch(editor.state.tr);
        }
    }, [editor, placeholder]);

    useImperativeHandle(
        ref,
        () => ({
            focus: () => {
                if (!editor) {
                    return;
                }

                const pos = clamp(1, lastPosRef.current, editor.state.doc.content.size);

                editor.chain().focus().setTextSelection(pos).run();
            },
            getDoc: () => (editor?.getJSON() as ComposerDoc) ?? emptyComposerDoc(),
            getPlainText: () =>
                docToPlainText((editor?.getJSON() as ComposerDoc) ?? emptyComposerDoc(), getBridge().serializeMention),
            insertMention: (attrs: ComposerMentionAttrs) => {
                if (!editor) {
                    return;
                }

                const pos = clamp(1, lastPosRef.current, editor.state.doc.content.size);

                editor.chain().insertContentAt(pos, mentionNodes(attrs)).focus().run();
                rememberPos(editor);
            },
            appendText: (text: string) => {
                if (!text) {
                    return;
                }

                editor?.chain().focus('end').insertContent(text).run();
                if (editor) {
                    rememberPos(editor);
                }
            },
        }),
        [editor, getBridge]
    );

    return (
        <RichInputMentionContext value={mentionRenderer}>
            <EditorContent
                editor={editor}
                className={cn(styles.root, className)}
                data-rich-input-menu={menu?.items.length ? '' : undefined}
            />
            <RichInputTriggerMenu
                isOpen={Boolean(menu?.items.length)}
                anchor={menu?.anchor ?? null}
                placement={menu?.placement ?? 'auto'}
                items={menu?.items ?? []}
                selectedKey={menu?.selectedKey ?? null}
                accessibilityLabel={menu?.accessibilityLabel ?? 'Suggestions'}
                onSelect={item => {
                    if (item.action) {
                        item.action({
                            setItems: items => bridge.setMenuItems(items),
                        });

                        return;
                    }

                    menu?.command(item);
                    bridge.setMenu(null);
                }}
            />
        </RichInputMentionContext>
    );
}
