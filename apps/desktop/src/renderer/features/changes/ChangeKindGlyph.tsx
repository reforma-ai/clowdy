import { Text, type TextVariant } from '@clowdy/components/Text';

import styles from './ChangeKindGlyph.module.css';
import { CHANGE_KIND_VIEW } from './gitSummary';

import type { GitChangeKind } from '@clowdy/protocol';

/**
 * The letter that says what happened to a changed file (`A`, `M`, `D`, …) in its status colour, with the status's name as its tooltip. It is a box of its own, so the paths of a
 * list start at one place whichever letter it is. `labelled` names it for a screen reader too; a row whose label says the status otherwise hides it.
 */
export function ChangeKindGlyph({
    kind,
    variant,
    labelled = false,
}: {
    kind: GitChangeKind;
    variant?: TextVariant;
    labelled?: boolean;
}) {
    const view = CHANGE_KIND_VIEW[kind];

    return (
        <Text
            variant={variant}
            weight="medium"
            color={view.color}
            className={styles.glyph}
            title={view.label}
            aria-label={labelled ? view.label : undefined}
            aria-hidden={labelled ? undefined : 'true'}
        >
            {view.glyph}
        </Text>
    );
}
