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
import { layerRest, paneTransition, SECTION_RISE, SECTION_START_OPACITY, sectionTransition, SLIDE_IN } from '../LayerStack/motion';
import { ListBox, ListBoxItem } from '../List';
import { ModalContext } from '../Modal/hooks/useModalProvider';
import { confirmDiscardChanges } from '../modals/ConfirmModal';
import { Scrollable } from '../Scrollable';
import { Show } from '../Show';
import { Text } from '../Text';
import { toast } from '../Toast';
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
const SettingsLeaveGuardContext = createContext<RefObject<(() => boolean | Promise<boolean>) | null> | null>(null);

function settleLeave(decision: boolean | Promise<boolean>, apply: () => void) {
    if (decision === true) {
        apply();

        return;
    }

    if (decision === false) {
        return;
    }

    void decision.then((allowed) => {
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
    className?: string;
    children: ReactNode;
}

function SettingsLayoutRoot({
    items,
    defaultSelected,
    defaultStack,
    className,
    children,
}: SettingsLayoutProps) {
    const [selectedId, setSelectedId] = useState(defaultSelected ?? items[0]?.id ?? '');
    const [stack, setStack] = useState<SettingsStackItem[]>(() => (
        defaultStack ? [...defaultStack] : []
    ));
    const leaveGuardRef = useRef<(() => boolean | Promise<boolean>) | null>(null);

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

            setStack([]);
        });
    };

    const pop = () => {
        if (stack.length === 0) {
            return;
        }

        settleLeave(leaveGuardRef.current?.() ?? true, () => {
            setStack(current => current.slice(0, -1));
        });
    };

    const reset = () => {
        if (stack.length === 0) {
            return;
        }

        settleLeave(leaveGuardRef.current?.() ?? true, () => {
            setStack([]);
        });
    };

    return (
        <SettingsLeaveGuardContext value={ leaveGuardRef }>
            <SettingsLayoutContext
                value={ {
                    items,
                    selectedId,
                    select,
                    stack,
                    push: item => setStack(current => [...current, item]),
                    rename: (id, label) => setStack(current => current.map(item => (
                        item.id === id && item.label !== label
                            ? { ...item, label }
                            : item
                    ))),
                    pop,
                    reset,
                } }
            >
                <div className={ cn(styles.root, className) }>
                    { children }
                </div>
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

function Sidebar({
    title,
    className,
    'aria-label': ariaLabel = 'Settings sections',
    footer,
}: SettingsLayoutSidebarProps) {
    const { items, selectedId, select } = useSettingsLayout();

    return (
        <div className={ cn(styles.sidebar, className) }>
            <Show when={ title }>
                <Text variant="sm" color="secondary" className={ styles.sidebarTitle }>
                    { title }
                </Text>
            </Show>
            <ListBox
                aria-label={ ariaLabel }
                size="md"
                selectionMode="single"
                selectedKeys={ [selectedId] }
                disallowEmptySelection
            >
                <For each={ items }>
                    { item => (
                        <ListBoxItem
                            key={ item.id }
                            id={ item.id }
                            icon={ item.icon }
                            textValue={ item.label }
                            onPress={ () => select(item.id) }
                        >
                            { item.label }
                        </ListBoxItem>
                    ) }
                </For>
            </ListBox>
            <Show when={ footer }>
                <div className={ styles.sidebarFooter }>{ footer }</div>
            </Show>
        </div>
    );
}

function Title() {
    const { items, selectedId, stack, reset } = useSettingsLayout();
    const rootLabel = items.find(item => item.id === selectedId)?.label ?? '';

    return (
        <Breadcrumb variant="heading-2" className={ styles.title }>
            { stack.length === 0
                ? (
                    <Breadcrumb.Page key="root">
                        { rootLabel }
                    </Breadcrumb.Page>
                )
                : (
                    <Breadcrumb.Link key="root" onPress={ reset }>
                        { rootLabel }
                    </Breadcrumb.Link>
                ) }
            <For each={ stack }>
                { item => (
                    <Breadcrumb.Page key={ item.id }>
                        { item.label }
                    </Breadcrumb.Page>
                ) }
            </For>
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
        <AnimatePresence initial={ false }>
            { paneKey
                ? (
                    <MotionScrollable
                        key={ paneKey }
                        className={ cn(styles.overlay, className) }
                        contentClass={ cn(styles.scrollContent, styles.paneContent) }
                        initial={ reducedMotion ? false : { opacity: 0, x: SLIDE_IN } }
                        animate={ layerRest(covered, reducedMotion) }
                        exit={ reducedMotion ? undefined : { opacity: 0, x: SLIDE_IN, pointerEvents: 'none' } }
                        transition={ paneTransition(reducedMotion) }
                        inert={ covered }
                    >
                        { children }
                    </MotionScrollable>
                )
                : null }
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
    const reducedMotion = useReducedMotion();
    const covered = stack.length > 0;
    const animate = useMemo(
        () => layerRest(covered, reducedMotion),
        [covered, reducedMotion]
    );

    return (
        <SettingsOverlayContext value={ overlay }>
            <div className={ cn(styles.content, className) }>
                <div className={ styles.header }>
                    <Title />
                    { action }
                </div>
                <div ref={ setOverlay } className={ styles.viewport }>
                    <MotionScrollable
                        key={ selectedId }
                        className={ styles.scroll }
                        contentClass={ styles.scrollContent }
                        initial={ reducedMotion ? false : { opacity: SECTION_START_OPACITY, y: SECTION_RISE } }
                        animate={ animate }
                        transition={ covered
                            ? paneTransition(reducedMotion)
                            : sectionTransition(reducedMotion) }
                        inert={ covered }
                    >
                        { children }
                    </MotionScrollable>
                </div>
                { footer }
            </div>
        </SettingsOverlayContext>
    );
}

function Empty({ children }: { children: ReactNode }) {
    return (
        <Box align="center" justify="center" gap="lg" grow fullWidth fullHeight>
            { children }
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
            <SaveableContent headerRight={ headerRight } footer={ footer } className={ className }>
                { children }
            </SaveableContent>
        );
    }

    return (
        <Shell className={ className } action={ headerRight } footer={ footer }>
            { children }
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
        <div className={ styles.saveEnter }>
            <div className={ styles.saveClip }>
                <Alert>
                    <AlertIcon>
                        <AttentionCircle />
                    </AlertIcon>
                    <AlertTitle>{ label }</AlertTitle>
                    { state === 'saved'
                        ? null
                        : (
                            <AlertAction>
                                <Box direction="row" align="center" gap="sm" wrap={ false }>
                                    <Button
                                        variant="filling"
                                        color="secondary"
                                        size="sm"
                                        isDisabled={ state === 'saving' }
                                        onPress={ onDiscard }
                                    >
                                        Discard
                                    </Button>
                                    <Button
                                        color="primary"
                                        size="sm"
                                        isDisabled={ state === 'saving' }
                                        tooltip={ state === 'dirty'
                                            ? tooltipWithHotkey(copy.tooltip, SAVE_HOTKEY)
                                            : undefined }
                                        onPress={ onSave }
                                    >
                                        { state === 'saving' ? copy.saving : copy.dirty }
                                    </Button>
                                </Box>
                            </AlertAction>
                        ) }
                </Alert>
            </div>
        </div>
    );
}

function SaveableContent({
    headerRight,
    footer,
    className,
    children,
}: Omit<SettingsLayoutContentProps, 'saveable'>) {
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
        setSaveState((prev) => {
            if (dirty) {
                return 'dirty';
            }

            if (prev === 'dirty') {
                return 'idle';
            }

            return prev;
        });
    }, []);

    const handleSave = useCallback(async() => {
        if (!saveRef.current) {
            return;
        }

        setSaveState('saving');

        try {
            const success = await saveRef.current();

            if (success) {
                setSaveState('saved');
            }
            else {
                setSaveState('dirty');
            }
        }
        catch {
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
        <SettingsSaveContext value={ ctx }>
            <Shell
                className={ className }
                footer={ saveState === 'idle'
                    ? footer
                    : (
                        <SaveNotice
                            state={ saveState }
                            copy={ copy }
                            onSave={ () => void handleSave() }
                            onDiscard={ () => discardRef.current?.() }
                        />
                    ) }
                action={ headerRight
                    ? <div className={ styles.headerAction }>{ headerRight }</div>
                    : undefined }
            >
                { children }
            </Shell>
        </SettingsSaveContext>
    );
}

export const SettingsLayout = Object.assign(SettingsLayoutRoot, {
    Sidebar,
    Content,
    Pane,
    Empty,
});

SettingsLayoutRoot.displayName = 'SettingsLayout';
Sidebar.displayName = 'SettingsLayout.Sidebar';
Content.displayName = 'SettingsLayout.Content';
Pane.displayName = 'SettingsLayout.Pane';
Empty.displayName = 'SettingsLayout.Empty';
