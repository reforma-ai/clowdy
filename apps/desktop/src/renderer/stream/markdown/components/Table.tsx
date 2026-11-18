import { Scrollable } from '@clowdy/components/Scrollable';

import type { ComponentPropsWithoutRef } from 'react';
import type { ExtraProps } from 'streamdown';

export function StreamdownTable({ children }: ComponentPropsWithoutRef<'table'> & ExtraProps) {
    return (
        <Scrollable
            vertical={ false }
            horizontal
            data-streamdown="table-wrapper"
        >
            <table data-streamdown="table">
                { children }
            </table>
        </Scrollable>
    );
}
