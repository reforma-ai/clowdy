import { Breadcrumb } from '@clowdy/components/Breadcrumb';
import { Text } from '@clowdy/components/Text';

import styles from './SettingsPage.module.css';

import type { ReactNode } from 'react';

export interface SettingsPageProps {
    title: string;
    /**
     * For a page inside another one: the pages above it, nearest last. The title then reads as a path, in the same type as a plain title:
     * `Projects › Car Rental`, where each page above is a link back.
     */
    parents?: ReadonlyArray<{ label: string; onPress: () => void }>;
    /** What the page is for, under the title. */
    description?: ReactNode;
    /** At the end of the title's line: the page's main action. */
    actions?: ReactNode;
    children?: ReactNode;
}

/**
 * The top of a Settings page: its title and what it is for, with a hairline under them, and then the page's own blocks, which are the
 * `SettingsSection`s. It renders no wrapper: the blocks are laid out by the column of the Settings screen, 24px apart.
 */
export function SettingsPage({ title, parents = [], description, actions, children }: SettingsPageProps) {
    return (
        <>
            <header className={ styles.header }>
                <div className={ styles.titleLine }>
                    { parents.length === 0
                        ? <Text as="h1" variant="heading-2" className={ styles.title }>{ title }</Text>
                        : (
                            <Breadcrumb variant="heading-2" aria-label="Settings path">
                                { parents.map(parent => <Breadcrumb.Link key={ parent.label } onPress={ parent.onPress }>{ parent.label }</Breadcrumb.Link>) }
                                <Breadcrumb.Page>{ title }</Breadcrumb.Page>
                            </Breadcrumb>
                        ) }
                    { actions }
                </div>
                { description && <Text color="secondary">{ description }</Text> }
            </header>

            { children }
        </>
    );
}
