import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { GITHUB_URL, LICENSE_URL, LICENSES_URL, RELEASES_URL } from '@clowdy/constants';
import { ArrowUpRight } from '@clowdy/icons/14';
import { Github } from '@clowdy/icons/logo';
import { useEffect, useState } from 'react';

import { useRootStore } from '../../stores';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

import type { ReactNode } from 'react';
import type { Transport } from '../../daemon/transport';

/** A computer that runs a daemon. Local is this one, and it is a host like the others will be: each gets a card in Updates. */
interface Host {
    name: string;
    detail: string;
}

const LOCAL_HOST: Host = { name: 'Local', detail: 'This computer' };

/**
 * Settings > About: where Clowdy lives (the repository and the releases), the versions running on each host, and what it is built with. It only informs and links: the links open in the
 * browser. Updates has a card for the one host there is, Local; hosts that are not this computer, and what to do about an old daemon on one, come with them.
 */
export function AboutPage() {
    const { transport } = useRootStore();

    return (
        <SettingsPage description="Links, versions and credits of Clowdy">
            <SettingsSection title="Clowdy">
                <SettingsCard divided>
                    <SettingsRow title="Repository" description="Source code, issues and stars">
                        <LinkButton href={ GITHUB_URL } icon={ <Github size={ 14 } /> }>Open in GitHub</LinkButton>
                    </SettingsRow>
                    <SettingsRow title="Download" description="The installers of the latest release">
                        <LinkButton href={ RELEASES_URL }>Open releases</LinkButton>
                    </SettingsRow>
                    <SettingsRow title="License" description="Clowdy is open source under the Apache License 2.0">
                        <LinkButton href={ LICENSE_URL }>Apache-2.0</LinkButton>
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Updates" description="The versions running on your hosts">
                <HostCard host={ LOCAL_HOST } transport={ transport } />
            </SettingsSection>

            <SettingsSection title="Credits">
                <SettingsCard>
                    <SettingsRow title="Open source licenses" description="The libraries, fonts and icons Clowdy is built with">
                        <LinkButton href={ LICENSES_URL }>Open licenses</LinkButton>
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}

/** A button that opens an address in the browser. */
function LinkButton({ href, icon = <ArrowUpRight />, children }: { href: string; icon?: ReactNode; children: ReactNode }) {
    return (
        <Button variant="filling" color="secondary" size="sm" href={ href } target="_blank" rel="noreferrer">
            { icon }
            { children }
        </Button>
    );
}

/** What a host's daemon said about itself: not yet, its version, or that it did not answer. */
type Reading = { status: 'checking' } | { status: 'read'; version: string } | { status: 'failed' };

/** The host's name and what runs on it, one row for each part. The `Clowdy app` row joins the daemon's with the shell version, once the window can tell it. */
function HostCard({ host, transport }: { host: Host; transport: Transport }) {
    const reading = useDaemonReading(transport);

    return (
        <SettingsCard as="section" divided aria-label={ host.name }>
            <SettingsRow title={ host.name } description={ host.detail } />
            <SettingsRow title="Daemon" description="Runs the agents and keeps the chats">
                <Text variant="sm" color="secondary" role="status">{ readingText(reading) }</Text>
            </SettingsRow>
        </SettingsCard>
    );
}

const readingText = (reading: Reading) => reading.status === 'checking' ? 'Checking…' : reading.status === 'read' ? reading.version : 'Unavailable';

/** Reads the daemon's version once, when the card is drawn. */
function useDaemonReading(transport: Transport): Reading {
    const [reading, setReading] = useState<Reading>({ status: 'checking' });

    useEffect(() => {
        let current = true;

        transport.getHealth().then(
            ({ version }) => current && setReading({ status: 'read', version }),
            () => current && setReading({ status: 'failed' })
        );

        return () => {
            current = false;
        };
    }, [transport]);

    return reading;
}
