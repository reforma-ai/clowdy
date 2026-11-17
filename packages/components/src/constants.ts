import { SelectionMode } from 'react-aria-components';

import { Align, Direction, Justify, Spacing, TextColor, TextVariant, Wrap } from './types';

// React Aria
export const SELECTION_MODES: Array<SelectionMode> = ['single', 'multiple', 'none'];

// Layout
export const DIRECTIONS: Direction[] = ['row', 'row-reverse', 'column', 'column-reverse'];
export const ALIGNS: Align[] = ['start', 'center', 'end', 'stretch', 'baseline'];
export const JUSTIFIES: Justify[] = ['start', 'center', 'end', 'between', 'around', 'evenly'];
export const WRAPS: Wrap[] = ['nowrap', 'wrap', 'wrap-reverse'];
export const SPACINGS: Array<Spacing> = ['xxs', 'xs', 'sm', 'md', 'lg', 'xl'];

// Text (typography variants)
export const TEXT_VARIANTS: TextVariant[] = [
    'xl',
    'lg',
    'md',
    'sm',
    'xs',
    'heading-1',
    'heading-2',
    'heading-3',
    'heading-4',
    'heading-5',
    'label',
    'code',
];

/** Semantic colors mapping to --color-*-text tokens; use for text, icons, or any UI that should match. */
export const TEXT_COLORS: TextColor[] = [
    'inherit',
    'default',
    'secondary',
    'primary',
    'accent',
    'danger',
    'warning',
    'success',
];
