import { FileIcon } from '@clowdy/components/FileIcon';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';
import { basename, dirname } from '@clowdy/file-manager/paths';
import { Folder, Search } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { observer } from 'mobx-react-lite';
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';

import { Marked, visiblePreview, wordRanges } from './preview';
import styles from './QuickSearch.module.css';
import { QUICK_SEARCH_TABS, type Found, type QuickSearchModel, type QuickSearchTab } from './QuickSearchModel';

export interface QuickSearchProps {
    model: QuickSearchModel;
    /** The name of the folder that is searched, when the project has more than one: which of them it is is not clear from the project's name. */
    folder?: string;
}

const PLACEHOLDERS: Record<QuickSearchTab, string> = {
    all: 'Search files and the text in them',
    files: 'Search files by name',
    text: 'Search the text in files',
};

const HINTS: Record<QuickSearchTab, string> = {
    all: 'Find a file by its name, or a line by its words',
    files: 'Type the name of a file, or a part of its path',
    text: 'Type the words to find in your files',
};

const EMPTY: Record<QuickSearchTab, string> = {
    all: 'Nothing found',
    files: 'No files found',
    text: 'No matches',
};

/** The id of the row at `index`, for the field to name the row the keys are on. */
const rowId = (list: string, index: number) => `${ list }-${ index }`;

function Row({ id, found, query, active, onOpen, onHover }: { id: string; found: Found; query: string; active: boolean; onOpen: () => void; onHover: () => void }) {
    const folder = dirname(found.path);
    const name = basename(found.path);
    const line = found.kind === 'line' ? found : null;
    const preview = line ? visiblePreview(line) : null;

    return (
        <div
            id={ id }
            role="option"
            aria-selected={ active }
            data-active={ active || undefined }
            className={ styles.row }
            onClick={ onOpen }
            onMouseMove={ onHover }
        >
            <FileIcon path={ found.path } kind="file" className={ styles.icon } />
            { line && preview
                ? (
                    <>
                        <span className={ cn(styles.main, styles.code) }><Marked text={ preview.text } ranges={ preview.ranges } /></span>
                        <Text truncate variant="xs" color="secondary" className={ styles.meta }>{ `${ name }:${ line.line }` }</Text>
                    </>
                )
                : (
                    <>
                        <span className={ styles.main }><Marked text={ name } ranges={ wordRanges(name, query) } /></span>
                        { folder && <Text truncate variant="xs" color="secondary" className={ styles.meta }>{ folder }</Text> }
                    </>
                ) }
        </div>
    );
}

/**
 * The palette: a field, the rows found below it (files by their names, and the lines of files that have what was typed), and the tabs that say which of the two to
 * search. The focus stays in the field and the arrows move the row the keys are on (`aria-activedescendant`); Enter opens it, Tab changes the tab, Escape or `Cmd+K` closes.
 */
export const QuickSearch = observer(function QuickSearch({ model, folder }: QuickSearchProps) {
    const { modal } = useModalContext();
    const field = useRef<HTMLInputElement>(null);
    const list = useId();
    const { tab, query, sections, rows, active, pending, error, answered, blank } = model;
    const activeIndex = active ? rows.indexOf(active) : -1;

    // After a tab was pressed with the pointer, the keys are still the field's.
    useEffect(() => field.current?.focus(), [tab]);

    // The row the keys moved to comes into view.
    useEffect(() => {
        if (activeIndex >= 0) document.getElementById(rowId(list, activeIndex))?.scrollIntoView({ block: 'nearest' });
    }, [list, activeIndex, active?.id]);

    const open = (found?: Found) => {
        if (model.open(found)) modal.cancel();
    };

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.nativeEvent.isComposing) return;

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            model.move(event.key === 'ArrowDown' ? 1 : -1);
        }
        else if (event.key === 'Enter') {
            event.preventDefault();
            open();
        }
        else if (event.key === 'Tab') {
            event.preventDefault();
            model.stepTab(event.shiftKey ? -1 : 1);
        }
        else if (event.code === 'KeyK' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
            event.preventDefault();
            modal.cancel();
        }
    };

    let at = 0;

    return (
        <div className={ styles.palette } onKeyDown={ onKeyDown }>
            <div className={ styles.field }>
                <Search aria-hidden className={ styles.lens } />
                <input
                    ref={ field }
                    autoFocus
                    role="combobox"
                    aria-expanded={ rows.length > 0 }
                    aria-controls={ list }
                    aria-activedescendant={ activeIndex >= 0 ? rowId(list, activeIndex) : undefined }
                    aria-label="Search"
                    className={ styles.input }
                    placeholder={ PLACEHOLDERS[tab] }
                    spellCheck={ false }
                    autoComplete="off"
                    value={ query }
                    onChange={ event => model.setQuery(event.target.value) }
                />
                { pending && <Spinner size="sm" aria-label="Searching" className={ styles.spinner } /> }
            </div>

            <Scrollable className={ styles.results } contentClass={ styles.content }>
                <div id={ list } role="listbox" aria-label="Results" className={ styles.list }>
                    { sections.map(section => (
                        <div key={ section.id } role="group" aria-label={ section.title } className={ styles.section }>
                            { tab === 'all' && <Text variant="sm" color="secondary" className={ styles.title }>{ section.title }</Text> }
                            { section.items.map((found) => {
                                const index = at++;

                                return <Row key={ found.id } id={ rowId(list, index) } found={ found } query={ query } active={ index === activeIndex } onOpen={ () => open(found) } onHover={ () => model.activate(found) } />;
                            }) }
                        </div>
                    )) }
                </div>

                { rows.length === 0 && (
                    <Text color="secondary" className={ styles.note } role={ error ? 'alert' : 'status' }>
                        { blank ? HINTS[tab] : error ? `Couldn't search: ${ error }` : answered && !pending ? EMPTY[tab] : '' }
                    </Text>
                ) }
            </Scrollable>

            <div className={ styles.footer }>
                <ToggleButtonGroup
                    size="sm"
                    variant="text"
                    aria-label="What to search"
                    selectedKeys={ tab }
                    onSelectionChange={ (keys) => {
                        const next = [...keys][0] as QuickSearchTab | undefined;

                        if (next) model.setTab(next);
                    } }
                >
                    { QUICK_SEARCH_TABS.map(({ value, label }) => <ToggleButtonGroupItem key={ value } value={ value }>{ label }</ToggleButtonGroupItem>) }
                </ToggleButtonGroup>

                { folder && (
                    <Text variant="sm" color="secondary" className={ styles.folder } title="The folder that is searched">
                        <Folder aria-hidden />
                        <span>{ folder }</span>
                    </Text>
                ) }
            </div>
        </div>
    );
});

/** The palette's window: up near the top of the window, as wide as its rows need, and as tall for an empty list as for a full one, so it does not move as results come. */
export function showQuickSearch(props: QuickSearchProps, { onClose }: { onClose: () => void }) {
    return Modal.create({
        id: 'quick-search',
        // Gone as soon as it is closed by any way, not when its leaving has finished: a key pressed at once opens a new one.
        onCancel: onClose,
        onClose,
        width: 680,
        padding: 0,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: false,
        handle: false,
        scrollable: 'hidden',
        position: ['center', 'start'],
        positionOffset: { y: 96 },
        component: <QuickSearch { ...props } />,
    });
}
