import { makeAutoObservable, observableRef } from 'mobx';

/**
 * Columns of ids, each top to bottom. A list is one column; a board is one column per status.
 * Ids are opaque strings, so any list that has stable ids can use the cursor.
 */
export type Grid = readonly (readonly string[])[];

export type Direction = 'up' | 'down' | 'left' | 'right' | 'first' | 'last';

export interface Position {
    column: number;
    row: number;
}

/** The ids in reading order: the first column top to bottom, then the next. This is the order a range runs in. */
export const flatten = (columns: Grid): string[] => columns.flat();

export function locate(columns: Grid, id: string | null): Position | null {
    if (id === null) return null;

    for (let column = 0; column < columns.length; column++) {
        const row = columns[column].indexOf(id);

        if (row >= 0) return { column, row };
    }

    return null;
}

export function sameGrid(a: Grid, b: Grid): boolean {
    return a.length === b.length && a.every((column, index) => column.length === b[index].length && column.every((id, row) => id === b[index][row]));
}

/**
 * Where the cursor goes from `from` in a direction, or `from` itself when it cannot go that way. Never wraps.
 * `up` and `down` stay in the column; `first` and `last` jump to the ends of the current column.
 * `left` and `right` go to the nearest column that has ids, keeping the row index but never past the end of it.
 * Without a usable `from` the cursor lands on the first id, or on the last for `up` and `last`. An empty grid gives null.
 */
export function stepTo(columns: Grid, from: string | null, direction: Direction): string | null {
    const here = locate(columns, from);

    if (!here) {
        const ids = flatten(columns);

        return (direction === 'up' || direction === 'last' ? ids.at(-1) : ids[0]) ?? null;
    }

    const column = columns[here.column];

    switch (direction) {
        case 'up':
            return column[Math.max(here.row - 1, 0)];
        case 'down':
            return column[Math.min(here.row + 1, column.length - 1)];
        case 'first':
            return column[0];
        case 'last':
            return column[column.length - 1];
        case 'left':
        case 'right': {
            const step = direction === 'left' ? -1 : 1;

            for (let index = here.column + step; index >= 0 && index < columns.length; index += step) {
                const target = columns[index];

                if (target.length > 0) return target[Math.min(here.row, target.length - 1)];
            }

            return from;
        }
    }
}

/** The ids from `from` to `to`, both included, in reading order whichever comes first. Empty when either is not in the grid. */
export function rangeBetween(columns: Grid, from: string, to: string): string[] {
    const ids = flatten(columns);
    const start = ids.indexOf(from);
    const end = ids.indexOf(to);

    if (start < 0 || end < 0) return [];

    return ids.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/**
 * Where a cursor goes when its id left the grid: the nearest id of the same column that is still there, the one below on a tie,
 * then the nearest in reading order, then the first id. A cursor that is still in the grid stays where it is.
 */
export function survivingCursor(previous: Grid, next: Grid, cursorId: string | null): string | null {
    if (cursorId === null) return null;

    const remaining = new Set(flatten(next));

    if (remaining.has(cursorId)) return cursorId;

    const here = locate(previous, cursorId);

    if (!here) return flatten(next)[0] ?? null;

    for (const ids of [previous[here.column], flatten(previous)]) {
        const at = ids.indexOf(cursorId);

        for (let distance = 1; distance < ids.length; distance++) {
            const found = [ids[at + distance], ids[at - distance]].find(id => id !== undefined && remaining.has(id));

            if (found !== undefined) return found;
        }
    }

    return flatten(next)[0] ?? null;
}

const keep = (ids: Iterable<string>, grid: Grid): Set<string> => {
    const remaining = new Set(flatten(grid));

    return new Set([...ids].filter(id => remaining.has(id)));
};

/**
 * A cursor, an anchor and a selection over a grid of ids, with the movement keys of a list.
 * The cursor is the item the keyboard is on, the selection is the set it acts on, and neither is the open item.
 * It knows nothing of what the ids stand for, so every section's list can use it.
 */
export class ListCursor {
    columns: Grid = [];
    cursorId: string | null = null;
    /** Where a range starts: the last item toggled, or the cursor when a range began. */
    anchorId: string | null = null;
    selected: ReadonlySet<string> = new Set();
    /** The selection a range grows from, so extending does not drop items picked one by one. Not observed. */
    private base: ReadonlySet<string> | null = null;

    constructor() {
        makeAutoObservable<ListCursor, 'base'>(this, { columns: observableRef, selected: observableRef, base: false });
    }

    /** Every id of the grid, in reading order. */
    get ids(): string[] {
        return flatten(this.columns);
    }

    has(id: string): boolean {
        return locate(this.columns, id) !== null;
    }

    /**
     * Gives the cursor a new grid. A cursor whose id left moves to its nearest surviving neighbour, the selection loses the ids that left,
     * and an anchor that left falls back to the cursor, with what is still selected as the base of the next range.
     * A cursor with nowhere to be starts on `prefer`, else the first id.
     */
    setGrid(columns: Grid, prefer?: string | null): void {
        const previous = this.columns;

        if (!sameGrid(previous, columns)) this.columns = columns.map(column => [...column]);

        const ids = new Set(flatten(columns));

        this.cursorId = survivingCursor(previous, this.columns, this.cursorId);

        if (this.cursorId === null) this.cursorId = prefer != null && ids.has(prefer) ? prefer : (flatten(this.columns)[0] ?? null);

        if ([...this.selected].some(id => !ids.has(id))) this.selected = keep(this.selected, this.columns);

        if (this.base) this.base = keep(this.base, this.columns);

        if (this.anchorId !== null && !ids.has(this.anchorId)) {
            this.anchorId = this.cursorId;
            this.base = this.selected;
        }
    }

    /** Puts the cursor on an id of the grid, as a pointer does. Anything else is ignored. */
    setCursor(id: string): void {
        if (this.has(id)) this.cursorId = id;
    }

    /**
     * Puts the cursor on an id and starts the next range there, as a plain click does. The selection stays as it is.
     * A pointer moves the cursor on its way to a click, so a Shift+click must range from here and not from wherever the cursor was.
     */
    anchorAt(id: string): void {
        if (!this.has(id)) return;

        this.cursorId = id;
        this.anchorId = id;
        this.base = this.selected;
    }

    move(direction: Direction): void {
        const next = stepTo(this.columns, this.cursorId, direction);

        if (next !== null) this.cursorId = next;

        // With nothing selected an old anchor would send the next Shift+arrow to wherever the last toggle was.
        if (this.selected.size === 0) this.resetRange();
    }

    /** Toggles an id (the cursor's by default) in the selection, makes it the cursor and starts the next range there. */
    toggle(id: string | null = this.cursorId): void {
        if (id === null || !this.has(id)) return;

        const next = new Set(this.selected);

        if (!next.delete(id)) next.add(id);

        this.selected = next;
        this.cursorId = id;
        this.anchorId = id;
        this.base = next;
    }

    /** Moves the cursor one step and selects the range from the anchor to it, like Shift+arrow in Linear. */
    extend(direction: 'up' | 'down'): void {
        this.extendTo(stepTo(this.columns, this.cursorId, direction));
    }

    /** Selects the range from the anchor to `id` and puts the cursor there, like Shift+click. Without an anchor the range starts at the cursor. */
    extendTo(id: string | null): void {
        if (id === null || !this.has(id)) return;

        const anchor = this.anchorId ?? this.cursorId ?? id;
        const base = this.anchorId === null ? new Set(this.selected) : (this.base ?? this.selected);

        this.anchorId = anchor;
        this.base = base;
        this.selected = new Set([...base, ...rangeBetween(this.columns, anchor, id)]);
        this.cursorId = id;
    }

    selectAll(): void {
        this.selected = new Set(this.ids);
        this.anchorId = this.cursorId;
        this.base = this.selected;
    }

    clearSelection(): void {
        if (this.selected.size > 0) this.selected = new Set();

        this.resetRange();
    }

    /** What a command acts on: the selection, in reading order, or else the cursor's item, or else nothing. */
    targets(): string[] {
        if (this.selected.size > 0) return this.ids.filter(id => this.selected.has(id));

        return this.cursorId === null ? [] : [this.cursorId];
    }

    private resetRange(): void {
        this.anchorId = null;
        this.base = null;
    }
}
