import type { JSONContent } from '@tiptap/core';
import type { ReactNode } from 'react';

export type ComposerDoc = JSONContent;

export type ComposerMentionKind = 'file' | 'variable' | 'layer' | 'command' | 'link' | 'integration' | 'task' | 'doc';

export type ComposerMentionAttrs = {
    id: string;
    label: string;
    kind: ComposerMentionKind;
    trigger: string;
    data?: unknown;
};

/** Props passed to {@link RichInputProps.renderMention}. */
export type RichInputMentionRenderProps = {
    mention: ComposerMentionAttrs;
    deleteNode: () => void;
};

export type RichInputMentionRenderer = (props: RichInputMentionRenderProps) => ReactNode;

/** How a mention appears in copy/paste and {@link docToPlainText} (markdown for marks). Empty string omits it. */
export type RichInputMentionSerializer = (mention: ComposerMentionAttrs) => string;

/** Helpers for non-insert trigger rows (categories / drill-in menus). */
export type RichInputTriggerActionContext = {
    /** Replace the open menu’s items without inserting a mention or closing. */
    setItems: (items: RichInputTriggerItem[]) => void;
};

export type RichInputTriggerItem = {
    value: string;
    label: string;
    description?: string;
    icon?: ReactNode;
    endAffix?: ReactNode;
    /**
     * Consecutive items with the same `section` share a group.
     * A non-empty value is shown as the section header (e.g. `Skills`).
     * Omit for an unlabeled group. Empty groups are not rendered.
     */
    section?: string;
    /** Required to insert a mention; omit when `action` handles the row. */
    kind?: ComposerMentionKind;
    /** Chip label; defaults to `label`. */
    displayText?: string;
    data?: unknown;
    /**
     * Non-insert row (category, “Files & Folders”, Back, …).
     * Keeps the trigger open; use `setItems` to drill into a submenu.
     */
    action?: (ctx: RichInputTriggerActionContext) => void;
    /**
     * Consume the trigger query, close the menu, do not insert a mention.
     * Chat `/summarize` (send a turn) and local commands (open settings) use this.
     * Distinct from {@link action}, which stays in the slash session.
     */
    run?: () => void;
};

export type RichInputTriggerPlacement = 'auto' | 'top';

export type RichInputTrigger = {
    char: string;
    /** Restrict to line start (e.g. `/`). */
    position?: 'any' | 'start';
    accessibilityLabel: string;
    /** Fired when the suggestion menu closes (Escape, blur, insert). */
    onClose?: () => void;
    onSearch: (query: string) => RichInputTriggerItem[] | Promise<RichInputTriggerItem[]>;
    /**
     * Pin the menu to this rect instead of the caret. Chat `/` and `@` use the
     * composer surface so the list sits on the box, not the glyph.
     */
    getAnchorRect?: () => DOMRect | null;
    /** `top` always opens above the anchor. Default `auto` (more viewport room). */
    placement?: RichInputTriggerPlacement;
};

export type RichInputHandle = {
    focus: () => void;
    getDoc: () => ComposerDoc;
    getPlainText: () => string;
    insertMention: (attrs: ComposerMentionAttrs) => void;
    appendText: (text: string) => void;
};
