import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
import { For } from '@clowdy/components/For';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { AiStar } from '@clowdy/icons/14';
import { writesCommitMessages } from '@clowdy/protocol';
import { useEffect } from 'react';

import { useAgents, useRootStore } from '../../stores';
import styles from './CommitBox.module.css';
import { commitDraftOf } from './CommitDraft';
import { gitFactsOf } from './gitFacts';
import { CHANGE_KIND_VIEW, splitPath } from './gitSummary';

import type { GitChangedFile } from '@clowdy/protocol';
import type { CommitDraft } from './CommitDraft';
import type { PlaceChanges } from './PlaceChanges';

/** One file of the commit: a tick, what happened to it, its name with its folder dimmed after it, and its lines. A press anywhere on the row ticks or unticks it. */
function CommitFileRow({ file, draft }: { file: GitChangedFile; draft: CommitDraft }) {
    const kind = CHANGE_KIND_VIEW[file.kind];
    const { folder, name } = splitPath(file.path);

    return (
        <Checkbox size="sm" className={ styles.row } isSelected={ draft.isTicked(file.path) } isDisabled={ draft.busy === 'commit' } aria-label={ file.path } onChange={ on => draft.setTicked(file.path, on) }>
            <Text variant="xs" weight="medium" color={ kind.color } className={ styles.glyph } title={ kind.label } aria-hidden="true">{ kind.glyph }</Text>
            <span className={ styles.fileName } title={ file.path }>
                <Text variant="xs" weight="medium" truncate className={ styles.name }>{ name }</Text>
                { folder && <Text variant="xs" color="secondary" truncate className={ styles.folderHint }>{ folder.slice(0, -1) }</Text> }
            </span>
            { file.additions !== undefined && file.deletions !== undefined && (
                <span className={ styles.counts }>
                    <Text variant="xs" color="success">{ `+${ file.additions }` }</Text>
                    <Text variant="xs" color="danger">{ `−${ file.deletions }` }</Text>
                </span>
            ) }
        </Checkbox>
    );
}

/**
 * The commit of the sidebar: the place's uncommitted files as a checklist (all ticked at first, new files included), the message and the buttons. It is there whichever scope the tab
 * shows, since what is committed is what is not committed yet, and the list inside it is its own: the sidebar's `Changed files` is the scope's list for finding a card, this one is for
 * choosing what goes in. Generate is offered only while an agent that the person turned `Commit messages` on for is signed in (`writesCommitMessages` of the agents the app already
 * knows; the daemon decides again when it is asked), and writes only into an empty box or over what it wrote itself. Commit is the one filled primary action of the place; Cmd or Ctrl and
 * Enter in the box does the same. What git or the agent said is shown as it said it, and the box is as it was.
 */
export function CommitBox({ model }: { model: PlaceChanges }) {
    const root = useRootStore();
    const { agents } = useAgents();
    const draft = commitDraftOf(model, root.transport, () => gitFactsOf(root.transport).refresh(model.facts.key));
    const canWrite = agents.some(writesCommitMessages);
    const { generation } = model.facts;
    const scope = model.effectiveScope;
    const names = draft.files.map(file => file.path).join('\0');

    // The list is read for each round of the facts, as the scope's list is; a scope that is the uncommitted one is read by the tab itself.
    useEffect(() => model.syncUncommitted(generation), [model, generation, scope]);
    // Files that went are forgotten, so one that comes back is ticked again.
    useEffect(() => draft.reconcile(), [draft, names]);

    if (model.isRepository === false || !draft.known) return null;

    const { files, failure, committed } = draft;
    const ticked = draft.ticked.length;
    const busy = draft.busy !== undefined;

    if (files.length === 0) {
        return (
            <section className={ styles.root } aria-label="Commit">
                <Text variant="xs" color="secondary" role="status">{ committed ? `Committed ${ committed.shortSha }` : 'Nothing to commit' }</Text>
            </section>
        );
    }

    return (
        <section className={ styles.root } aria-label="Commit">
            <div className={ styles.header }>
                <Checkbox size="sm" isSelected={ draft.allTicked } isIndeterminate={ !draft.allTicked && !draft.noneTicked } isDisabled={ draft.busy === 'commit' } aria-label="Tick every file" onChange={ on => draft.setAll(on) } />
                <Text variant="xs" weight="medium" color="secondary" truncate>Commit</Text>
                <Text variant="xs" color="secondary" className={ styles.count }>{ `${ ticked } of ${ files.length }` }</Text>
            </div>

            <Scrollable className={ styles.list } contentClass={ styles.rows }>
                <For each={ [...files] }>
                    { file => <CommitFileRow key={ file.path } file={ file } draft={ draft } /> }
                </For>
            </Scrollable>
            { draft.truncated && <Text variant="xs" color="secondary">{ `Showing the first ${ files.length } files` }</Text> }

            <Textarea
                variant="bordered"
                size="sm"
                rows={ 3 }
                isResizable={ false }
                aria-label="Commit message"
                placeholder={ draft.busy === 'generate' ? 'Writing the message' : 'Message' }
                value={ draft.message }
                isReadOnly={ draft.busy !== undefined }
                className={ styles.message }
                onChange={ text => draft.setMessage(text) }
                onKeyDown={ (event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void draft.commit();
                    }
                } }
            />

            <div className={ styles.actions }>
                { canWrite && (
                    <Button
                        variant="bordered"
                        size="sm"
                        className={ styles.generate }
                        isDisabled={ !draft.canGenerate }
                        isPending={ draft.busy === 'generate' }
                        spinnerPlacement="start"
                        tooltip={ draft.generateBlock }
                        tooltipPlacement="top"
                        onPress={ () => void draft.generate() }
                    >
                        <AiStar aria-hidden="true" />
                        Generate
                    </Button>
                ) }
                <Button color="primary" size="sm" className={ styles.commit } isDisabled={ !draft.canCommit } isPending={ draft.busy === 'commit' } onPress={ () => void draft.commit() }>Commit</Button>
            </div>

            { failure && (
                <div className={ styles.failure } role="alert">
                    <Text variant="xs" color="danger" select="text">{ failure.message }</Text>
                    { failure.hint && <Text variant="xs" color="secondary" select="text">{ failure.hint }</Text> }
                </div>
            ) }
            { !failure && !busy && committed && <Text variant="xs" color="secondary" role="status">{ `Committed ${ committed.shortSha }` }</Text> }
        </section>
    );
}
