import { Button } from '@clowdy/components/Button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef } from '@clowdy/components/Resizable';
import { Show } from '@clowdy/components/Show';
import { Aside } from '@clowdy/icons/14';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { useRootStore } from '../../stores';
import { ChangesList, type ChangesListHandle } from './ChangesList';
import { ChangesSidebar } from './ChangesSidebar';
import { ChangesToolbar } from './ChangesToolbar';
import styles from './ChangesView.module.css';
import { CHANGES_READING_MIN_WIDTH, CHANGES_SIDEBAR_MIN_WIDTH } from './layout';
import { placeChangesOf } from './PlaceChanges';
import { changesSidebarLayout } from './sidebarLayout';
import { useBoxWidth } from './useBoxWidth';
import { useGitFacts } from './useGitFacts';

import type { ProjectId } from '@clowdy/protocol';
import type { Place } from '../sidePanel/currentPlace';

/**
 * The button that shows and hides the sidebar. It is at the right edge of the view whichever the state, so a second press lands where the first did: at the end of the reading
 * area's toolbar while the sidebar is hidden, and at the end of the sidebar's own header while it is shown (the two bars are one height and have their buttons the same distance
 * from the edge). Pressed while the sidebar is shown. One takes the other's place, so after a press from the keyboard the new one takes the focus.
 */
function SidebarToggle({ open, onPress }: { open: boolean; onPress: () => void }) {
    return (
        <Button
            variant="filling"
            color="secondary"
            size="sm"
            iconOnly
            aria-label="Sidebar"
            tooltip={ open ? 'Hide the sidebar' : 'Show the sidebar' }
            tooltipPlacement="bottom"
            isPressed={ open }
            data-sidebar-toggle=""
            onPress={ (event) => {
                onPress();

                if (event.pointerType === 'keyboard') requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-sidebar-toggle]')?.focus());
            } }
        >
            <Aside className={ styles.toggleIcon } aria-hidden="true" />
        </Button>
    );
}

/**
 * The sidebar's panel and the edge to drag it by. It is built each time the sidebar opens, which is when its width is read, with an id of its own each time: the panel library
 * keeps the last layout of every set of ids, in percentages, and would bring it back in place of the width, which is a different size when the view was resized meanwhile.
 */
function Sidebar({ panelRef, width, children }: { panelRef: ReturnType<typeof usePanelRef>; width: number; children: ReactNode }) {
    const [opened] = useState(width);
    const id = useId();

    return (
        <>
            <ResizableHandle aria-label="Resize the sidebar" />

            <ResizablePanel id={ id } panelRef={ panelRef } className={ styles.side } defaultSize={ opened } minSize={ CHANGES_SIDEBAR_MIN_WIDTH } groupResizeBehavior="preserve-pixel-size">
                { children }
            </ResizablePanel>
        </>
    );
}

/**
 * The tab's view of one place that is ready: the diffs at the left and, at their right on an edge to drag, the sidebar; the edge and the sidebar's visibility are the window's
 * choice, as the file tree's are. It reads the place's git facts (`useGitFacts`, which the strip and Info read too) and reads the list of its scope when it appears, when the
 * scope changes and when the facts start a new round of reads, which is all the triggers the tab has. A card is open when the tab appears.
 */
export function ChangesView({ projectId, place }: { projectId: ProjectId; place: Place }) {
    const root = useRootStore();
    const facts = useGitFacts(projectId, place);
    const model = useMemo(() => (facts ? placeChangesOf(root.transport, facts) : undefined), [root.transport, facts]);
    const sidebar = usePanelRef();
    const list = useRef<ChangesListHandle>(null);
    const id = useId();
    const [boxRef, width] = useBoxWidth();
    // A group built in a box that has no width yet lays itself out at that width, which squeezes the sidebar to its narrowest and leaves it there once the box grows: it is built when
    // the box has a width, and stays built.
    const [sized, setSized] = useState(false);
    const generation = facts?.generation;
    const scope = model?.effectiveScope;

    // The facts read the place when this is the first to look at it, which starts a round: the list is read once, for that round, and not before it.
    useEffect(() => {
        if (model) model.sync(model.facts.generation);
    }, [model, scope, generation]);

    useEffect(() => model?.resetFolds(), [model]);

    useEffect(() => {
        if (width > 0) setSized(true);
    }, [width]);

    if (!model) return null;

    const { open } = changesSidebarLayout;
    const toggle = () => changesSidebarLayout.toggle();

    return (
        <div ref={ boxRef } className={ styles.root }>
            <Show when={ sized }>
                <ResizablePanelGroup
                    orientation="horizontal"
                    // Only the person's own drag is kept: a window that is resized, or a width the range had to correct, changes the layout too.
                    onLayoutChanged={ (_layout, meta) => {
                        if (!meta.isUserInteraction) return;

                        // After the layout has landed: a key press announces its change a step before the panel's size shows it.
                        requestAnimationFrame(() => {
                            if (sidebar.current) changesSidebarLayout.setWidth(sidebar.current.getSize().inPixels);
                        });
                    } }
                >
                    <ResizablePanel id={ `${ id }-reading` } className={ styles.reading } minSize={ CHANGES_READING_MIN_WIDTH }>
                        <ChangesToolbar model={ model } end={ !open && <SidebarToggle open={ false } onPress={ toggle } /> } />
                        <ChangesList ref={ list } model={ model } />
                    </ResizablePanel>

                    <Show when={ open }>
                        <Sidebar panelRef={ sidebar } width={ changesSidebarLayout.width }>
                            <ChangesSidebar
                                model={ model }
                                place={ place }
                                projectId={ projectId }
                                toggle={ <SidebarToggle open onPress={ toggle } /> }
                                onOpenFile={ (path) => {
                                    model.reveal(path);
                                    list.current?.scrollToFile(path);
                                } }
                            />
                        </Sidebar>
                    </Show>
                </ResizablePanelGroup>
            </Show>
        </div>
    );
}
