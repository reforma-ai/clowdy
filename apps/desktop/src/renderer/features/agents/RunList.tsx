import { Button } from '@clowdy/components/Button';
import { Panel, PanelContent, PanelEmptyState, PanelHeader, PanelSearch } from '@clowdy/components/Panel';
import { Switch } from '@clowdy/components/Switch';
import { useEffect, useRef, type KeyboardEvent } from 'react';

import { useProjectState } from '../../stores';
import styles from './RunList.module.css';
import { RunRow } from './RunRow';

import type { RunId } from '@clowdy/protocol';
import type { TreeRow } from './agentTree';

export interface RunListProps {
    rows: TreeRow[];
    /** Runs there are, before the filters; none means the project has not started any. */
    runCount: number;
    activeChildCounts: ReadonlyMap<RunId, number>;
    selectedId: RunId | null;
    query: string;
    showFinished: boolean;
    onQueryChange: (query: string) => void;
    onShowFinishedChange: (show: boolean) => void;
    onSelect: (runId: RunId) => void;
    onToggle: (runId: RunId) => void;
}

/** The left column: heading with the "Show finished" switch, search, and the run tree. */
export function RunList({ rows, runCount, activeChildCounts, selectedId, query, showFinished, onQueryChange, onShowFinishedChange, onSelect, onToggle }: RunListProps) {
    const project = useProjectState();
    const treeRef = useRef<HTMLDivElement>(null);
    const isSelectedShown = rows.some(row => row.run.id === selectedId);
    // The Tab key enters the tree at the selected row, or at the first one while the selection is out of view.
    const tabStopId = isSelectedShown ? selectedId : rows[0]?.run.id;

    // A run selected from elsewhere may sit below a fold that was just opened for it, so wait until its row exists.
    useEffect(() => {
        if (isSelectedShown) treeRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [selectedId, isSelectedShown]);

    const move = (runId: RunId | undefined) => {
        if (runId === undefined) return;

        onSelect(runId);
        treeRef.current?.querySelector<HTMLElement>(`[data-run-id="${ CSS.escape(runId) }"]`)?.focus();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        // Chevrons and chips inside a row have their own keys.
        const { target } = event;

        if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'treeitem') return;

        const index = rows.findIndex(row => row.run.id === target.dataset.runId);
        const row = rows[index];

        if (!row) return;

        const parentIndex = rows.findLastIndex((candidate, at) => at < index && candidate.depth < row.depth);

        switch (event.key) {
            case 'ArrowDown':
                move(rows[index + 1]?.run.id);
                break;
            case 'ArrowUp':
                move(rows[index - 1]?.run.id);
                break;
            case 'Home':
                move(rows[0].run.id);
                break;
            case 'End':
                move(rows.at(-1)?.run.id);
                break;
            case 'ArrowRight':
                if (row.childCount === 0) return;

                if (row.isExpanded) move(rows[index + 1]?.run.id);
                else onToggle(row.run.id);

                break;
            case 'ArrowLeft':
                if (row.childCount > 0 && row.isExpanded && !query) onToggle(row.run.id);
                else move(rows[parentIndex]?.run.id);

                break;
            case 'Enter':
            case ' ':
                onSelect(row.run.id);
                break;
            default:
                return;
        }

        event.preventDefault();
    };

    return (
        <Panel side="left" className={ styles.list }>
            <PanelHeader>
                <span>Agents</span>
                <PanelHeader.Actions>
                    <Switch size="sm" isSelected={ showFinished } onChange={ onShowFinishedChange }>Show finished</Switch>
                </PanelHeader.Actions>
            </PanelHeader>

            <PanelSearch value={ query } onChange={ onQueryChange } placeholder="Find agent…" aria-label="Find agent" />

            <PanelContent contentClass={ styles.content }>
                { rows.length === 0
                    ? <EmptyList runCount={ runCount } query={ query } showFinished={ showFinished } onShowFinished={ () => onShowFinishedChange(true) } />
                    : (
                        <div ref={ treeRef } role="tree" aria-label="Agents" className={ styles.tree } onKeyDown={ onKeyDown }>
                            { rows.map(row => (
                                <RunRow
                                    key={ row.run.id }
                                    row={ row }
                                    tasks={ project.tasksOfRun(row.run.id) }
                                    activeChildCount={ activeChildCounts.get(row.run.id) ?? 0 }
                                    isSelected={ row.run.id === selectedId }
                                    isTabStop={ row.run.id === tabStopId }
                                    onSelect={ () => onSelect(row.run.id) }
                                    onToggle={ () => onToggle(row.run.id) }
                                />
                            )) }
                        </div>
                    ) }
            </PanelContent>
        </Panel>
    );
}

function EmptyList({ runCount, query, showFinished, onShowFinished }: { runCount: number; query: string; showFinished: boolean; onShowFinished: () => void }) {
    if (runCount === 0) {
        return <PanelEmptyState title="No agents yet" description="Agents show up here when a chat or a task starts work." />;
    }

    if (query.trim()) {
        return (
            <PanelEmptyState
                title="No matches"
                description={ showFinished ? 'No agent matches this search.' : 'No active agent matches this search. Finished runs are hidden.' }
            />
        );
    }

    return (
        <PanelEmptyState
            title="No active agents"
            description="Every run has finished."
            action={ !showFinished && <Button size="sm" variant="bordered" onPress={ onShowFinished }>Show finished</Button> }
        />
    );
}
