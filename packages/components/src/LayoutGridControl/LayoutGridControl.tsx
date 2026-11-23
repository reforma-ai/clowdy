import { cn } from '@clowdy/lib';
import { useMemo, useRef, useState } from 'react';

import { For } from '../For';
import { Tooltip } from '../Tooltip';
import styles from './LayoutGridControl.module.css';
import { getLayoutGridCellValue, isLayoutGridCellActionable, normalizeLayoutGridCells } from './layoutGrid';

import type { FocusEvent, HTMLAttributes, KeyboardEvent, MouseEvent, Ref } from 'react';
import type {
    LayoutGridCellKey,
    LayoutGridCellsInput,
    LayoutGridOverlayConfig,
    LayoutGridValue,
    ResolvedLayoutGridCell,
} from './layoutGrid';

export interface LayoutGridControlProps
    extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'defaultValue' | 'onChange'> {
    ref?: Ref<HTMLDivElement>;
    cells?: LayoutGridCellsInput;
    overlays?: readonly LayoutGridOverlayConfig[];
    value?: LayoutGridValue | null;
    defaultValue?: LayoutGridValue | null;
    onChange?: (value: LayoutGridValue, cell: ResolvedLayoutGridCell) => void;
    onCellPress?: (value: LayoutGridValue, cell: ResolvedLayoutGridCell) => void;
    onCellDoublePress?: (value: LayoutGridValue, cell: ResolvedLayoutGridCell) => void;
    isDisabled?: boolean;
    isReadOnly?: boolean;
    ariaLabel?: string;
    ariaLabelledBy?: string;
}

const EMPTY_OVERLAYS: readonly LayoutGridOverlayConfig[] = [];

function getNextCell(
    cells: readonly ResolvedLayoutGridCell[],
    cell: ResolvedLayoutGridCell,
    rowOffset: number,
    columnOffset: number
): ResolvedLayoutGridCell | null {
    let nextRow = cell.row + rowOffset;
    let nextColumn = cell.column + columnOffset;

    while (nextRow >= 0 && nextRow < 3 && nextColumn >= 0 && nextColumn < 3) {
        const nextCell = cells.find(item => item.row === nextRow && item.column === nextColumn);

        if (nextCell && isLayoutGridCellActionable(nextCell)) {
            return nextCell;
        }

        nextRow += rowOffset;
        nextColumn += columnOffset;
    }

    return null;
}

function getFirstActionableCell(cells: readonly ResolvedLayoutGridCell[]): ResolvedLayoutGridCell | null {
    return cells.find(isLayoutGridCellActionable) ?? null;
}

function getLastActionableCell(cells: readonly ResolvedLayoutGridCell[]): ResolvedLayoutGridCell | null {
    return cells.findLast(isLayoutGridCellActionable) ?? null;
}

function LayoutGridGlyph({ kind, glyph }: Pick<ResolvedLayoutGridCell, 'kind' | 'glyph'>) {
    if (kind === 'spacer') {
        return null;
    }

    const descriptor = glyph;

    if (!descriptor && kind === 'none') {
        return <span className={styles.dot} aria-hidden />;
    }

    if (!descriptor) {
        return null;
    }

    return (
        <span
            className={styles.glyph}
            data-variant={descriptor.variant}
            data-axis={descriptor.axis}
            data-flow={descriptor.flow}
            data-placement={descriptor.placement}
            data-distribution={descriptor.distribution}
            data-connection={descriptor.connection}
            data-active={descriptor.isActive || undefined}
            aria-hidden
        >
            <For each={descriptor.items}>{item => <i key={item} className={styles.glyphItem} data-item={item} />}</For>
        </span>
    );
}

function LayoutGridCellContent({
    cell,
    isPreviewVisible,
}: {
    cell: ResolvedLayoutGridCell;
    isPreviewVisible: boolean;
}) {
    const previewKind = cell.previewKind;
    const previewGlyph = cell.previewGlyph;

    if (!isPreviewVisible || (previewKind == null && previewGlyph == null)) {
        return <LayoutGridGlyph kind={cell.kind} glyph={cell.glyph} />;
    }

    return (
        <>
            <LayoutGridGlyph kind={cell.kind} glyph={cell.glyph} />
            <span className={styles.previewGlyph} aria-hidden>
                <LayoutGridGlyph kind={previewKind ?? 'none'} glyph={previewGlyph} />
            </span>
        </>
    );
}

function LayoutGridOverlay({ overlay, isPreview }: { overlay: LayoutGridOverlayConfig; isPreview: boolean }) {
    return (
        <span
            className={styles.overlay}
            data-kind={overlay.kind}
            data-preview={isPreview || undefined}
            data-value={overlay.value}
            aria-hidden
        >
            <i className={styles.overlayBox} />
        </span>
    );
}

export function LayoutGridControl({
    ref,
    cells,
    overlays = EMPTY_OVERLAYS,
    value,
    defaultValue = null,
    onChange,
    onCellPress,
    onCellDoublePress,
    isDisabled = false,
    isReadOnly = false,
    ariaLabel = 'Layout grid',
    ariaLabelledBy,
    className,
    style,
    onBlur,
    onMouseLeave,
    ...props
}: LayoutGridControlProps) {
    const [uncontrolledValue, setUncontrolledValue] = useState<LayoutGridValue | null>(defaultValue);
    const [hoveredValue, setHoveredValue] = useState<LayoutGridValue | null>(null);
    const buttonRefs = useRef(new Map<LayoutGridCellKey, HTMLButtonElement>());
    const resolvedCells = useMemo(() => normalizeLayoutGridCells(cells), [cells]);
    const overlayValues = useMemo(
        () => new Set(overlays.map(overlay => overlay.value).filter(value => value != null)),
        [overlays]
    );
    const selectedValue = value === undefined ? uncontrolledValue : value;
    const hasPreviewValue = hoveredValue != null && hoveredValue !== selectedValue;
    const previewValue = hasPreviewValue ? hoveredValue : null;
    const isSelectionControl = onChange != null || onCellPress != null || onCellDoublePress != null;
    const isInteractive = isSelectionControl && !isDisabled && !isReadOnly;
    const renderedOverlays = overlays.filter(overlay => {
        if (overlay.value == null) {
            return true;
        }

        return overlay.value === selectedValue || overlay.value === previewValue;
    });

    function focusCell(cell: ResolvedLayoutGridCell | null) {
        if (!cell) {
            return;
        }

        buttonRefs.current.get(cell.key)?.focus();
    }

    function handleCellPress(cell: ResolvedLayoutGridCell) {
        if (!isInteractive || !isLayoutGridCellActionable(cell)) {
            return;
        }

        const nextValue = getLayoutGridCellValue(cell);

        if (value === undefined) {
            setUncontrolledValue(nextValue);
        }

        onChange?.(nextValue, cell);
        onCellPress?.(nextValue, cell);
    }

    function handleCellDoublePress(cell: ResolvedLayoutGridCell) {
        if (!isInteractive || !isLayoutGridCellActionable(cell)) {
            return;
        }

        onCellDoublePress?.(getLayoutGridCellValue(cell), cell);
    }

    function handleRootBlur(event: FocusEvent<HTMLDivElement>) {
        const nextFocusedNode = event.relatedTarget;

        if (!(nextFocusedNode instanceof Node) || !event.currentTarget.contains(nextFocusedNode)) {
            setHoveredValue(null);
        }

        onBlur?.(event);
    }

    function handleRootMouseLeave(event: MouseEvent<HTMLDivElement>) {
        setHoveredValue(null);
        onMouseLeave?.(event);
    }

    function handleCellKeyDown(event: KeyboardEvent<HTMLButtonElement>, cell: ResolvedLayoutGridCell) {
        const keyHandlers: Record<string, () => void> = {
            ArrowUp: () => focusCell(getNextCell(resolvedCells, cell, -1, 0)),
            ArrowRight: () => focusCell(getNextCell(resolvedCells, cell, 0, 1)),
            ArrowDown: () => focusCell(getNextCell(resolvedCells, cell, 1, 0)),
            ArrowLeft: () => focusCell(getNextCell(resolvedCells, cell, 0, -1)),
            Home: () => focusCell(getFirstActionableCell(resolvedCells)),
            End: () => focusCell(getLastActionableCell(resolvedCells)),
        };
        const handler = keyHandlers[event.key];

        if (!handler) {
            return;
        }

        event.preventDefault();
        handler();
    }

    function renderCell(cell: ResolvedLayoutGridCell) {
        const cellClassName = cn(styles.cell, cell.className);
        const isCellDisabled = isDisabled || cell.isDisabled;
        const isSpacer = cell.kind === 'spacer';
        const cellValue = getLayoutGridCellValue(cell);
        const shouldRenderButton = isSelectionControl && isLayoutGridCellActionable(cell);
        const isActionable = isInteractive && isLayoutGridCellActionable(cell);
        const isSelected = selectedValue != null && selectedValue === cellValue;
        const hasPreview =
            (cell.previewKind != null || cell.previewGlyph != null) && (cell.kind === 'none' || isSpacer);
        const hasOverlayPreview = overlayValues.has(cellValue);
        const isPreviewable =
            !isDisabled && !isReadOnly && isLayoutGridCellActionable(cell) && (hasPreview || hasOverlayPreview);
        const isPreviewVisible = previewValue === cellValue;
        const isCellPreviewVisible = hasPreview && isPreviewVisible;
        const isOverlaySelectedVisible = hasOverlayPreview && isSelected;
        const isOverlayPreviewVisible = hasOverlayPreview && isPreviewVisible;
        const content = <LayoutGridCellContent cell={cell} isPreviewVisible={isCellPreviewVisible} />;

        function handleCellMouseEnter() {
            if (isPreviewable) {
                setHoveredValue(cellValue);
            }
        }

        if (!shouldRenderButton) {
            return (
                <span
                    key={cell.key}
                    className={cellClassName}
                    data-cell={cell.key}
                    data-kind={cell.kind}
                    data-value={cell.value}
                    data-readonly={isReadOnly || undefined}
                    data-disabled={isCellDisabled || undefined}
                    data-selected={isSelected || undefined}
                    data-preview={hasPreview || undefined}
                    data-preview-visible={isCellPreviewVisible || undefined}
                    data-overlay-selected-visible={isOverlaySelectedVisible || undefined}
                    data-overlay-preview-visible={isOverlayPreviewVisible || undefined}
                    aria-hidden={isSpacer ? true : undefined}
                    onMouseEnter={isPreviewable ? handleCellMouseEnter : undefined}
                >
                    {content}
                </span>
            );
        }

        const button = (
            <button
                key={cell.key}
                ref={node => {
                    if (node) {
                        buttonRefs.current.set(cell.key, node);
                    } else {
                        buttonRefs.current.delete(cell.key);
                    }
                }}
                type="button"
                className={cellClassName}
                data-cell={cell.key}
                data-kind={cell.kind}
                data-value={cell.value}
                data-disabled={isCellDisabled || undefined}
                data-readonly={isReadOnly || undefined}
                data-selected={isSelected || undefined}
                data-preview={hasPreview || undefined}
                data-preview-visible={isCellPreviewVisible || undefined}
                data-overlay-selected-visible={isOverlaySelectedVisible || undefined}
                data-overlay-preview-visible={isOverlayPreviewVisible || undefined}
                disabled={isCellDisabled || undefined}
                aria-label={cell.ariaLabel}
                aria-pressed={isSelected || undefined}
                aria-disabled={isReadOnly || undefined}
                tabIndex={isReadOnly ? -1 : undefined}
                onFocus={isPreviewable ? () => setHoveredValue(cellValue) : undefined}
                onMouseEnter={isPreviewable ? handleCellMouseEnter : undefined}
                onClick={isActionable ? () => handleCellPress(cell) : undefined}
                onDoubleClick={isActionable && onCellDoublePress ? () => handleCellDoublePress(cell) : undefined}
                onKeyDown={isActionable ? event => handleCellKeyDown(event, cell) : undefined}
            >
                {content}
            </button>
        );

        if (cell.tooltip) {
            return (
                <Tooltip key={cell.key} content={cell.tooltip}>
                    {button}
                </Tooltip>
            );
        }

        return button;
    }

    return (
        <div
            {...props}
            ref={ref}
            className={cn(styles.root, className)}
            style={style}
            role={props.role ?? (isSelectionControl ? 'group' : 'img')}
            aria-label={ariaLabelledBy ? undefined : ariaLabel}
            aria-labelledby={ariaLabelledBy}
            aria-disabled={isDisabled || isReadOnly || undefined}
            data-disabled={isDisabled || undefined}
            data-readonly={isReadOnly || undefined}
            onBlur={handleRootBlur}
            onMouseLeave={handleRootMouseLeave}
        >
            <For each={renderedOverlays}>
                {(overlay, index) => (
                    <LayoutGridOverlay
                        key={`${overlay.kind}-${index}`}
                        overlay={overlay}
                        isPreview={overlay.value != null && overlay.value === previewValue}
                    />
                )}
            </For>
            <For each={resolvedCells}>{cell => renderCell(cell)}</For>
        </div>
    );
}

LayoutGridControl.displayName = 'LayoutGridControl';
