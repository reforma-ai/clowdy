import { SearchInput } from '@clowdy/components/Input';
import { ListBoxItem } from '@clowdy/components/List';
import { PanelHeader } from '@clowdy/components/Panel';
import { Select } from '@clowdy/components/Select';
import { Text } from '@clowdy/components/Text';
import { Collapse } from '@clowdy/icons/14';

import { scopeOptions } from './changeScopes';
import styles from './ChangesToolbar.module.css';
import { summaryOf } from './summary';

import type { GitScope } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { PlaceChanges } from './PlaceChanges';

/** The placeholder of the filter field, which teaches its syntax by showing it. */
export const FILTER_PLACEHOLDER = 'Filter files, e.g. *.md, docs/**, !*.test.ts';

/** The line under the filter: how many files and lines the list has (of the ones the filter shows), and what to know about it. */
function Summary({ model }: { model: PlaceChanges }) {
    const { changes } = model;

    // A list with no file has the empty state to say so, which says why; totals of nothing would only repeat it.
    if (!changes || changes.fileCount === 0) return null;

    const summary = summaryOf(changes, model.files);

    return (
        <div className={ styles.summary } role="status" aria-label="Summary of the changes">
            <span className={ styles.totals } title={ summary.incomplete ? 'Some files weren\'t counted' : undefined }>
                <Text variant="xs" color="secondary">{ `${ summary.files },` }</Text>
                <Text variant="xs" color="success">{ summary.additions }</Text>
                <Text variant="xs" color="danger">{ summary.deletions }</Text>
            </span>
            { summary.notes.map(note => <Text key={ note } variant="xs" color="secondary" truncate className={ styles.note }>{ note }</Text>) }
        </div>
    );
}

/**
 * The bars over the cards: the scope menu with the buttons that fold every card and open every card, and, where the sidebar's button goes when the sidebar is hidden (`end`, the
 * same place as the one in the sidebar's own header, so it does not move), then the filter and the summary of the list. The scope menu has all changes, the branch against its base
 * while there is a base, what is not committed, and one entry for each commit of the branch, newest first.
 */
export function ChangesToolbar({ model, end }: { model: PlaceChanges; end?: ReactNode }) {
    const options = scopeOptions(model.base).map(option => ({ ...option, id: option.scope }));
    const hasFiles = model.files.length > 0;

    return (
        <>
            <PanelHeader>
                <Select
                    aria-label="Changes to show"
                    size="sm"
                    variant="transparent"
                    valueDisplay="text"
                    className={ styles.scope }
                    triggerClassName={ styles.scopeTrigger }
                    popoverClassName={ styles.scopeList }
                    items={ options }
                    selectedKey={ model.effectiveScope }
                    onSelectionChange={ (key: unknown) => typeof key === 'string' && model.setScope(key as GitScope) }
                >
                    { item => <ListBoxItem id={ item.id } text={ item.label } /> }
                </Select>
                <PanelHeader.Actions>
                    <PanelHeader.Button aria-label="Collapse all files" tooltip="Collapse all" tooltipPlacement="bottom" isDisabled={ !hasFiles || model.allFolded } onPress={ () => model.foldAll() }>
                        <Collapse />
                    </PanelHeader.Button>
                    <PanelHeader.Button aria-label="Expand all files" tooltip="Expand all" tooltipPlacement="bottom" isDisabled={ !hasFiles || model.noneFolded } onPress={ () => model.unfoldAll() }>
                        <Collapse className={ styles.flipped } />
                    </PanelHeader.Button>
                    { end }
                </PanelHeader.Actions>
            </PanelHeader>
            <div className={ styles.filter }>
                <SearchInput
                    size="sm"
                    variant="filled"
                    className={ styles.input }
                    placeholder={ FILTER_PLACEHOLDER }
                    aria-label="Filter files"
                    value={ model.filter }
                    onChange={ (value: string) => model.setFilter(value) }
                />
            </div>
            <Summary model={ model } />
        </>
    );
}
