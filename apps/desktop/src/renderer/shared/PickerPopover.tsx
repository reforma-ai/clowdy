import { Autocomplete, useAutocompleteEnterAction } from '@clowdy/components/Autocomplete';
import { ListBox, ListBoxHeader, ListBoxItem, ListBoxSection } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Check } from '@clowdy/icons/14';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Collection } from 'react-aria-components';

import styles from './PickerPopover.module.css';

import type { PopoverProps } from '@clowdy/components/Popover';

export interface PickerOption {
    id: string;
    /** What the row says, and what typing filters on. */
    label: string;
    icon?: ReactNode;
    /** Smaller text after the label. It is not searched, so put whatever should be findable in the label. */
    description?: ReactNode;
    /** The description is a line under the label, not after it: for rows that have a name and then a sentence of facts. */
    stacked?: boolean;
    /** A marker at the row's end, before the check of the current option. */
    trailing?: ReactNode;
    /** The row is shown dimmed and is not picked: the arrows pass it by, and Enter and a press leave it. Say why in `description`. */
    isDisabled?: boolean;
    /** The heading of the group the option is under (`Local`, `Remote`): options that name one are listed in groups, in the order the first of each appeared. Options with none are listed as they come. */
    group?: string;
}

export interface PickerListProps {
    options: readonly PickerOption[];
    /** The options that hold the current value; each gets a check. Picking one is still a pick, so a list that toggles can take a link off. */
    selectedIds?: readonly string[];
    /** Names the list for a screen reader. */
    'aria-label': string;
    /** The hint in the search field. */
    placeholder?: string;
    /** The person chose an option that is not disabled. The list does not close anything: its owner does. */
    onPick: (id: string) => void;
}

export interface PickerPopoverProps extends Omit<PickerListProps, 'onPick'> {
    /** The element the popover opens beside. Without one it opens near the top of the window. */
    anchor: Element | null;
    /** Where the popover opens against its anchor; below it, at its start, when the caller does not say (below the window's top when there is no anchor). */
    placement?: PopoverProps['placement'];
    /** The person chose an option. The popover closes right after. */
    onPick: (id: string) => void;
    /** The popover closed: after a pick, `Esc`, or a press outside. The owner stops rendering it. */
    onClose: () => void;
}

/**
 * Whether an element is in a picker's popover. A popover that holds a picker, and shuts when focus or a press goes outside it, says (`shouldCloseOnInteractOutside`) that the picker
 * is not outside: the picker is drawn as its child and sits in another place of the page.
 */
export const isInPickerPopover = (element: Element): boolean => element.closest('[data-picker-popover]') !== null;

/** What a caller says to open a picker: everything but the place it opens and what happens when it closes, which the screen that renders it supplies. */
export type PickerRequest = Omit<PickerPopoverProps, 'anchor' | 'onClose'>;

/** The options as the list draws them: in sections by `group` when any option names one, else one list that has no heading. */
function groupsOf(options: readonly PickerOption[]): Array<{ id: string; title?: string; items: PickerOption[] }> {
    const groups: Array<{ id: string; title?: string; items: PickerOption[] }> = [];

    for (const option of options) {
        const id = option.group ?? '';
        const group = groups.find(candidate => candidate.id === id) ?? (groups[groups.push({ id, title: option.group, items: [] }) - 1] as (typeof groups)[number]);

        group.items.push(option);
    }

    return groups;
}

/** Every word typed has to be in the label, in any order, so `car 12` finds `CAR-12 Fix login`. */
const matches = (label: string, query: string) => query.toLowerCase().split(/\s+/).filter(Boolean).every(word => label.toLowerCase().includes(word));

/**
 * The searchable list of a picker, with no popover of its own, for an owner that draws more around it (a title, a reason, a button). Typing filters, the arrows move, `Enter` picks the
 * highlighted row or else the first that is not disabled, a press picks a row; a disabled row is never picked, whatever reaches the list. The search field takes focus when the list is
 * drawn (inside a popover, a layer of the hotkey dispatcher). It closes nothing and picks as often as it is told to: `PickerPopover` closes after a pick, a caller that keeps its popover
 * open (a switch that may be refused) says what happened itself.
 */
export function PickerList({ options, selectedIds = [], 'aria-label': ariaLabel, placeholder, onPick }: PickerListProps) {
    const [query, setQuery] = useState('');
    const list = useRef<HTMLDivElement>(null);
    const disabled = useMemo(() => new Set(options.filter(option => option.isDisabled).map(option => option.id)), [options]);

    const pick = (id: string) => {
        if (!disabled.has(id)) onPick(id);
    };

    const pickOnEnter = useAutocompleteEnterAction({ onAction: key => pick(String(key)) });

    // The Enter that ends an IME composition (Japanese, Chinese, Korean) confirms the text typed. It is not a pick.
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;

        pickOnEnter(event);
    };

    // The search field focuses itself after 50 ms, and keys typed before that would land on the popover. A picker is opened by a key, so the next one is already on its way.
    useLayoutEffect(() => {
        list.current?.closest('[data-modal-clickout-layer]')?.querySelector('input')?.focus({ preventScroll: true });
    }, []);

    const current = new Set(selectedIds);
    const groups = useMemo(() => groupsOf(options), [options]);

    return (
        <Autocomplete
            inputValue={ query }
            onInputChange={ setQuery }
            filter={ matches }
            maxHeight="16rem"
            placeholder={ placeholder }
            aria-label={ ariaLabel }
            onKeyDown={ onKeyDown }
        >
            <ListBox
                aria-label={ ariaLabel }
                ref={ list }
                size="sm"
                className={ styles.list }
                autoFocus={ false }
                items={ groups }
                onAction={ key => pick(String(key)) }
                renderEmptyState={ () => <div className={ styles.empty }>Nothing found</div> }
            >
                { group => (
                    <ListBoxSection id={ group.id } aria-label={ group.title ?? ariaLabel }>
                        { group.title !== undefined && <ListBoxHeader>{ group.title }</ListBoxHeader> }
                        <Collection items={ group.items }>
                            { option => (
                                <ListBoxItem
                                    id={ option.id }
                                    text={ option.label }
                                    icon={ option.icon }
                                    description={ option.description }
                                    stacked={ option.stacked }
                                    isDisabled={ option.isDisabled }
                                    endAffix={ option.trailing || current.has(option.id)
                                        ? (
                                            <>
                                                { option.trailing }
                                                { current.has(option.id) && <Check className={ styles.current } aria-label="Current" /> }
                                            </>
                                        )
                                        : undefined }
                                />
                            ) }
                        </Collection>
                    </ListBoxSection>
                ) }
            </ListBox>
        </Autocomplete>
    );
}

/**
 * A searchable list that opens beside an element to choose one option, with no trigger of its own: a command opens it, so render it only while it is open.
 * Typing filters, the arrows move, `Enter` picks the highlighted row or else the first, `Esc` closes. Focus goes to the search field and,
 * when the popover closes, back to the element that had it (react-aria's focus scope does that). When that element is gone by then, say a
 * card that moved to another column, nothing has focus and the owner has to put it somewhere.
 * The popover is a modal layer for the hotkey dispatcher (`data-modal-clickout-layer`), so no command of the page behind it runs while it is open.
 */
export function PickerPopover({ anchor, options, selectedIds = [], 'aria-label': ariaLabel, placeholder, placement, onPick, onClose }: PickerPopoverProps) {
    const fallback = useRef<HTMLSpanElement>(null);
    const anchorRef = useMemo(() => (anchor ? { current: anchor } : fallback), [anchor]);
    // A pick can arrive twice, from the key and from the list's own action.
    const picked = useRef(false);

    const pick = (id: string) => {
        if (picked.current) return;

        picked.current = true;
        onPick(id);
        onClose();
    };

    return (
        <>
            { !anchor && <span ref={ fallback } className={ styles.fallbackAnchor } aria-hidden /> }
            <Popover
                triggerRef={ anchorRef }
                isOpen
                onOpenChange={ (isOpen) => {
                    if (!isOpen) onClose();
                } }
                placement={ placement ?? (anchor ? 'bottom start' : 'bottom') }
                className={ styles.popover }
                data-picker-popover=""
            >
                <PickerList options={ options } selectedIds={ selectedIds } aria-label={ ariaLabel } placeholder={ placeholder } onPick={ pick } />
            </Popover>
        </>
    );
}
