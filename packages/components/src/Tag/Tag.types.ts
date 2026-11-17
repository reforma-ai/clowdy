import { createContext } from 'react';

import type { Key, SelectionMode } from 'react-aria-components';
import type { SemanticColor } from '../types.ts';

export type TagColor = SemanticColor;
export type TagSize = 'xs' | 'sm' | 'md' | 'lg';
export type TagRemovePlacement = 'trailing' | 'leading';

export interface TagContextValue {
    color: TagColor;
    size: TagSize;
    selectionMode: SelectionMode;
    /** Pill shape (`border-radius: full`). */
    rounded?: boolean;
    /** Group-level RAC handler; receives the activated item's key. */
    onAction?: (key: Key) => void;
    /** Where the dismiss control is shown when the tag is removable. */
    removePlacement: TagRemovePlacement;
}

export const TagContext = createContext<TagContextValue | null>(null);
