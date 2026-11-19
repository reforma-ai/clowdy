import { Breadcrumb } from '@clowdy/components/Breadcrumb';
import { ContentColumn } from '@clowdy/components/ContentColumn';
import { Fade } from '@clowdy/components/Fade';
import { LayerStack } from '@clowdy/components/LayerStack';
import { Text } from '@clowdy/components/Text';

import { SCREEN_TITLE } from '../../../shared';
import styles from './SettingsPage.module.css';

import type { ReactNode } from 'react';

/** A page opened from a Settings page (the page of one project, from the list of projects). */
export interface SettingsLayer {
    /** Names the layer while it is open. */
    id: string;
    /** The last crumb of the path while it is open. */
    title: string;
    /** What the layer is for, under the title. */
    description?: ReactNode;
    content: ReactNode;
}

export interface SettingsPageProps {
    title: string;
    /** What the page is for, under the title. */
    description?: ReactNode;
    /** At the end of the title's line, level with the title and apart from the words: the page's main action, a small `filled` `contrast` button. */
    actions?: ReactNode;
    /**
     * Pages opened from this one, deepest last. Each slides in over the page, which steps back and stays as it was, and the title becomes
     * a path to it: `Projects › Car Rental`, with a crumb for every page above the last one, which is a link back (`onNavigate`).
     */
    layers?: readonly SettingsLayer[];
    /** A link of the path was pressed: `0` is this page, `1` the first layer, and so on. */
    onNavigate?: (depth: number) => void;
    children?: ReactNode;
}

/**
 * A Settings page: a title line that stays put (the title, or the path to the page that is open, and the page's action) over the room
 * the page's own blocks scroll in. The blocks are `SettingsSection`s, led by what the page is for and a hairline, 24px apart. The page
 * rises into place as it opens, a layer slides in over it as it is opened and out as it is left, and the crumbs of the path come and
 * go with them, all by the system's own numbers (`LayerStack`). Keep one `SettingsPage` mounted while its layers come and go, or the
 * title line starts again each time.
 */
export function SettingsPage({ title, description, actions, layers = [], onNavigate, children }: SettingsPageProps) {
    const path = [{ id: 'page', title }, ...layers.map(layer => ({ id: `layer:${ layer.id }`, title: layer.title }))];

    return (
        <div className={ styles.page }>
            <ContentColumn className={ styles.header }>
                <div className={ styles.titleLine }>
                    <Breadcrumb variant={ SCREEN_TITLE } aria-label="Settings path" className={ styles.path }>
                        { path.map((crumb, index) => (
                            index === path.length - 1
                                ? <Breadcrumb.Page key={ crumb.id }><span role="heading" aria-level={ 1 }>{ crumb.title }</span></Breadcrumb.Page>
                                : <Breadcrumb.Link key={ crumb.id } onPress={ () => onNavigate?.(index) }>{ crumb.title }</Breadcrumb.Link>
                        )) }
                    </Breadcrumb>
                    <Fade className={ styles.actions }>{ actions }</Fade>
                </div>
            </ContentColumn>

            <LayerStack layers={ layers.map(layer => ({ id: layer.id, content: <PageBody description={ layer.description }>{ layer.content }</PageBody> })) }>
                <PageBody description={ description }>{ children }</PageBody>
            </LayerStack>
        </div>
    );
}

/** What a layer of the page scrolls: what it is for, with a hairline under it, and then its blocks. */
function PageBody({ description, children }: { description: ReactNode; children: ReactNode }) {
    return (
        <ContentColumn className={ styles.body }>
            { description && <div className={ styles.intro }><Text color="secondary">{ description }</Text></div> }
            { children }
        </ContentColumn>
    );
}
