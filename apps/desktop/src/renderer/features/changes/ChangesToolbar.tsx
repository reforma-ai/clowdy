import { SearchInput } from '@clowdy/components/Input';
import { ListBoxItem } from '@clowdy/components/List';
import { PanelHeader } from '@clowdy/components/Panel';
import { Select } from '@clowdy/components/Select';
import { Text } from '@clowdy/components/Text';
import { CollapseAll, ExpandAll, EyeOff } from '@clowdy/icons/14';
import { observer } from 'mobx-react-lite';

import styles from './ChangesToolbar.module.css';
import viewStyles from './ChangesView.module.css';
import { isRunScope, LAST_RUN_TOOLTIP, scopeOptions } from './changeScopes';
import { summaryOf } from './summary';
import { VIEWED_TEXT } from './viewedMarks';

import type { GitScope } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { PlaceChanges } from './PlaceChanges';

/** The placeholder of the filter field, which teaches its syntax by showing it. */
export const FILTER_PLACEHOLDER = 'Filter files, e.g. *.md, docs/**, !*.test.ts';

/** The line under the filter: how many files and lines the list has (of the ones the filter shows), and what to know about it. */
const Summary = observer(function Summary({ model }: { model: PlaceChanges }) {
    const { changes } = model;

    // A list with no file has the empty state to say so, which says why; totals of nothing would only repeat it.
    if (!changes || changes.fileCount === 0) return null;

    const summary = summaryOf(changes, model.matchingFiles, model.viewedCount);
    const refused = model.viewed.error;

    return (
        <div className={styles.summary} role="status" aria-label="Summary of the changes">
            <Text variant="xs" color="secondary" className={styles.fileCount}>
                {summary.files}
                {summary.viewed && `, ${summary.viewed}`}
            </Text>
            {summary.notes.map(note => (
                <Text key={note} variant="xs" color="secondary" truncate className={styles.note}>
                    {note}
                </Text>
            ))}
            {refused !== undefined && (
                <Text variant="xs" color="secondary" truncate className={styles.note} title={refused}>
                    {VIEWED_TEXT.notSaved}
                </Text>
            )}
            <span className={styles.totals} title={summary.incomplete ? "Some files weren't counted" : undefined}>
                <Text variant="xs" color="success">
                    {summary.additions}
                </Text>
                <Text variant="xs" color="danger">
                    {summary.deletions}
                </Text>
            </span>
        </div>
    );
});

/**
 * The bars over the cards: the scope menu, a button that folds all shown cards or opens them when all are folded, the Hide viewed toggle, and, where the sidebar's button goes when the sidebar is hidden (`end`, the
 * same place as the one in the sidebar's own header, so it does not move), then the filter and the summary of the list. The scope menu has all changes, the branch against its base
 * while there is a base, what is not committed, the open chat's last run while it has one, and one entry for each commit of the branch, newest first.
 */
export function ChangesToolbar({ model, end }: { model: PlaceChanges; end?: ReactNode }) {
    const options = scopeOptions(model.base, model.runScope).map(option => ({ ...option, id: option.scope }));
    const allFolded = model.allFolded;
    const foldAction = allFolded ? 'Expand all' : 'Collapse all';

    return (
        <>
            <PanelHeader className={viewStyles.pickerHeader}>
                {/* The tooltip of the run's scope is the wrapper's, which has no box of its own: the button keeps the place it had. */}
                <span className={styles.titled} title={isRunScope(model.effectiveScope) ? LAST_RUN_TOOLTIP : undefined}>
                    <Select
                        aria-label="Changes to show"
                        size="sm"
                        variant="filling"
                        valueDisplay="text"
                        className={styles.scope}
                        triggerClassName={styles.scopeTrigger}
                        popoverClassName={styles.scopeList}
                        items={options}
                        selectedKey={model.effectiveScope}
                        onSelectionChange={(key: unknown) => typeof key === 'string' && model.setScope(key as GitScope)}
                    >
                        {item => (
                            <ListBoxItem
                                id={item.id}
                                text={item.label}
                                description={item.note}
                                stacked={item.note !== undefined}
                            />
                        )}
                    </Select>
                </span>
                <PanelHeader.Actions>
                    <PanelHeader.Button
                        aria-label={`${foldAction} files`}
                        tooltip={foldAction}
                        tooltipPlacement="bottom"
                        isDisabled={model.files.length === 0}
                        onPress={() => (allFolded ? model.unfoldAll() : model.foldAll())}
                    >
                        {allFolded ? <ExpandAll /> : <CollapseAll />}
                    </PanelHeader.Button>
                    <PanelHeader.Button
                        aria-label="Hide viewed"
                        tooltip="Hide viewed"
                        tooltipPlacement="bottom"
                        isPressed={model.hideViewed}
                        onPress={() => model.setHideViewed(!model.hideViewed)}
                    >
                        <EyeOff />
                    </PanelHeader.Button>
                    {end}
                </PanelHeader.Actions>
            </PanelHeader>
            <div className={styles.filter}>
                <SearchInput
                    size="sm"
                    variant="filled"
                    className={styles.input}
                    placeholder={FILTER_PLACEHOLDER}
                    aria-label="Filter files"
                    value={model.filter}
                    onChange={(value: string) => model.setFilter(value)}
                />
            </div>
            <Summary model={model} />
        </>
    );
}
