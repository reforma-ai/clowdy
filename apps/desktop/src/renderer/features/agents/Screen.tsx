import { Text } from '@clowdy/components/Text';
import { useEffect, useRef, useState } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { ancestorIds, countActiveChildren, filterTree, flattenTree, reconcileSelection, runMatches, settleSelection, treeOrder } from './agentTree';
import { RunDetail } from './RunDetail';
import { RunList } from './RunList';
import styles from './Screen.module.css';

import type { RunId } from '@clowdy/protocol';

/** Agents: the tree of runs on the left, the selected run's stream on the right. */
export function Screen() {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [query, setQuery] = useState('');
    const [collapsed, setCollapsed] = useState<ReadonlySet<RunId>>(new Set());
    const seenRunId = useRef<RunId | null | undefined>(undefined);

    // The selection must be a run the tree shows. The filters of the tree (search, folds) do not count: searching
    // does not move the selection. The effect below makes the store agree.
    const selectedId = settleSelection(ui.runId, treeOrder(project.runTree(true)), treeOrder(project.runTree(ui.showFinished)));
    const selectedRun = selectedId === null ? undefined : project.runs.get(selectedId);

    useEffect(() => {
        const arrived = seenRunId.current !== ui.runId;

        seenRunId.current = ui.runId;

        // Read from the store, not from this render: a second run of the effect (strict mode) must see the first one's changes.
        const step = reconcileSelection(ui.runId, arrived, treeOrder(project.runTree(true)), treeOrder(project.runTree(ui.showFinished)));

        if (step.kind === 'show-finished') ui.setShowFinished(true);
        // The screen picking a run for the person is not a step of its own: it settles the entry the visit just made.
        else if (step.kind === 'select') root.history.replacing(() => ui.openRun(step.runId));
    });

    // Show where the selected run is: open the folds above it.
    useEffect(() => {
        if (selectedId === null) return;

        const ancestors = ancestorIds(project.runs, selectedId);

        setCollapsed(current => (ancestors.some(id => current.has(id)) ? new Set([...current].filter(id => !ancestors.includes(id))) : current));
    }, [selectedId, project.runs]);

    const tree = project.runTree(ui.showFinished);
    const searching = query.trim() !== '';
    const shown = searching ? filterTree(tree, run => runMatches(run, project.tasksOfRun(run.id).map(task => task.key), query)) : tree;
    const rows = flattenTree(shown, collapsed, searching);

    return (
        <div className={ styles.screen }>
            <RunList
                rows={ rows }
                runCount={ project.runs.size }
                activeChildCounts={ countActiveChildren(project.runs.values()) }
                selectedId={ selectedId }
                query={ query }
                showFinished={ ui.showFinished }
                onQueryChange={ setQuery }
                onShowFinishedChange={ show => ui.setShowFinished(show) }
                onSelect={ runId => ui.openRun(runId) }
                onToggle={ runId => setCollapsed((current) => {
                    const next = new Set(current);

                    if (!next.delete(runId)) next.add(runId);

                    return next;
                }) }
            />

            { selectedRun
                ? <RunDetail key={ selectedRun.id } run={ selectedRun } />
                : (
                    <div className={ styles.empty }>
                        <Text variant="heading-5">No agent selected</Text>
                        <Text color="secondary">
                            { project.runs.size === 0 ? 'Agents show up here when a chat or a task starts work.' : 'Pick an agent in the list to see its work.' }
                        </Text>
                    </div>
                ) }
        </div>
    );
}
