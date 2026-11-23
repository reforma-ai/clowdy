import { Button } from '@clowdy/components/Button';
import { inlineLink } from '@clowdy/components/Text';

import type { ComponentPropsWithoutRef } from 'react';
import type { ExtraProps } from 'streamdown';

/** The app opens `https:` links in the system browser and nothing else (`navigationDecision` in the main process). */
function opensInBrowser(href: string | undefined): href is string {
    return href !== undefined && URL.parse(href)?.protocol === 'https:';
}

/** A link that would do nothing when pressed (`http:`, `mailto:`, a link still arriving) stays plain text, not a dead link. */
export function StreamdownLink({ href, children }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
    if (!opensInBrowser(href)) return <>{children}</>;

    return (
        // The hover title says where the link goes, which its text may not.
        <span title={href}>
            <Button
                data-streamdown="link"
                href={href}
                target="_blank"
                className={inlineLink}
                variant="inline"
                color="primary"
                size="sm"
            >
                {children}
            </Button>
        </span>
    );
}
