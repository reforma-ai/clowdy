import { describe, expect, it } from 'vitest';

import {
    createLayoutGridAlignmentGlyph,
    createLayoutGridDistributionGlyph,
    createLayoutGridFlexAlignmentModel,
    createLayoutGridStretchGlyph,
    getLayoutGridCellValue,
    getLayoutGridFlexAlignmentForCell,
    isLayoutGridCellActionable,
    normalizeLayoutGridCells,
} from './layoutGrid';

describe('LayoutGridControl utilities', () => {
    it('normalizes missing cells as inactive nine-cell grid items', () => {
        const cells = normalizeLayoutGridCells({
            'top-left': {
                glyph: createLayoutGridAlignmentGlyph({ axis: 'horizontal', isActive: true }),
            },
        });

        expect(cells).toHaveLength(9);
        expect(cells[0]).toMatchObject({
            key: 'top-left',
            row: 0,
            column: 0,
            kind: 'none',
        });
        expect(cells[8]).toMatchObject({
            key: 'bottom-right',
            row: 2,
            column: 2,
            kind: 'none',
        });
    });

    it('keeps direction and wrapping semantic in alignment glyphs', () => {
        expect(createLayoutGridAlignmentGlyph({
            axis: 'vertical',
            flow: 'wrap',
            placement: 'bottom',
            isActive: true,
        })).toMatchObject({
            variant: 'bars',
            axis: 'vertical',
            flow: 'wrap',
            placement: 'bottom',
            isActive: true,
            items: ['wrap-first-1', 'wrap-first-2', 'wrap-first-3', 'wrap-second-1', 'wrap-second-2'],
        });
    });

    it('keeps distribution and stretch glyphs semantic', () => {
        expect(createLayoutGridDistributionGlyph({
            axis: 'vertical',
            distribution: 'space-around',
            placement: 'left',
            isActive: true,
            showMarker: true,
        })).toMatchObject({
            variant: 'distribution',
            axis: 'vertical',
            placement: 'left',
            distribution: 'space-around',
            items: ['line', 'marker-inline-start'],
        });
        expect(createLayoutGridStretchGlyph({
            axis: 'horizontal',
            connection: 'start',
            isActive: true,
        })).toMatchObject({
            variant: 'stretch-line',
            axis: 'horizontal',
            connection: 'start',
            isActive: true,
            items: ['line-start', 'line-center', 'line-end'],
        });
    });

    it('builds flex alignment cells from one visual state model', () => {
        const model = createLayoutGridFlexAlignmentModel({
            state: { x: 'start', y: 'stretch' },
            glyphAxis: 'horizontal',
            glyphFlow: 'nowrap',
        });

        expect(model.value).toBe('x-left-y-stretch');
        expect(model.cells['top-left']).toMatchObject({
            value: 'x-left-y-stretch',
            glyph: {
                variant: 'stretch-line',
                axis: 'vertical',
                isActive: true,
                items: ['line-start', 'line-center', 'line-end'],
            },
        });
        expect(model.cells['top-center']).toMatchObject({
            glyph: {
                isActive: false,
            },
        });
    });

    it('keeps distribution and double-stretch states in the shared model', () => {
        const distribution = createLayoutGridFlexAlignmentModel({
            state: { x: 'space-around', y: 'end' },
            glyphAxis: 'vertical',
            glyphFlow: 'wrap',
        });
        const stretch = createLayoutGridFlexAlignmentModel({
            state: { x: 'stretch', y: 'stretch' },
            glyphAxis: 'horizontal',
            glyphFlow: 'nowrap',
        });

        expect(distribution.value).toBe('x-space-around-y-end');
        expect(distribution.cells['bottom-left']).toMatchObject({
            glyph: {
                variant: 'distribution',
                axis: 'vertical',
                isActive: true,
            },
        });
        expect(stretch).toMatchObject({
            value: 'x-stretch-y-stretch',
            overlays: [{ kind: 'grid-stretch', value: 'x-stretch-y-stretch' }],
        });
    });

    it('resolves simple alignment from a grid cell', () => {
        expect(getLayoutGridFlexAlignmentForCell('top-right')).toEqual({
            x: 'end',
            y: 'start',
        });
        expect(getLayoutGridFlexAlignmentForCell('center')).toEqual({
            x: 'center',
            y: 'center',
        });
    });

    it('preserves grouped values and preview glyphs', () => {
        const cells = normalizeLayoutGridCells({
            'center-left': {
                kind: 'none',
                previewGlyph: createLayoutGridAlignmentGlyph({ axis: 'horizontal' }),
                value: 'x-left',
            },
        });

        expect(cells[3]).toMatchObject({
            key: 'center-left',
            kind: 'none',
            previewGlyph: {
                variant: 'bars',
                axis: 'horizontal',
                flow: 'nowrap',
            },
            value: 'x-left',
        });
        expect(getLayoutGridCellValue(cells[3])).toBe('x-left');
    });

    it('allows overlay spacer cells to keep the group action target', () => {
        const cells = normalizeLayoutGridCells({
            'top-left': {
                kind: 'spacer',
                value: 'display-grid-x-left-y-stretch',
            },
            'top-center': 'spacer',
        });

        expect(isLayoutGridCellActionable(cells[0])).toBe(true);
        expect(isLayoutGridCellActionable(cells[1])).toBe(false);
    });
});
