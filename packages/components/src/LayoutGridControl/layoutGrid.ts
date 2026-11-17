import type { ReactNode } from 'react';

export const LAYOUT_GRID_CELL_KEYS = [
    'top-left',
    'top-center',
    'top-right',
    'center-left',
    'center',
    'center-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
] as const;

export type LayoutGridCellKey = typeof LAYOUT_GRID_CELL_KEYS[number];
export type LayoutGridCellKind = 'none' | 'spacer';
export type LayoutGridValue = LayoutGridCellKey | string;
export type LayoutGridOverlayKind = 'grid-stretch';

export interface LayoutGridOverlayConfig {
    kind: LayoutGridOverlayKind;
    value?: LayoutGridValue;
}

export type LayoutGridGlyphVariant = 'bars' | 'distribution' | 'stretch-line';
export type LayoutGridGlyphAxis = 'horizontal' | 'vertical';
export type LayoutGridGlyphFlow = 'nowrap' | 'wrap' | 'wrap-reverse';
export type LayoutGridGlyphPlacement = 'left' | 'center' | 'right' | 'top' | 'bottom';
export type LayoutGridGlyphDistribution = 'space-between' | 'space-around' | 'space-evenly';
export type LayoutGridGlyphConnection = 'start' | 'middle' | 'end';
export type LayoutGridGlyphItem
    = | 'line'
      | 'line-start'
      | 'line-center'
      | 'line-end'
      | 'wrap-first-1'
      | 'wrap-first-2'
      | 'wrap-first-3'
      | 'wrap-second-1'
      | 'wrap-second-2'
      | 'marker-inline-start'
      | 'marker-inline-end'
      | 'marker-block-start'
      | 'marker-block-end';

export interface LayoutGridGlyphDescriptor {
    variant: LayoutGridGlyphVariant;
    items: readonly LayoutGridGlyphItem[];
    axis?: LayoutGridGlyphAxis;
    flow?: LayoutGridGlyphFlow;
    placement?: LayoutGridGlyphPlacement;
    distribution?: LayoutGridGlyphDistribution;
    connection?: LayoutGridGlyphConnection;
    isActive?: boolean;
}

export type LayoutGridFlexAlignmentValue = 'start' | 'center' | 'end' | 'stretch' | LayoutGridGlyphDistribution;

export interface LayoutGridFlexAlignmentState {
    x: LayoutGridFlexAlignmentValue | null;
    y: LayoutGridFlexAlignmentValue | null;
}

export interface ResolvedLayoutGridFlexAlignmentState {
    x: LayoutGridFlexAlignmentValue;
    y: LayoutGridFlexAlignmentValue;
}

export interface LayoutGridFlexAlignmentModel {
    cells: LayoutGridCellsInput;
    overlays: readonly LayoutGridOverlayConfig[];
    value: LayoutGridValue | null;
}

export interface LayoutGridCellConfig {
    kind?: LayoutGridCellKind;
    previewKind?: LayoutGridCellKind;
    glyph?: LayoutGridGlyphDescriptor;
    previewGlyph?: LayoutGridGlyphDescriptor;
    value?: LayoutGridValue;
    ariaLabel?: string;
    isDisabled?: boolean;
    tooltip?: ReactNode;
    className?: string;
}

export interface ResolvedLayoutGridCell extends Required<Pick<LayoutGridCellConfig, 'kind'>> {
    key: LayoutGridCellKey;
    row: number;
    column: number;
    previewKind?: LayoutGridCellKind;
    glyph?: LayoutGridGlyphDescriptor;
    previewGlyph?: LayoutGridGlyphDescriptor;
    value?: LayoutGridValue;
    ariaLabel?: string;
    isDisabled?: boolean;
    tooltip?: ReactNode;
    className?: string;
}

export type LayoutGridCellInput = LayoutGridCellKind | LayoutGridCellConfig;
export type LayoutGridCellsInput = Partial<Record<LayoutGridCellKey, LayoutGridCellInput>>;

const CELL_LABELS: Record<LayoutGridCellKey, string> = {
    'top-left': 'Top left',
    'top-center': 'Top center',
    'top-right': 'Top right',
    'center-left': 'Center left',
    center: 'Center',
    'center-right': 'Center right',
    'bottom-left': 'Bottom left',
    'bottom-center': 'Bottom center',
    'bottom-right': 'Bottom right',
};

const BAR_ITEMS = ['line-start', 'line-center', 'line-end'] as const;
const WRAP_BAR_ITEMS = ['wrap-first-1', 'wrap-first-2', 'wrap-first-3', 'wrap-second-1', 'wrap-second-2'] as const;
const STRETCH_LINE_ITEMS = ['line-start', 'line-center', 'line-end'] as const;

export function createLayoutGridAlignmentGlyph({
    axis,
    flow = 'nowrap',
    placement = 'center',
    isActive = false,
}: {
    axis: LayoutGridGlyphAxis;
    flow?: LayoutGridGlyphFlow;
    placement?: LayoutGridGlyphPlacement;
    isActive?: boolean;
}): LayoutGridGlyphDescriptor {
    return {
        variant: 'bars',
        axis,
        flow,
        placement,
        isActive,
        items: flow === 'nowrap' ? BAR_ITEMS : WRAP_BAR_ITEMS,
    };
}

export function createLayoutGridDistributionGlyph({
    axis,
    distribution,
    placement,
    connection,
    isActive = false,
    showMarker = false,
}: {
    axis: LayoutGridGlyphAxis;
    distribution: LayoutGridGlyphDistribution;
    placement: LayoutGridGlyphPlacement;
    connection?: LayoutGridGlyphConnection;
    isActive?: boolean;
    showMarker?: boolean;
}): LayoutGridGlyphDescriptor {
    const marker: LayoutGridGlyphItem[] = (!showMarker || distribution !== 'space-around')
        ? []
        : axis === 'vertical'
            ? placement === 'left'
                ? ['marker-inline-start']
                : placement === 'right'
                    ? ['marker-inline-end']
                    : []
            : placement === 'top'
                ? ['marker-block-start']
                : placement === 'bottom'
                    ? ['marker-block-end']
                    : [];

    return {
        variant: 'distribution',
        axis,
        placement,
        distribution,
        connection,
        isActive,
        items: ['line', ...marker],
    };
}

export function createLayoutGridStretchGlyph({
    axis,
    connection,
    isActive = false,
}: {
    axis: LayoutGridGlyphAxis;
    connection: LayoutGridGlyphConnection;
    isActive?: boolean;
}): LayoutGridGlyphDescriptor {
    return {
        variant: 'stretch-line',
        axis,
        connection,
        isActive,
        items: STRETCH_LINE_ITEMS,
    };
}

const SIMPLE_VALUE_BY_COLUMN = {
    left: 'start',
    center: 'center',
    right: 'end',
} as const satisfies Record<string, LayoutGridFlexAlignmentValue>;

const SIMPLE_VALUE_BY_ROW = {
    top: 'start',
    center: 'center',
    bottom: 'end',
} as const satisfies Record<string, LayoutGridFlexAlignmentValue>;

const COLUMN_BY_SIMPLE_VALUE = {
    start: 'left',
    center: 'center',
    end: 'right',
} as const;

const ROW_BY_SIMPLE_VALUE = {
    start: 'top',
    center: 'center',
    end: 'bottom',
} as const;

export function createLayoutGridFlexAlignmentModel({
    state,
    glyphAxis,
    glyphFlow,
    getCellAriaLabel,
}: {
    state: LayoutGridFlexAlignmentState;
    glyphAxis: LayoutGridGlyphAxis;
    glyphFlow: LayoutGridGlyphFlow;
    getCellAriaLabel?: (state: ResolvedLayoutGridFlexAlignmentState) => string;
}): LayoutGridFlexAlignmentModel {
    const value = getLayoutGridFlexAlignmentValue(state);
    const cells: LayoutGridCellsInput = {};

    for (const key of LAYOUT_GRID_CELL_KEYS) {
        const [row, column] = layoutGridKeyParts(key);
        const cellState = layoutGridCellState(state, row, column);
        const cellValue = getLayoutGridFlexAlignmentValue(cellState) ?? key;
        const isSimple = isLayoutGridFlexSimpleAlignment(cellState.x) && isLayoutGridFlexSimpleAlignment(cellState.y);
        const isActive = cellValue === value;
        const glyph = createLayoutGridFlexAlignmentGlyph(cellState, row, column, glyphAxis, glyphFlow, isActive);

        cells[key] = {
            kind: 'none',
            glyph: (isSimple && !isActive) ? undefined : glyph ?? undefined,
            previewGlyph: (isSimple && !isActive) ? glyph ?? undefined : undefined,
            value: cellValue,
            ariaLabel: getCellAriaLabel?.(cellState),
        };
    }

    return {
        cells,
        overlays: (state.x === 'stretch' && state.y === 'stretch' && value != null)
            ? [{ kind: 'grid-stretch', value }]
            : [],
        value,
    };
}

export function getLayoutGridFlexAlignmentValue({ x, y }: LayoutGridFlexAlignmentState): LayoutGridValue | null {
    if (isLayoutGridFlexSimpleAlignment(x) && isLayoutGridFlexSimpleAlignment(y)) {
        return `${ x }:${ y }`;
    }

    if (x === 'stretch' && isLayoutGridFlexSimpleAlignment(y)) {
        return `x-stretch-y-${ ROW_BY_SIMPLE_VALUE[y] }`;
    }

    if (isLayoutGridFlexSimpleAlignment(x) && y === 'stretch') {
        return `x-${ COLUMN_BY_SIMPLE_VALUE[x] }-y-stretch`;
    }

    if (x === 'stretch' && y === 'stretch') {
        return 'x-stretch-y-stretch';
    }

    if (isLayoutGridFlexDistribution(x)) {
        return `x-${ x }-y-${ y ?? 'stretch' }`;
    }

    if (isLayoutGridFlexDistribution(y)) {
        return `x-${ x ?? 'stretch' }-y-${ y }`;
    }

    return null;
}

export function parseLayoutGridFlexAlignmentValue(value: LayoutGridValue): LayoutGridFlexAlignmentState | null {
    if (typeof value !== 'string') {
        return null;
    }

    const [x, y] = value.split(':');

    if (isLayoutGridFlexSimpleAlignment(x) && isLayoutGridFlexSimpleAlignment(y)) {
        return { x, y };
    }

    const [xToken, yToken] = value.startsWith('x-') ? value.slice(2).split('-y-') : [];
    const parsedX = parseLayoutGridFlexAlignmentToken(xToken);
    const parsedY = parseLayoutGridFlexAlignmentToken(yToken);

    return (parsedX && parsedY) ? { x: parsedX, y: parsedY } : null;
}

export function isLayoutGridFlexSimpleAlignment(
    value: LayoutGridFlexAlignmentValue | null | string
): value is Extract<LayoutGridFlexAlignmentValue, 'start' | 'center' | 'end'> {
    return value === 'start' || value === 'center' || value === 'end';
}

export function getLayoutGridFlexAlignmentForCell(
    key: LayoutGridCellKey
): ResolvedLayoutGridFlexAlignmentState {
    const [row, column] = layoutGridKeyParts(key);

    return layoutGridFlexAlignmentForPosition(row, column);
}

function layoutGridFlexAlignmentForPosition(
    row: keyof typeof SIMPLE_VALUE_BY_ROW,
    column: keyof typeof SIMPLE_VALUE_BY_COLUMN
): ResolvedLayoutGridFlexAlignmentState {
    return {
        x: SIMPLE_VALUE_BY_COLUMN[column],
        y: SIMPLE_VALUE_BY_ROW[row],
    };
}

function layoutGridCellState(
    current: LayoutGridFlexAlignmentState,
    row: keyof typeof SIMPLE_VALUE_BY_ROW,
    column: keyof typeof SIMPLE_VALUE_BY_COLUMN
): ResolvedLayoutGridFlexAlignmentState {
    const cell = layoutGridFlexAlignmentForPosition(row, column);

    return {
        x: (isLayoutGridFlexSimpleAlignment(current.x) || current.x == null)
            ? cell.x
            : current.x,
        y: (isLayoutGridFlexSimpleAlignment(current.y) || current.y == null)
            ? cell.y
            : current.y,
    };
}

function createLayoutGridFlexAlignmentGlyph(
    state: ResolvedLayoutGridFlexAlignmentState,
    row: keyof typeof SIMPLE_VALUE_BY_ROW,
    column: keyof typeof SIMPLE_VALUE_BY_COLUMN,
    glyphAxis: LayoutGridGlyphAxis,
    glyphFlow: LayoutGridGlyphFlow,
    isActive: boolean
): LayoutGridGlyphDescriptor | null {
    if (isLayoutGridFlexSimpleAlignment(state.x) && isLayoutGridFlexSimpleAlignment(state.y)) {
        return createLayoutGridAlignmentGlyph({
            axis: glyphAxis,
            flow: glyphFlow,
            placement: glyphAxis === 'horizontal' ? column : row,
            isActive,
        });
    }

    if (isLayoutGridFlexDistribution(state.x)) {
        return createLayoutGridDistributionGlyph({
            axis: 'vertical',
            distribution: state.x,
            placement: column,
            connection: state.y === 'stretch' ? layoutGridLineConnection(row) : undefined,
            isActive,
            showMarker: isActive && (state.y !== 'stretch' || row === 'center'),
        });
    }

    if (isLayoutGridFlexDistribution(state.y)) {
        return createLayoutGridDistributionGlyph({
            axis: 'horizontal',
            distribution: state.y,
            placement: row,
            connection: state.x === 'stretch' ? layoutGridLineConnection(column) : undefined,
            isActive,
            showMarker: isActive && (state.x !== 'stretch' || column === 'center'),
        });
    }

    if (state.x === 'stretch' && isLayoutGridFlexSimpleAlignment(state.y)) {
        return createLayoutGridStretchGlyph({
            axis: 'horizontal',
            connection: layoutGridLineConnection(column),
            isActive,
        });
    }

    if (isLayoutGridFlexSimpleAlignment(state.x) && state.y === 'stretch') {
        return createLayoutGridStretchGlyph({
            axis: 'vertical',
            connection: layoutGridLineConnection(row),
            isActive,
        });
    }

    return null;
}

function isLayoutGridFlexDistribution(
    value: LayoutGridFlexAlignmentValue | null
): value is LayoutGridGlyphDistribution {
    return value === 'space-between' || value === 'space-around' || value === 'space-evenly';
}

function parseLayoutGridFlexAlignmentToken(value: string | undefined): LayoutGridFlexAlignmentValue | null {
    if (value === 'left' || value === 'top' || value === 'start') {
        return 'start';
    }

    if (value === 'right' || value === 'bottom' || value === 'end') {
        return 'end';
    }

    return (value === 'center'
      || value === 'stretch'
      || value === 'space-between'
      || value === 'space-around'
      || value === 'space-evenly')
        ? value
        : null;
}

function layoutGridKeyParts(
    key: LayoutGridCellKey
): [keyof typeof SIMPLE_VALUE_BY_ROW, keyof typeof SIMPLE_VALUE_BY_COLUMN] {
    if (key === 'center') {
        return ['center', 'center'];
    }

    return key.split('-') as [keyof typeof SIMPLE_VALUE_BY_ROW, keyof typeof SIMPLE_VALUE_BY_COLUMN];
}

function layoutGridLineConnection(position: keyof typeof SIMPLE_VALUE_BY_ROW | keyof typeof SIMPLE_VALUE_BY_COLUMN) {
    if (position === 'top' || position === 'left') {
        return 'start' as const;
    }

    if (position === 'bottom' || position === 'right') {
        return 'end' as const;
    }

    return 'middle' as const;
}

function resolveCellInput(input: LayoutGridCellInput | undefined): LayoutGridCellConfig {
    if (!input) {
        return { kind: 'none' };
    }

    return typeof input === 'string' ? { kind: input } : { ...input, kind: input.kind ?? 'none' };
}

export function normalizeLayoutGridCells(cells: LayoutGridCellsInput = {}): ResolvedLayoutGridCell[] {
    return LAYOUT_GRID_CELL_KEYS.map((key, index) => {
        const input = resolveCellInput(cells[key]);

        return {
            key,
            row: Math.floor(index / 3),
            column: index % 3,
            kind: input.kind ?? 'none',
            previewKind: input.previewKind,
            glyph: input.glyph,
            previewGlyph: input.previewGlyph,
            value: input.value,
            ariaLabel: input.ariaLabel ?? CELL_LABELS[key],
            isDisabled: input.isDisabled,
            tooltip: input.tooltip,
            className: input.className,
        };
    });
}

export function getLayoutGridCellValue(cell: ResolvedLayoutGridCell): LayoutGridValue {
    return cell.value ?? cell.key;
}

export function isLayoutGridCellActionable(cell: ResolvedLayoutGridCell): boolean {
    return !cell.isDisabled && (cell.kind !== 'spacer' || cell.previewKind != null || cell.value != null);
}
