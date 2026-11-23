import { mentionAttrsFromNode } from './mentionRender';

import type { JSONContent } from '@tiptap/core';
import type {
    ComposerDoc,
    ComposerMentionAttrs,
    RichInputMentionSerializer,
    RichInputTrigger,
    RichInputTriggerItem,
} from './types';

export function emptyComposerDoc(): ComposerDoc {
    return {
        type: 'doc',
        content: [{ type: 'paragraph' }],
    };
}

export function plainTextToDoc(text: string): ComposerDoc {
    if (!text) {
        return emptyComposerDoc();
    }

    const lines = text.split('\n');
    const content: JSONContent[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';

        if (i > 0) {
            content.push({ type: 'hardBreak' });
        }

        if (line) {
            content.push({ type: 'text', text: line });
        }
    }

    return {
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                ...(content.length > 0 ? { content } : {}),
            },
        ],
    };
}

function walk(node: JSONContent | undefined, visit: (n: JSONContent) => void) {
    if (!node) {
        return;
    }

    visit(node);

    for (const child of node.content ?? []) {
        walk(child, visit);
    }
}

function wrapTextMarks(text: string, marks: JSONContent['marks']): string {
    if (!marks?.length) {
        return text;
    }

    let out = text;
    const types = new Set(marks.map(mark => mark.type));

    if (types.has('code')) {
        out = `\`${out}\``;
    }

    if (types.has('italic')) {
        out = `*${out}*`;
    }

    if (types.has('bold')) {
        out = `**${out}**`;
    }

    return out;
}

/** Prompt / copy text. TipTap marks become markdown so the bubble and the model see the same formatting. */
export function docToPlainText(doc: ComposerDoc, serializeMention?: RichInputMentionSerializer): string {
    const parts: string[] = [];

    const walkInline = (node: JSONContent) => {
        if (node.type === 'hardBreak') {
            parts.push('  \n');

            return;
        }

        if (node.type === 'text' && node.text) {
            parts.push(wrapTextMarks(node.text, node.marks));

            return;
        }

        if (node.type === 'composerMention') {
            const text = serializeMention?.(mentionAttrsFromNode(node.attrs ?? {}));

            if (text) {
                parts.push(text);
            }

            return;
        }

        for (const child of node.content ?? []) {
            walkInline(child);
        }
    };

    const walkBlock = (node: JSONContent) => {
        if (node.type === 'bulletList' || node.type === 'orderedList') {
            const items = node.content ?? [];
            const start = typeof node.attrs?.start === 'number' ? node.attrs.start : 1;

            for (let i = 0; i < items.length; i++) {
                if (i > 0 || (parts.length > 0 && !parts[parts.length - 1]?.endsWith('\n'))) {
                    parts.push('\n');
                }

                parts.push(node.type === 'bulletList' ? '- ' : `${start + i}. `);
                walkBlock(items[i]!);
            }

            return;
        }

        if (node.type === 'listItem') {
            for (const child of node.content ?? []) {
                walkBlock(child);
            }

            return;
        }

        if (node.type === 'paragraph') {
            walkInline(node);

            return;
        }

        walkInline(node);
    };

    const blocks = doc.content ?? [];

    for (let i = 0; i < blocks.length; i++) {
        if (i > 0) {
            parts.push('\n\n');
        }

        walkBlock(blocks[i]!);
    }

    return parts.join('');
}

export function docHasMentions(doc: ComposerDoc): boolean {
    let found = false;

    walk(doc, node => {
        if (node.type === 'composerMention') {
            found = true;
        }
    });

    return found;
}

export function docHasList(doc: ComposerDoc): boolean {
    let found = false;

    walk(doc, node => {
        if (node.type === 'bulletList' || node.type === 'orderedList') {
            found = true;
        }
    });

    return found;
}

export function docMentions(doc: ComposerDoc): ComposerMentionAttrs[] {
    const out: ComposerMentionAttrs[] = [];

    walk(doc, node => {
        if (node.type !== 'composerMention') {
            return;
        }

        const mention = mentionAttrsFromNode(node.attrs ?? {});

        if (!mention.id) {
            return;
        }

        out.push(mention);
    });

    return out;
}

export function appendTextToDoc(doc: ComposerDoc, suffix: string): ComposerDoc {
    if (!suffix) {
        return doc;
    }

    const next = structuredClone(doc);
    const paragraphs = next.content ?? [];
    let last = paragraphs[paragraphs.length - 1];

    if (last?.type !== 'paragraph') {
        last = { type: 'paragraph', content: [] };
        paragraphs.push(last);
        next.content = paragraphs;
    }

    const inline = last.content ? [...last.content] : [];
    const lastInline = inline[inline.length - 1];

    if (lastInline?.type === 'text' && typeof lastInline.text === 'string') {
        inline[inline.length - 1] = { ...lastInline, text: `${lastInline.text}${suffix}` };
    } else {
        for (const piece of plainTextToDoc(suffix).content?.[0]?.content ?? [{ type: 'text', text: suffix }]) {
            inline.push(piece);
        }
    }

    last.content = inline;

    return next;
}

function mentionNodeAttrs(mention: ComposerMentionAttrs) {
    return {
        id: mention.id,
        label: mention.label,
        kind: mention.kind,
        data: mention.data ?? null,
        mentionSuggestionChar: mention.trigger,
    };
}

export function mentionNodes(mention: ComposerMentionAttrs): JSONContent[] {
    return [
        { type: 'composerMention', attrs: mentionNodeAttrs(mention) },
        { type: 'text', text: ' ' },
    ];
}

export async function pastedTextToMentionContent(text: string, mention: RichInputTrigger): Promise<ComposerDoc[]> {
    const re = /@https?:\/\/[^\s]+/gi;
    const paragraphs: ComposerDoc[] = [];

    for (const line of text.split(/\r?\n/)) {
        const inline: ComposerDoc[] = [];
        let last = 0;

        for (const match of line.matchAll(re)) {
            const full = match[0] ?? '';
            const idx = match.index ?? 0;

            if (idx > last) {
                inline.push({ type: 'text', text: line.slice(last, idx) });
            }

            let item: RichInputTriggerItem | undefined;

            try {
                item = (await Promise.resolve(mention.onSearch(full.slice(1))))[0];
            } catch {
                item = undefined;
            }

            if (item?.kind === 'link' && !item.action) {
                inline.push(
                    ...mentionNodes({
                        id: item.value,
                        label: item.displayText ?? item.label,
                        kind: item.kind,
                        trigger: '@',
                        data: item.data,
                    })
                );
            } else {
                inline.push({ type: 'text', text: full });
            }

            last = idx + full.length;
        }

        if (last < line.length) {
            inline.push({ type: 'text', text: line.slice(last) });
        }

        paragraphs.push({
            type: 'paragraph',
            ...(inline.length > 0 ? { content: inline } : {}),
        });
    }

    return paragraphs;
}

export function upsertMentionInDoc(doc: ComposerDoc, mention: ComposerMentionAttrs): ComposerDoc {
    const next = removeMentionsByIds(doc, [mention.id]);
    const paragraphs = next.content ?? [];
    let last = paragraphs[paragraphs.length - 1];

    if (last?.type !== 'paragraph') {
        last = { type: 'paragraph', content: [] };
        paragraphs.push(last);
        next.content = paragraphs;
    }

    const inline = last.content ? [...last.content] : [];

    if (inline.length > 0) {
        const tail = inline[inline.length - 1];

        if (tail?.type !== 'text' || !tail.text?.endsWith(' ')) {
            inline.push({ type: 'text', text: ' ' });
        }
    }

    inline.push(...mentionNodes(mention));
    last.content = inline;

    return next;
}

/** Insert a mention at the start of the first paragraph. Replaces an existing chip with the same id. */
export function prependMentionInDoc(doc: ComposerDoc, mention: ComposerMentionAttrs): ComposerDoc {
    const next = removeMentionsByIds(doc, [mention.id]);
    const paragraphs = next.content ?? [];
    let first = paragraphs[0];

    if (first?.type !== 'paragraph') {
        first = { type: 'paragraph', content: [] };
        next.content = [first, ...paragraphs];
    }

    first.content = [...mentionNodes(mention), ...(first.content ?? [])];

    return next;
}

/** Update mention attrs in place (same id) — does not move the chip. */
export function patchMentionInDoc(doc: ComposerDoc, mention: ComposerMentionAttrs): ComposerDoc {
    const next = structuredClone(doc);
    let found = false;

    const patchInline = (nodes: JSONContent[] | undefined): void => {
        if (!nodes || found) {
            return;
        }

        for (const node of nodes) {
            if (node.type === 'composerMention' && node.attrs?.id === mention.id) {
                node.attrs = {
                    ...node.attrs,
                    ...mentionNodeAttrs(mention),
                };
                found = true;

                return;
            }

            if (node.content) {
                patchInline(node.content);
            }
        }
    };

    for (const block of next.content ?? []) {
        patchInline(block.content);

        if (found) {
            break;
        }
    }

    return found ? next : doc;
}

export function removeMentionsByIds(doc: ComposerDoc, ids: Iterable<string>): ComposerDoc {
    const drop = new Set(ids);
    const next = structuredClone(doc);

    const filterInline = (nodes: JSONContent[] | undefined): JSONContent[] | undefined => {
        if (!nodes) {
            return nodes;
        }

        return nodes.filter(node => {
            if (node.type === 'composerMention') {
                const id = node.attrs?.id;

                return !(typeof id === 'string' && drop.has(id));
            }

            if (node.content) {
                node.content = filterInline(node.content);
            }

            return true;
        });
    };

    next.content = (next.content ?? []).map(block => {
        if (block.content) {
            block.content = filterInline(block.content);
        }

        return block;
    });

    return next;
}

export function docsEqual(a: ComposerDoc, b: ComposerDoc): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}
