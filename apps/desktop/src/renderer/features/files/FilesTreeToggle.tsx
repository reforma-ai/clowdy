import { Button } from '@clowdy/components/Button';
import { Aside } from '@clowdy/icons/14';

import styles from './FilesTreeToggle.module.css';
import { useTreeLayout } from './treeLayout';

/** The button in the side panel's header, while the Files tab is on show, that shows the file tree at the right of the editor or hides it. */
export function FilesTreeToggle() {
    const tree = useTreeLayout();
    const label = tree.open ? 'Hide the file tree' : 'Show the file tree';

    return (
        <Button variant="filling" size="sm" iconOnly aria-label="File tree" tooltip={ label } tooltipPlacement="bottom" isPressed={ tree.open } onPress={ () => tree.toggle() }>
            <Aside className={ styles.icon } />
        </Button>
    );
}
