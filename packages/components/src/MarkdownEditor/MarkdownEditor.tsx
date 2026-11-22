import { cn } from '@clowdy/lib';
import { EditorContent, useEditor } from '@tiptap/react';
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Scrollable } from '../Scrollable';
import { Show } from '../Show';
import { Text } from '../Text';
import {
    canonicalMarkdown,
    frontMatterBefore,
    markdownExtensions,
    markdownSupport,
    splitFrontMatter,
    withTrailingNewline,
    type ResolveImageSrc,
} from './markdownDocument';
import styles from './MarkdownEditor.module.css';
import { MarkdownToolbar } from './MarkdownToolbar';
import { reconcileMarkdown } from './reconcileMarkdown';

import type { Editor } from '@tiptap/core';

export interface MarkdownEditorProps {
    /** The whole markdown file, front matter included. */
    value: string;
    /** The whole markdown file after a user edit. Loading or replacing `value` never calls it. */
    onChange?: (value: string) => void;
    /** Called instead of showing `value` when the file is too large to load. */
    onUnsupported?: (reason: string) => void;
    /** Shown after the reason when the editor shows `value` read-only, because it would lose part of it on save. */
    unsupportedAction?: ReactNode;
    /** Image sources go through it for display; the document keeps the written path. */
    resolveImageSrc?: ResolveImageSrc;
    /** `false` shows the file without the toolbar and takes no edits. */
    editable?: boolean;
    'aria-label'?: string;
    className?: string;
}

/**
 * For each editor, the body it last loaded or emitted, as the file writes it, and its serialization.
 * A transaction that leaves the document equal emits nothing, so the record outlives such documents.
 */
const shownBodies = new WeakMap<Editor, { body: string; canonical: string }>();

/** Rich text editing for a markdown file: markdown in through `value`, out through `onChange`. */
export function MarkdownEditor({
    value,
    onChange,
    onUnsupported,
    unsupportedAction,
    resolveImageSrc,
    editable = true,
    'aria-label': ariaLabel = 'Markdown',
    className,
}: MarkdownEditorProps): ReactNode {
    // TipTap captures its callbacks once; they read the latest props from here.
    const latest = useRef({ value, onChange, onUnsupported, resolveImageSrc });

    useLayoutEffect(() => {
        latest.current = { value, onChange, onUnsupported, resolveImageSrc };
    });

    // eslint-disable-next-line react-hooks/refs -- image node views call the resolver, after render
    const [extensions] = useState(() => markdownExtensions(
        src => latest.current.resolveImageSrc?.(src) ?? Promise.resolve(src)
    ));
    // Created during the first render, so that render already knows whether `value` is supported.
    const editor = useEditor({
        extensions,
        editorProps: {
            attributes: { class: styles.prose, 'aria-label': ariaLabel },
        },
        onUpdate: ({ editor: tiptap }) => {
            const { value } = latest.current;
            const edited = tiptap.getMarkdown();
            const shown = shownBodies.get(tiptap);
            const frontMatter = (shown && frontMatterBefore(value, shown.body)) ?? splitFrontMatter(value).frontMatter;
            // The edit lands in the file's own text, so untouched blocks keep how they were written.
            const body = shown
                ? reconcileMarkdown({ source: shown.body, baseCanonical: shown.canonical, edited, roundTrip: canonicalMarkdown })
                : edited;
            // Front matter that ends the file may lack its final newline.
            const head = frontMatter && body && !frontMatter.endsWith('\n') ? `${ frontMatter }\n` : frontMatter;
            const file = withTrailingNewline(head + body, value);

            shownBodies.set(tiptap, { body: file.slice(head.length), canonical: edited });
            latest.current.onChange?.(file);
        },
    }, []);

    // `null` while the editor already shows the body, as after its own emit; only other bodies are checked.
    const support = useMemo(() => {
        const shown = shownBodies.get(editor);

        return shown && frontMatterBefore(value, shown.body) !== null ? null : markdownSupport(splitFrontMatter(value).body);
    }, [editor, value]);
    const unsupported = support?.supported === false ? support : null;

    // TipTap keeps the editable state it was created with when its options change.
    useLayoutEffect(() => {
        editor.setEditable(editable && !unsupported, false);
    }, [editor, editable, unsupported]);

    useLayoutEffect(() => {
        if (!support) {
            return;
        }

        if (unsupported?.tooLarge) {
            latest.current.onUnsupported?.(unsupported.reason);

            return;
        }

        const { body } = splitFrontMatter(value);

        // An external value is not an edit: no update event, no undo step.
        editor
            .chain()
            .setMeta('addToHistory', false)
            .setContent(body, { contentType: 'markdown', emitUpdate: false })
            .run();

        // A body shown read-only is checked again with the next value.
        if (unsupported) {
            shownBodies.delete(editor);
        }
        else {
            shownBodies.set(editor, { body, canonical: editor.getMarkdown() });
        }
    }, [editor, support, unsupported, value]);

    const { frontMatter } = splitFrontMatter(value);

    if (unsupported?.tooLarge) {
        return null;
    }

    return (
        <div className={ cn(styles.root, className) }>
            <Show when={ editable }>
                <Show when={ unsupported } fallback={ <MarkdownToolbar editor={ editor } /> }>
                    { ({ reason }) => (
                        <div className={ styles.notice }>
                            <Text variant="sm" color="secondary">{ reason }</Text>
                            { unsupportedAction }
                        </div>
                    ) }
                </Show>
            </Show>

            <Scrollable className={ styles.scroll } contentClass={ styles.page }>
                <Show when={ frontMatter }>
                    <figure className={ styles.frontMatter }>
                        <Text as="figcaption" variant="label" color="secondary">
                            Front matter · edit it in source mode
                        </Text>
                        <pre className={ styles.frontMatterCode }>{ frontMatter.trimEnd() }</pre>
                    </figure>
                </Show>

                <EditorContent editor={ editor } />
            </Scrollable>
        </div>
    );
}
