import { cn } from '@clowdy/lib';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import {
    Group,
    Panel,
    Separator,
    useDefaultLayout,
    useGroupRef,
    usePanelRef,
    type GroupImperativeHandle,
    type Layout,
    type LayoutStorage,
    type PanelImperativeHandle,
} from 'react-resizable-panels';

import { useMergedRef } from '../hooks/useMergedRef';
import { Show } from '../Show';
import styles from './Resizable.module.css';

export type ResizablePanelGroupProps = ComponentProps<typeof Group>;
export type ResizablePanelState = {
    inPixels: number;
    asPercentage: number;
    isCollapsed: boolean;
};

export type ResizablePanelProps = Omit<ComponentProps<typeof Panel>, 'children'> & {
    children?: ReactNode | ((state: ResizablePanelState) => ReactNode);
};

export type ResizableHandleProps = ComponentProps<typeof Separator>;

const defaultPanelState: ResizablePanelState = {
    inPixels: 0,
    asPercentage: 0,
    isCollapsed: false,
};

type ResizableGroupContextValue = {
    disabled: boolean;
    dragging: boolean;
    setDragging: (value: boolean) => void;
};

const ResizableGroupContext = createContext<ResizableGroupContextValue>({
    disabled: false,
    dragging: false,
    setDragging: () => {},
});

function ResizablePanelGroup({
    className,
    disabled = false,
    ...props
}: ResizablePanelGroupProps) {
    const [dragging, setDragging] = useState(false);
    const value = useMemo(
        () => ({
            disabled,
            dragging,
            setDragging,
        }),
        [disabled, dragging]
    );

    return (
        <ResizableGroupContext value={ value }>
            <Group
                data-slot="resizable-panel-group"
                className={ cn(styles.panelGroup, className) }
                data-dragging={ dragging || undefined }
                disabled={ disabled }
                { ...props }
            />
        </ResizableGroupContext>
    );
}

function ResizablePanel({
    children,
    onResize,
    panelRef: panelRefProp,
    ...props
}: ResizablePanelProps) {
    const [state, setState] = useState<ResizablePanelState>(defaultPanelState);
    const internalRef = useRef<PanelImperativeHandle | null>(null);
    const panelRef = useMergedRef(internalRef, panelRefProp);

    const handleResize = useCallback(
        (panelSize: { inPixels: number; asPercentage: number }, id: string | number | undefined, prevPanelSize: { inPixels: number; asPercentage: number } | undefined) => {
            setState({
                inPixels: panelSize.inPixels,
                asPercentage: panelSize.asPercentage,
                isCollapsed: internalRef.current!.isCollapsed(),
            });

            onResize?.(panelSize, id, prevPanelSize);
        },
        [onResize]
    );

    const content = useMemo(
        (): ReactNode => (typeof children === 'function') ? children(state) : children,
        [children, state]
    );

    return (
        <Panel
            data-slot="resizable-panel"
            panelRef={ panelRef }
            data-collapsed={ state.isCollapsed || undefined }
            onResize={ handleResize }
            { ...props }
        >
            { content }
        </Panel>
    );
}

function ResizableHandle({
    className,
    onPointerDown,
    onPointerUp,
    onPointerCancel,
    ...props
}: ResizableHandleProps) {
    const { disabled, dragging, setDragging } = use(ResizableGroupContext);

    const handlePointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            setDragging(true);
            document.body.dataset.resizableDragging = 'true';
            onPointerDown?.(e);
        },
        [onPointerDown, setDragging]
    );

    const handlePointerUp = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            setDragging(false);
            delete document.body.dataset.resizableDragging;
            onPointerUp?.(e);
        },
        [onPointerUp, setDragging]
    );

    const handlePointerCancel = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            setDragging(false);
            delete document.body.dataset.resizableDragging;
            onPointerCancel?.(e);
        },
        [onPointerCancel, setDragging]
    );

    useEffect(() => {
        if (!dragging) {
            return;
        }

        const stopDragging = () => {
            setDragging(false);

            if (typeof document !== 'undefined') {
                delete document.body.dataset.resizableDragging;
            }
        };

        window.addEventListener('pointerup', stopDragging);
        window.addEventListener('pointercancel', stopDragging);
        window.addEventListener('blur', stopDragging);

        return () => {
            window.removeEventListener('pointerup', stopDragging);
            window.removeEventListener('pointercancel', stopDragging);
            window.removeEventListener('blur', stopDragging);
        };
    }, [dragging, setDragging]);

    return (
        <Show when={ !disabled }>
            <Separator
                data-slot="resizable-handle"
                className={ cn(styles.handle, className) }
                onPointerDown={ handlePointerDown }
                onPointerUp={ handlePointerUp }
                onPointerCancel={ handlePointerCancel }
                { ...props }
            />
        </Show>
    );
}

ResizablePanelGroup.displayName = 'ResizablePanelGroup';
ResizablePanel.displayName = 'ResizablePanel';
ResizableHandle.displayName = 'ResizableHandle';

export {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
    useDefaultLayout,
    useGroupRef,
    usePanelRef,
    type GroupImperativeHandle,
    type Layout,
    type LayoutStorage,
};
