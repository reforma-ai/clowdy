import { AttentionCircle } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Alert, AlertAction, AlertIcon, AlertTitle } from '../Alert';
import { Box } from '../Box';
import { Breadcrumb } from '../Breadcrumb';
import { Button } from '../Button';
import { For } from '../For';
import { tooltipWithHotkey } from '../Hotkey';
import { ListBox, ListBoxHeader, ListBoxItem, ListBoxSection } from '../List';
import { ModalContext } from '../Modal/hooks/useModalProvider';
import { confirmDiscardChanges } from '../modals/ConfirmModal';
import { Scrollable } from '../Scrollable';
import { Show } from '../Show';
import { Text } from '../Text';
import { toast } from '../Toast';
import { layerRest, paneTransition, SLIDE_IN } from './motion';
import styles from './SettingsLayout.module.css';

import type { ReactNode, RefObject } from 'react';

const MotionScrollable = motion.create(Scrollable);

const SAVE_HOTKEY = ['mod', 's'] as const;

function isSaveHotkey(event: KeyboardEvent): boolean {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return false;
    }

    return event.key === 's' || event.key === 'S';
}

export interface SettingsNavItem {
    id: string;
    label: string;
    icon?: ReactNode;
    /** A heading over the item, shared with the ones after it that name the same group. Items with none stay as a flat list. */
    group?: string;
}

export interface SettingsStackItem {
    id: string;
    label: string;
}

interface SettingsLayoutContextValue {
    items: readonly SettingsNavItem[];
    selectedId: string;
    select: (id: string) => void;
    stack: readonly SettingsStackItem[];
    push: (item: SettingsStackItem) => void;
    rename: (id: string, label: string) => void;
    pop: () => void;
    reset: () => void;
}

const SettingsLayoutContext = createContext<SettingsLayoutContextValue | null>(null);
const SettingsOverlayContext = createContext<HTMLElement | null>(null);
/** The line under the title, in the header: what `Intro` draws there, from wherever the page keeps it. */
const SettingsDescriptionContext = createContext<HTMLElement | null>(null);
/** The key of the pane whose content is being drawn, so an `Intro` in it knows it belongs to that pane and not to the page under it. */
const SettingsPaneContext = createContext<string | undefined>(undefined);
const SettingsLeaveGuardContext = createContext<RefObject<(() => boolean | Promise<boolean>) | null> | null>(null);

function settleLeave(decision: boolean | Promise<boolean>, apply: () => void) {
    if (decision === true) {
        apply();

        return;
    }

    if (decision === false) {
        return;
    }

    void decision.then(allowed => {
        if (allowed) {
            apply();
        }
    });
}

export function useSettingsLayout(): SettingsLayoutContextValue {
    const ctx = use(SettingsLayoutContext);

    if (!ctx) {
        throw new Error('useSettingsLayout must be used inside SettingsLayout');
    }

    return ctx;
}

type SettingsSaveCopy = {
    dirty: string;
    saving: string;
    saved: string;
    tooltip?: string;
};

type SettingsSaveVerb = 'save' | 'add' | SettingsSaveCopy;

interface SettingsSaveContextValue {
    saveRef: RefObject<(() => Promise<boolean>) | null>;
    discardRef: RefObject<(() => void) | null>;
    onDirtyChange: (dirty: boolean) => void;
    setSaveVerb: (verb: SettingsSaveVerb) => void;
}

const SettingsSaveContext = createContext<SettingsSaveContextValue | null>(null);

export function useSettingsSave(): SettingsSaveContextValue {
    const ctx = use(SettingsSaveContext);

    if (!ctx) {
        throw new Error('useSettingsSave must be used inside SettingsLayout.Content with saveable prop');
    }

    return ctx;
}

export interface SettingsLayoutProps {
    items: readonly SettingsNavItem[];
    defaultSelected?: string;
    defaultStack?: readonly SettingsStackItem[];
    /** Makes the section the host's to hold: the layout shows this one and asks for a change through `onSelectedChange` (a section left with the leave guard's leave). */
    selectedId?: string;
    onSelectedChange?: (id: string) => void;
    /** Likewise for the nested views over the section, deepest last: `onStackChange` is told the whole stack that a push, a pop, a rename or leaving the section makes. */
    stack?: readonly SettingsStackItem[];
    onStackChange?: (stack: readonly SettingsStackItem[]) => void;
    className?: string;
    children: ReactNode;
}

function SettingsLayoutRoot({
    items,
    defaultSelected,
    defaultStack,
    selectedId: selectedIdProp,
    onSelectedChange,
    stack: stackProp,
    onStackChange,
    className,
    children,
}: SettingsLayoutProps) {
    const [ownSelectedId, setOwnSelectedId] = useState(defaultSelected ?? items[0]?.id ?? '');
    const [ownStack, setOwnStack] = useState<readonly SettingsStackItem[]>(() =>
        defaultStack ? [...defaultStack] : []
    );
    const selectedId = selectedIdProp ?? ownSelectedId;
    const stack = stackProp ?? ownStack;
    const leaveGuardRef = useRef<(() => boolean | Promise<boolean>) | null>(null);
    // The stack as the last change left it, so two changes in one turn (a push, then a rename of what was pushed) build on each other whoever holds the stack.
    const latestStack = useRef(stack);

    useEffect(() => {
        latestStack.current = stack;
    }, [stack]);

    const setSelectedId = (id: string) => {
        if (selectedIdProp === undefined) {
            setOwnSelectedId(id);
        }

        onSelectedChange?.(id);
    };

    const changeStack = (update: (current: readonly SettingsStackItem[]) => readonly SettingsStackItem[]) => {
        const next = update(latestStack.current);

        latestStack.current = next;

        if (stackProp === undefined) {
            setOwnStack(next);
        }

        onStackChange?.(next);
    };

    const select = (id: string) => {
        const changeTab = id !== selectedId;
        const clearStack = stack.length > 0;

        if (!changeTab && !clearStack) {
            return;
        }

        settleLeave(leaveGuardRef.current?.() ?? true, () => {
            if (changeTab) {
                setSelectedId(id);
            }

            if (clearStack) {
                changeStack(() => []);
            }
        });
    };

    const pop = () => {
        if (stack.length === 0) {
            return;
        }

        settleLeave(leaveGuardRef.current?.() ?? true, () => {
            changeStack(current => current.slice(0, -1));
        });
    };

    const reset = () => {
        if (stack.length === 0) {
            return;
        }

        settleLeave(leaveGuardRef.current?.() ?? true, () => {
            changeStack(() => []);
        });
    };

    return (
        <SettingsLeaveGuardContext value={leaveGuardRef}>
            <SettingsLayoutContext
                value={{
                    items,
                    selectedId,
                    select,
                    stack,
                    push: item => changeStack(current => [...current, item]),
                    rename: (id, label) => {
                        if (latestStack.current.some(item => item.id === id && item.label !== label)) {
                            changeStack(current =>
                                current.map(item =>
                                    item.id === id && item.label !== label ? { ...item, label } : item
                                )
                            );
                        }
                    },
                    pop,
                    reset,
                }}
            >
                <div className={cn(styles.root, className)}>{children}</div>
            </SettingsLayoutContext>
        </SettingsLeaveGuardContext>
    );
}

export interface SettingsLayoutSidebarProps {
    title?: string;
    className?: string;
    'aria-label'?: string;
    footer?: ReactNode;
}

/** The items in runs that share a group, in order. A run with no group is a flat part of the list. */
function navRuns(items: readonly SettingsNavItem[]): Array<{ group?: string; items: SettingsNavItem[] }> {
    const runs: Array<{ group?: string; items: SettingsNavItem[] }> = [];

    for (const item of items) {
        const last = runs.at(-1);

        if (last && last.group === item.group) {
            last.items.push(item);
        } else {
            runs.push({ group: item.group, items: [item] });
        }
    }

    return runs;
}

function Sidebar({
    title,
    className,
    'aria-label': ariaLabel = 'Settings sections',
    footer,
}: SettingsLayoutSidebarProps) {
    const { items, selectedId, select } = useSettingsLayout();

    return (
        <div className={cn(styles.sidebar, className)}>
            <Show when={title}>
                <Text variant="sm" color="secondary" className={styles.sidebarTitle}>
                    {title}
                </Text>
            </Show>
            <ListBox
                aria-label={ariaLabel}
                size="md"
                selectionMode="single"
                selectedKeys={[selectedId]}
                disallowEmptySelection
            >
                <For each={navRuns(items)}>
                    {(run, index) => {
                        const rows = run.items.map(item => (
                            <ListBoxItem
                                key={item.id}
                                id={item.id}
                                icon={item.icon}
                                textValue={item.label}
                                onPress={() => select(item.id)}
                            >
                                {item.label}
                            </ListBoxItem>
                        ));

                        return run.group === undefined ? (
                            rows
                        ) : (
                            <ListBoxSection key={`${index}:${run.group}`}>
                                <ListBoxHeader>{run.group}</ListBoxHeader>
                                {rows}
                            </ListBoxSection>
                        );
                    }}
                </For>
            </ListBox>
            <Show when={footer}>
                <div className={styles.sidebarFooter}>{footer}</div>
            </Show>
        </div>
    );
}

function Title() {
    const { items, selectedId, stack, reset } = useSettingsLayout();
    const rootLabel = items.find(item => item.id === selectedId)?.label ?? '';

    return (
        <Breadcrumb variant="heading-2" className={styles.title}>
            {stack.length === 0 ? (
                <Breadcrumb.Page key="root">{rootLabel}</Breadcrumb.Page>
            ) : (
                <Breadcrumb.Link key="root" onPress={reset}>
                    {rootLabel}
                </Breadcrumb.Link>
            )}
            <For each={stack}>{item => <Breadcrumb.Page key={item.id}>{item.label}</Breadcrumb.Page>}</For>
        </Breadcrumb>
    );
}

export interface SettingsLayoutPaneProps {
    paneKey?: string;
    className?: string;
    children: ReactNode;
}

/** Nested view over the content viewport. Previous layer stays mounted (scroll kept). */
function Pane({ paneKey, className, children }: SettingsLayoutPaneProps) {
    const { stack } = useSettingsLayout();
    const overlay = use(SettingsOverlayContext);
    const reducedMotion = useReducedMotion();
    const index = paneKey ? stack.findIndex(item => item.id === paneKey) : -1;
    const covered = index >= 0 && index < stack.length - 1;

    if (!overlay) {
        return null;
    }

    return createPortal(
        <AnimatePresence initial={false}>
            {paneKey ? (
                <MotionScrollable
                    key={paneKey}
                    className={cn(styles.overlay, className)}
                    contentClass={cn(styles.scrollContent, styles.paneContent)}
                    initial={reducedMotion ? false : { opacity: 0, x: SLIDE_IN }}
                    animate={layerRest(covered, reducedMotion)}
                    exit={reducedMotion ? undefined : { opacity: 0, x: SLIDE_IN, pointerEvents: 'none' }}
                    transition={paneTransition(reducedMotion)}
                    inert={covered}
                >
                    <SettingsPaneContext value={paneKey}>{children}</SettingsPaneContext>
                </MotionScrollable>
            ) : null}
        </AnimatePresence>,
        overlay
    );
}

function Shell({
    className,
    action,
    footer,
    children,
}: {
    className?: string;
    action?: ReactNode;
    footer?: ReactNode;
    children: ReactNode;
}) {
    const { selectedId, stack } = useSettingsLayout();
    const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
    const [description, setDescription] = useState<HTMLDivElement | null>(null);
    const reducedMotion = useReducedMotion();
    const covered = stack.length > 0;
    const animate = useMemo(() => layerRest(covered, reducedMotion), [covered, reducedMotion]);

    return (
        <SettingsOverlayContext value={overlay}>
            <SettingsDescriptionContext value={description}>
                <div className={cn(styles.content, className)}>
                    {/* The title, what the section is for, and its action are one block that stays put: only what is below it moves. */}
                    <div className={styles.header}>
                        <div className={styles.headerRow}>
                            <Title />
                            {action}
                        </div>
                        <div ref={setDescription} className={styles.description} />
                    </div>
                    <div ref={setOverlay} className={styles.viewport}>
                        <MotionScrollable
                            key={selectedId}
                            className={styles.scroll}
                            contentClass={styles.scrollContent}
                            animate={animate}
                            transition={paneTransition(reducedMotion)}
                            inert={covered}
                        >
                            {children}
                        </MotionScrollable>
                    </div>
                    {footer}
                </div>
            </SettingsDescriptionContext>
        </SettingsOverlayContext>
    );
}

/**
 * What a section or a nested view is for. It is written where the page keeps its content, and drawn in the header under the title, with the title and the action
 * as one block that does not move when the page changes. Only the top layer's is drawn: the page's while no pane is open over it, and a pane's while that pane is the
 * last of the stack. Outside a `SettingsLayout` it is a plain line where it stands.
 */
function Intro({ className, children }: { className?: string; children: ReactNode }) {
    const layout = use(SettingsLayoutContext);
    const slot = use(SettingsDescriptionContext);
    const pane = use(SettingsPaneContext);
    const text = (
        <Text color="secondary" className={cn(styles.descriptionText, className)}>
            {children}
        </Text>
    );

    if (!layout) {
        return text;
    }

    const top = layout.stack.at(-1)?.id;
    const active = pane === undefined ? layout.stack.length === 0 : pane === top;

    return slot && active ? createPortal(text, slot) : null;
}

function Empty({ children }: { children: ReactNode }) {
    return (
        <Box align="center" justify="center" gap="lg" grow fullWidth fullHeight>
            {children}
        </Box>
    );
}

export interface SettingsLayoutContentProps {
    headerRight?: ReactNode;
    /** Pinned under the scrolling pane. */
    footer?: ReactNode;
    saveable?: boolean;
    className?: string;
    children: ReactNode;
}

function Content({ headerRight, footer, saveable, className, children }: SettingsLayoutContentProps) {
    if (saveable) {
        return (
            <SaveableContent headerRight={headerRight} footer={footer} className={className}>
                {children}
            </SaveableContent>
        );
    }

    return (
        <Shell
            className={className}
            action={headerRight ? <div className={styles.headerAction}>{headerRight}</div> : undefined}
            footer={footer}
        >
            {children}
        </Shell>
    );
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved';

const SAVED_DISPLAY_DURATION = 1000;

const ACTION_COPY = {
    save: {
        dirty: 'Save changes',
        saving: 'Saving…',
        saved: 'Saved',
        tooltip: 'Save changes',
    },
    add: {
        dirty: 'Add',
        saving: 'Adding…',
        saved: 'Added',
        tooltip: 'Add',
    },
} as const satisfies Record<string, SettingsSaveCopy & { tooltip: string }>;

function saveActionCopy(verb: SettingsSaveVerb): SettingsSaveCopy & { tooltip: string } {
    if (typeof verb === 'object') {
        return {
            dirty: verb.dirty,
            saving: verb.saving,
            saved: verb.saved,
            tooltip: verb.tooltip ?? verb.dirty,
        };
    }

    return ACTION_COPY[verb];
}

function saveNoticeLabel(state: SaveState, copy: SettingsSaveCopy): string {
    if (state === 'saving') {
        return copy.saving;
    }

    if (state === 'saved') {
        return copy.saved;
    }

    return 'You have unsaved changes';
}

function SaveNotice({
    state,
    copy,
    onSave,
    onDiscard,
}: {
    state: Exclude<SaveState, 'idle'>;
    copy: SettingsSaveCopy & { tooltip: string };
    onSave: () => void;
    onDiscard: () => void;
}) {
    const label = saveNoticeLabel(state, copy);

    return (
        <div className={styles.saveEnter}>
            <div className={styles.saveClip}>
                <Alert>
                    <AlertIcon>
                        <AttentionCircle />
                    </AlertIcon>
                    <AlertTitle>{label}</AlertTitle>
                    {state === 'saved' ? null : (
                        <AlertAction>
                            <Box direction="row" align="center" gap="sm" wrap={false}>
                                <Button
                                    variant="filling"
                                    color="secondary"
                                    size="sm"
                                    isDisabled={state === 'saving'}
                                    onPress={onDiscard}
                                >
                                    Discard
                                </Button>
                                <Button
                                    color="primary"
                                    size="sm"
                                    isDisabled={state === 'saving'}
                                    tooltip={
                                        state === 'dirty' ? tooltipWithHotkey(copy.tooltip, SAVE_HOTKEY) : undefined
                                    }
                                    onPress={onSave}
                                >
                                    {state === 'saving' ? copy.saving : copy.dirty}
                                </Button>
                            </Box>
                        </AlertAction>
                    )}
                </Alert>
            </div>
        </div>
    );
}

function SaveableContent({ headerRight, footer, className, children }: Omit<SettingsLayoutContentProps, 'saveable'>) {
    const { selectedId } = useSettingsLayout();
    const leaveGuardRef = use(SettingsLeaveGuardContext);
    const modal = use(ModalContext)?.modal;
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [saveVerb, setSaveVerb] = useState<SettingsSaveVerb>('save');
    const saveRef = useRef<(() => Promise<boolean>) | null>(null);
    const discardRef = useRef<(() => void) | null>(null);
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [saveTab, setSaveTab] = useState(selectedId);

    if (saveTab !== selectedId) {
        setSaveTab(selectedId);
        setSaveState('idle');
        setSaveVerb('save');
    }

    const onDirtyChange = useCallback((dirty: boolean) => {
        setSaveState(prev => {
            if (dirty) {
                return 'dirty';
            }

            if (prev === 'dirty') {
                return 'idle';
            }

            return prev;
        });
    }, []);

    const handleSave = useCallback(async () => {
        if (!saveRef.current) {
            return;
        }

        setSaveState('saving');

        try {
            const success = await saveRef.current();

            if (success) {
                setSaveState('saved');
            } else {
                setSaveState('dirty');
            }
        } catch {
            toast.error({ message: 'Something went wrong while saving.' });
            setSaveState('dirty');
        }
    }, []);

    useEffect(() => {
        if (saveState !== 'dirty') {
            return;
        }

        // Window capture so Pane overlays (portaled) still hit ⌘S / Ctrl+S.
        const onKeyDown = (event: KeyboardEvent) => {
            if (!isSaveHotkey(event)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            void handleSave();
        };

        window.addEventListener('keydown', onKeyDown, true);

        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
        };
    }, [handleSave, saveState]);

    useEffect(() => {
        if (saveState === 'saved') {
            savedTimerRef.current = setTimeout(() => {
                setSaveState('idle');
            }, SAVED_DISPLAY_DURATION);
        }

        return () => {
            clearTimeout(savedTimerRef.current);
        };
    }, [saveState]);

    useEffect(() => {
        if (!modal) {
            return;
        }

        if (saveState === 'dirty' || saveState === 'saving') {
            modal.unsaved();

            return;
        }

        modal.saved();
    }, [modal, saveState]);

    useEffect(() => {
        if (!leaveGuardRef) {
            return;
        }

        leaveGuardRef.current = () => {
            if (saveState !== 'dirty' && saveState !== 'saving') {
                return true;
            }

            return confirmDiscardChanges();
        };

        return () => {
            leaveGuardRef.current = null;
        };
    }, [leaveGuardRef, saveState]);

    const ctx = useMemo<SettingsSaveContextValue>(
        () => ({ saveRef, discardRef, onDirtyChange, setSaveVerb }),
        [onDirtyChange]
    );

    const copy = saveActionCopy(saveVerb);

    return (
        <SettingsSaveContext value={ctx}>
            <Shell
                className={className}
                footer={
                    saveState === 'idle' ? (
                        footer
                    ) : (
                        <SaveNotice
                            state={saveState}
                            copy={copy}
                            onSave={() => void handleSave()}
                            onDiscard={() => discardRef.current?.()}
                        />
                    )
                }
                action={headerRight ? <div className={styles.headerAction}>{headerRight}</div> : undefined}
            >
                {children}
            </Shell>
        </SettingsSaveContext>
    );
}

export const SettingsLayout = Object.assign(SettingsLayoutRoot, {
    Sidebar,
    Content,
    Pane,
    Empty,
    Intro,
});

SettingsLayoutRoot.displayName = 'SettingsLayout';
Sidebar.displayName = 'SettingsLayout.Sidebar';
Content.displayName = 'SettingsLayout.Content';
Pane.displayName = 'SettingsLayout.Pane';
Empty.displayName = 'SettingsLayout.Empty';
