import { cn, mergeRefs } from '@clowdy/lib';
import {
    type CSSProperties,
    lazy,
    type ReactNode,
    type Ref,
    Suspense,
    useCallback,
    useMemo,
    useRef,
    useState,
} from 'react';
import { Group } from 'react-aria-components';

import { elementScrollAxisSource, ScrollChromeBars, ScrollChromeRoot, useScrollChrome } from '../Scrollable';
import { Show } from '../Show';
import styles from './CodeTextarea.module.css';

import type { EditorView as CodeMirrorEditorView } from '@codemirror/view';
import type { BasicSetupOptions, Extension, ReactCodeMirrorRef } from '@uiw/react-codemirror';

export type CodeTextareaVariant = 'filled' | 'bordered' | 'transparent' | 'inline';
export type CodeTextareaSize = 'sm' | 'md' | 'lg';

const TEXTAREA_LIKE_SETUP: BasicSetupOptions = {
    lineNumbers: false,
    highlightActiveLineGutter: false,
    foldGutter: false,
    dropCursor: false,
    allowMultipleSelections: false,
    indentOnInput: true,
    bracketMatching: true,
    closeBrackets: true,
    autocompletion: false,
    rectangularSelection: false,
    crosshairCursor: false,
    highlightActiveLine: false,
    highlightSelectionMatches: false,
    searchKeymap: false,
    foldKeymap: false,
    completionKeymap: false,
    lintKeymap: false,
};

export interface CodeTextareaProps {
    variant?: CodeTextareaVariant;
    size?: CodeTextareaSize;
    /**
     * When true (default), editor height grows with content.
     * When false, height is fixed from `rows` (or `height`).
     */
    autoResize?: boolean;
    /** Minimum visible lines when autoResize; fixed lines when not. */
    rows?: number;
    /** Explicit CodeMirror height. Overrides autoResize / rows when set. */
    height?: string;
    maxHeight?: string;
    value?: string;
    defaultValue?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
    className?: string;
    /** Classes on the CodeMirror host element. */
    editorClassName?: string;
    isDisabled?: boolean;
    isInvalid?: boolean;
    isReadOnly?: boolean;
    autoFocus?: boolean;
    /** Extra CodeMirror extensions (languages, keymap, etc.). */
    extensions?: Extension[];
    /** Soft-wrap long lines (default). Set false for horizontal scroll (e.g. expressions). */
    lineWrapping?: boolean;
    /**
     * Override default textarea-like basicSetup.
     * Object values are merged on top of the textarea-like defaults.
     */
    basicSetup?: boolean | BasicSetupOptions;
    indentWithTab?: boolean;
    'aria-label'?: string;
    'aria-labelledby'?: string;
    ref?: Ref<ReactCodeMirrorRef | null>;
    /** Top-end control inside the field (e.g. jump-to-source). */
    endAction?: ReactNode;
}

function resolveBasicSetup(basicSetup: boolean | BasicSetupOptions | undefined): boolean | BasicSetupOptions {
    if (basicSetup === undefined) {
        return TEXTAREA_LIKE_SETUP;
    }

    if (typeof basicSetup === 'boolean') {
        return basicSetup;
    }

    return { ...TEXTAREA_LIKE_SETUP, ...basicSetup };
}

type CodeTextareaMirrorProps = {
    editorRef: Ref<ReactCodeMirrorRef | null>;
    className?: string;
    doc: string;
    autoResize: boolean;
    maxHeight?: string;
    autoFocus?: boolean;
    placeholder?: string;
    isDisabled?: boolean;
    isReadOnly?: boolean;
    indentWithTab: boolean;
    basicSetup: boolean | BasicSetupOptions;
    lineWrapping: boolean;
    extensions?: Extension[];
    ariaLabel?: string;
    ariaLabelledBy?: string;
    isInvalid?: boolean;
    onCreateEditor: (view: CodeMirrorEditorView) => void;
    onChange?: (value: string) => void;
    isUncontrolled: boolean;
    uncontrolledRef: { current: string };
};

const CodeTextareaMirror = lazy(async () => {
    const { default: CodeMirror, EditorView } = await import('@uiw/react-codemirror');

    function Mirror({
        editorRef,
        className,
        doc,
        autoResize,
        maxHeight,
        autoFocus,
        placeholder,
        isDisabled,
        isReadOnly,
        indentWithTab,
        basicSetup,
        lineWrapping,
        extensions,
        ariaLabel,
        ariaLabelledBy,
        isInvalid,
        onCreateEditor,
        onChange,
        isUncontrolled,
        uncontrolledRef,
    }: CodeTextareaMirrorProps) {
        const mergedExtensions = useMemo(() => {
            const next: Extension[] = [];

            if (lineWrapping) {
                next.push(EditorView.lineWrapping);
            }

            if (ariaLabel || ariaLabelledBy || isInvalid) {
                next.push(
                    EditorView.contentAttributes.of({
                        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
                        ...(ariaLabelledBy ? { 'aria-labelledby': ariaLabelledBy } : {}),
                        ...(isInvalid ? { 'aria-invalid': 'true' } : {}),
                    })
                );
            }

            if (extensions) {
                next.push(...extensions);
            }

            return next;
        }, [ariaLabel, ariaLabelledBy, isInvalid, extensions, lineWrapping]);

        return (
            <CodeMirror
                ref={editorRef}
                className={className}
                value={doc}
                theme="none"
                height={autoResize ? 'auto' : '100%'}
                maxHeight={autoResize ? maxHeight : '100%'}
                width="100%"
                autoFocus={autoFocus}
                placeholder={placeholder}
                editable={!isDisabled}
                readOnly={isReadOnly}
                indentWithTab={indentWithTab}
                basicSetup={basicSetup}
                extensions={mergedExtensions}
                onCreateEditor={onCreateEditor}
                onChange={next => {
                    if (isUncontrolled) {
                        uncontrolledRef.current = next;
                    }

                    onChange?.(next);
                }}
            />
        );
    }

    return { default: Mirror };
});

export function CodeTextarea({
    variant = 'filled',
    size = 'md',
    autoResize = true,
    rows = 1,
    height: heightProp,
    maxHeight,
    value,
    defaultValue,
    onChange,
    placeholder,
    className,
    editorClassName,
    isDisabled,
    isInvalid,
    isReadOnly,
    autoFocus,
    extensions,
    lineWrapping = true,
    basicSetup,
    indentWithTab = true,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    ref,
    endAction,
}: CodeTextareaProps) {
    const editorRef = useRef<ReactCodeMirrorRef>(null);
    const uncontrolledRef = useRef(defaultValue ?? '');
    // eslint-disable-next-line react-hooks/refs -- uncontrolled fallback; `.current` is the last typed value
    const doc = value ?? uncontrolledRef.current;
    const minRows = Math.max(1, rows);
    const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

    // Custom chrome when CM can scroll (cap / fixed height / no wrap).
    const verticalChrome = Boolean(maxHeight) || !autoResize;
    const horizontalChrome = !lineWrapping;

    const getScrollElement = useCallback(() => scrollEl, [scrollEl]);

    const verticalSource = useMemo(
        () => (verticalChrome ? elementScrollAxisSource(getScrollElement, 'vertical') : null),
        [getScrollElement, verticalChrome]
    );

    const horizontalSource = useMemo(
        () => (horizontalChrome ? elementScrollAxisSource(getScrollElement, 'horizontal') : null),
        [getScrollElement, horizontalChrome]
    );

    const chrome = useScrollChrome({
        verticalSource,
        horizontalSource,
        sourceKey: scrollEl,
    });

    const resolvedHeight =
        heightProp ??
        (autoResize
            ? 'auto'
            : `calc(var(--clowdy-textarea-line-height, var(--leading-md)) * ${minRows} + var(--clowdy-textarea-padding-block) * 2)`);

    const fieldStyle = {
        '--clowdy-textarea-min-rows': minRows,
        ...(maxHeight ? { '--clowdy-code-textarea-max-height': maxHeight } : {}),
        ...(!autoResize && resolvedHeight !== 'auto' ? { '--clowdy-code-textarea-height': resolvedHeight } : {}),
    } as CSSProperties;

    const onCreateEditor = useCallback((view: CodeMirrorEditorView) => {
        setScrollEl(view.scrollDOM);
    }, []);

    const editor = (
        <Suspense fallback={<div className={cn(styles.editor, editorClassName)} />}>
            <CodeTextareaMirror
                // eslint-disable-next-line react-hooks/refs -- mergeRefs composes; it does not read `.current`
                editorRef={mergeRefs(editorRef, ref)}
                className={cn(styles.editor, editorClassName)}
                doc={doc}
                autoResize={autoResize}
                maxHeight={maxHeight}
                autoFocus={autoFocus}
                placeholder={placeholder}
                isDisabled={isDisabled}
                isReadOnly={isReadOnly}
                indentWithTab={indentWithTab}
                basicSetup={resolveBasicSetup(basicSetup)}
                lineWrapping={lineWrapping}
                extensions={extensions}
                ariaLabel={ariaLabel}
                ariaLabelledBy={ariaLabelledBy}
                isInvalid={isInvalid}
                onCreateEditor={onCreateEditor}
                onChange={onChange}
                isUncontrolled={value === undefined}
                uncontrolledRef={uncontrolledRef}
            />
        </Suspense>
    );

    return (
        <Group
            className={cn(styles.field, className)}
            data-variant={variant}
            data-size={size}
            data-autoresize={autoResize ? 'true' : 'false'}
            data-max-height={maxHeight ? '' : undefined}
            data-end-action={endAction ? '' : undefined}
            isDisabled={isDisabled}
            isReadOnly={isReadOnly}
            isInvalid={isInvalid}
            data-modal-drag-exclude
            onClick={() => {
                editorRef.current?.view?.focus();
            }}
            style={fieldStyle}
        >
            <Show when={verticalChrome || horizontalChrome} fallback={editor}>
                <ScrollChromeRoot
                    rootRef={chrome.rootRef}
                    className={styles.scrollChrome}
                    vertical={verticalChrome}
                    horizontal={horizontalChrome}
                    rootPointerHandlers={chrome.rootPointerHandlers}
                >
                    {editor}
                    <ScrollChromeBars
                        vertical={verticalChrome}
                        horizontal={horizontalChrome}
                        setScrollbarV={chrome.setScrollbarV}
                        setScrollbarH={chrome.setScrollbarH}
                        onPointerDown={chrome.handlePointerDown}
                    />
                </ScrollChromeRoot>
            </Show>
            <Show when={endAction}>
                <span
                    className={styles.endAction}
                    onClick={event => {
                        event.stopPropagation();
                    }}
                    onPointerDown={event => {
                        event.stopPropagation();
                    }}
                >
                    {endAction}
                </span>
            </Show>
        </Group>
    );
}

CodeTextarea.displayName = 'CodeTextarea';
