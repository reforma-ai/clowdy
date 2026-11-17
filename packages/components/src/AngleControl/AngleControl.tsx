import { MOTION_EASE_UI } from '@clowdy/constants';
import { cn, mergeRefs } from '@clowdy/lib';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FocusScope, mergeProps, useDialog, useOverlay } from 'react-aria';
import { createPortal } from 'react-dom';

import { Button } from '../Button';
import { useControlledState } from '../hooks';
import { Show } from '../Show';
import { ANGLE_PREVIEW_GEOMETRY, DEFAULT_ANGLE_EXPANDED_SIZE } from './angle';
import styles from './AngleControl.module.css';
import { AngleDial } from './AngleDial';
import { AnglePreview } from './AnglePreview';
import { useAngleState } from './useAngleState';

import type { CSSProperties, HTMLAttributes } from 'react';
import type { AngleControlProps } from './angle';

interface OverlayGeometry {
    left: number;
    top: number;
    scale: number;
}

const OVERLAY_TRANSITION = {
    duration: 0.2,
    ease: MOTION_EASE_UI,
};

function getOverlayGeometry(rect: DOMRect, expandedSize: number): OverlayGeometry {
    return {
        left: rect.right - expandedSize,
        top: rect.top,
        scale: rect.width / expandedSize,
    };
}

/**
 * Compact circular CSS angle control.
 * Opens the full circular picker by morphing the compact control into a floating dial.
 */
export function AngleControl({
    ref,
    value,
    defaultValue,
    onChange,
    onChangeEnd,
    unit,
    presets,
    snap,
    snapThresholdDeg,
    isDisabled,
    isReadOnly,
    min,
    max,
    step,
    precision,
    valueRange,
    presetBehavior,
    size = 'sm',
    expandedSize = DEFAULT_ANGLE_EXPANDED_SIZE,
    showInlineInput = true,
    className,
    popoverClassName,
    style,
    isOpen,
    defaultOpen,
    onOpenChange,
    ariaLabel = 'Angle',
    ariaLabelledBy,
}: AngleControlProps) {
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const [overlayGeometry, setOverlayGeometry] = useState<OverlayGeometry | null>(null);
    const [open, setOpen] = useControlledState(isOpen, defaultOpen ?? false, onOpenChange);
    const prefersReducedMotion = useReducedMotion();
    const overlayId = useId();
    const angle = useAngleState({
        value,
        defaultValue,
        unit,
        min,
        max,
        precision,
        valueRange,
        onChange,
        onChangeEnd,
    });
    const isInactive = isDisabled || isReadOnly;
    const portalTarget = typeof document === 'undefined' ? null : document.body;
    const hasOverlayGeometry = overlayGeometry != null;
    const isOverlayVisible = !isInactive && open && hasOverlayGeometry;
    const overlayScale = overlayGeometry?.scale ?? 1;
    const isValidExpandedSize = Number.isFinite(expandedSize) && expandedSize > 0;
    const resolvedExpandedSize = isValidExpandedSize
        ? expandedSize
        : DEFAULT_ANGLE_EXPANDED_SIZE;
    const previewGeometry = ANGLE_PREVIEW_GEOMETRY[size];
    const triggerStyle = {
        '--clowdy-angle-preview-size': `${ previewGeometry.size }px`,
        ...style,
    } as CSSProperties;

    const updateOverlayGeometry = useCallback((): boolean => {
        const rect = triggerRef.current?.getBoundingClientRect();

        if (!rect) {
            return false;
        }

        setOverlayGeometry(getOverlayGeometry(rect, resolvedExpandedSize));

        return true;
    }, [resolvedExpandedSize]);

    const openOverlay = useCallback(() => {
        if (isInactive || !updateOverlayGeometry()) {
            return;
        }

        setOpen(true);
    }, [isInactive, setOpen, updateOverlayGeometry]);

    const closeOverlay = useCallback(() => setOpen(false), [setOpen]);

    const { overlayProps, underlayProps } = useOverlay({
        isOpen: isOverlayVisible,
        isDismissable: true,
        onClose: closeOverlay,
    }, overlayRef);
    const { dialogProps } = useDialog({
        'aria-label': ariaLabelledBy ? undefined : `${ ariaLabel } picker`,
        'aria-labelledby': ariaLabelledBy,
    }, overlayRef);
    const floatingDialProps = mergeProps(overlayProps, dialogProps) as HTMLAttributes<HTMLDivElement>;

    useEffect(() => {
        if (!open || isInactive) {
            return;
        }

        updateOverlayGeometry();

        window.addEventListener('resize', updateOverlayGeometry);
        window.addEventListener('scroll', updateOverlayGeometry, true);

        return () => {
            window.removeEventListener('resize', updateOverlayGeometry);
            window.removeEventListener('scroll', updateOverlayGeometry, true);
        };
    }, [isInactive, open, updateOverlayGeometry]);

    useEffect(() => {
        if (open && isInactive) {
            closeOverlay();
        }
    }, [closeOverlay, isInactive, open]);

    const shouldMorphOverlay = !prefersReducedMotion && hasOverlayGeometry;
    const motionInitial = shouldMorphOverlay
        ? {
            opacity: 0.92,
            scale: overlayScale,
        }
        : { opacity: 0 };
    const motionExit = shouldMorphOverlay
        ? {
            opacity: 0,
            scale: overlayScale,
        }
        : { opacity: 0 };
    const triggerPressHandler = open ? closeOverlay : openOverlay;

    return (
        <>
            <Button
                ref={ mergeRefs(triggerRef, ref) }
                variant="transparent"
                size="unset"
                iconOnly
                className={ cn(styles.trigger, className) }
                style={ triggerStyle }
                data-readonly={ isReadOnly || undefined }
                data-overlay-open={ isOverlayVisible || undefined }
                isDisabled={ isDisabled }
                aria-label={ ariaLabel }
                aria-labelledby={ ariaLabelledBy }
                aria-disabled={ isReadOnly || undefined }
                aria-haspopup={ isReadOnly ? undefined : 'dialog' }
                aria-expanded={ isReadOnly ? undefined : isOverlayVisible }
                aria-controls={ isOverlayVisible ? overlayId : undefined }
                tabIndex={ isReadOnly ? -1 : undefined }
                onPress={ isReadOnly ? undefined : triggerPressHandler }
            >
                <AnglePreview normalizedDegrees={ angle.normalizedDegrees } size={ size } />
            </Button>

            <Show when={ portalTarget }>
                { target => createPortal(
                    <AnimatePresence
                        initial={ false }
                        onExitComplete={ () => {
                            if (!isOverlayVisible) {
                                setOverlayGeometry(null);
                            }
                        } }
                    >
                        <Show when={ isOverlayVisible ? overlayGeometry : null }>
                            { visibleOverlayGeometry => (
                                <div className={ styles.overlayLayer } data-modal-clickout-layer>
                                    <motion.div
                                        className={ styles.overlay }
                                        initial={ { opacity: 0 } }
                                        animate={ { opacity: 1 } }
                                        exit={ { opacity: 0 } }
                                        transition={ OVERLAY_TRANSITION }
                                        onPointerDown={ underlayProps.onPointerDown }
                                    />

                                    <FocusScope contain restoreFocus>
                                        <motion.div
                                            className={ cn(styles.floatingDial, popoverClassName) }
                                            style={ {
                                                '--clowdy-angle-size': `${ resolvedExpandedSize }px`,
                                                left: visibleOverlayGeometry.left,
                                                top: visibleOverlayGeometry.top,
                                            } as CSSProperties }
                                            initial={ motionInitial }
                                            animate={ { opacity: 1, scale: 1 } }
                                            exit={ motionExit }
                                            transition={ OVERLAY_TRANSITION }
                                        >
                                            <div
                                                { ...floatingDialProps }
                                                ref={ overlayRef }
                                                id={ overlayId }
                                                className={ styles.dialogSurface }
                                            >
                                                <AngleDial
                                                    angle={ angle }
                                                    presets={ presets }
                                                    snap={ snap }
                                                    snapThresholdDeg={ snapThresholdDeg }
                                                    isDisabled={ isDisabled }
                                                    isReadOnly={ isReadOnly }
                                                    step={ step }
                                                    precision={ precision }
                                                    valueRange={ valueRange }
                                                    presetBehavior={ presetBehavior }
                                                    controlSize={ resolvedExpandedSize }
                                                    showInlineInput={ showInlineInput }
                                                    ariaLabel={ ariaLabel }
                                                    ariaLabelledBy={ ariaLabelledBy }
                                                    autoFocus
                                                />
                                            </div>
                                        </motion.div>
                                    </FocusScope>
                                </div>
                            ) }
                        </Show>
                    </AnimatePresence>,
                    target
                ) }
            </Show>
        </>
    );
}

AngleControl.displayName = 'AngleControl';
