import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { PanelEmptyState, PanelLoadingState } from '@clowdy/components/Panel';
import { Scrollable } from '@clowdy/components/Scrollable';
import { useImperativeHandle, useRef, type Ref } from 'react';

import styles from './ChangesList.module.css';
import { DiffCard } from './DiffCard';
import { LIST_TEXT, listStateOf } from './listState';

import type { PlaceChanges } from './PlaceChanges';

/** What the tab asks of the list from outside: to bring a file's card to the top. */
export interface ChangesListHandle {
    scrollToFile: (path: string) => void;
}

/**
 * The reading area under the toolbar: one card per changed file in a scroller, or what stands in for them (the first read on its way, a folder that is no repository, a read that
 * failed, a scope with no change, a filter that lets nothing through). The scroller keeps the browser's own scroll anchoring on (it is not a chat that sticks to its end), so a
 * diff that is built above what is on screen does not move it.
 */
export function ChangesList({ model, ref }: { model: PlaceChanges; ref?: Ref<ChangesListHandle> }) {
    const root = useRef<HTMLDivElement>(null);
    const state = listStateOf(model);

    useImperativeHandle(ref, () => ({
        scrollToFile(path) {
            const card = [...(root.current?.querySelectorAll<HTMLElement>('[data-card]') ?? [])].find(element => element.dataset.card === path);

            card?.scrollIntoView({ block: 'start', behavior: 'instant' });
        },
    }), []);

    switch (state.kind) {
        case 'loading':
            return <PanelLoadingState />;
        case 'notRepository':
            return <PanelEmptyState title={ LIST_TEXT.notRepository } description={ LIST_TEXT.notRepositoryHint } />;
        case 'failed':
            return (
                <PanelEmptyState
                    title={ LIST_TEXT.failed }
                    description={ state.message }
                    action={ <Button variant="filling" color="secondary" size="sm" onPress={ () => model.reload() }>Try again</Button> }
                />
            );
        case 'empty':
            return <PanelEmptyState title={ state.title } description={ state.description } />;
        case 'filtered':
            return (
                <PanelEmptyState
                    title={ LIST_TEXT.filtered }
                    description={ LIST_TEXT.filteredHint }
                    action={ <Button variant="filling" color="secondary" size="sm" onPress={ () => model.setFilter('') }>Clear the filter</Button> }
                />
            );
        case 'files':
            return (
                <Scrollable ref={ root } className={ styles.list } contentClass={ styles.cards }>
                    <For each={ [...model.files] }>
                        { file => <DiffCard key={ file.path } model={ model } file={ file } /> }
                    </For>
                </Scrollable>
            );
    }
}
