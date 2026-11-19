import { Button } from '@clowdy/components/Button';
import { CopyButton } from '@clowdy/components/CopyButton';
import { Spinner } from '@clowdy/components/Spinner';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { ArrowUpRight, Check } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import styles from './Account.module.css';
import { InlineCode } from './InlineCode';
import { accountLine, isSignInRunning } from './providerView';

import type { AgentInfo } from '@clowdy/protocol';
import type { useAgentCommands } from './useAgentCommands';

const TONE_COLOR = { default: undefined, muted: 'secondary', warning: 'warning' } as const;

export interface AccountProps {
    agent: AgentInfo;
    commands: ReturnType<typeof useAgentCommands>;
}

/** Who is signed in to the agent and the plan, or why there is nobody; under it, the daemon's note on that, when it has one. */
export function AccountLine({ agent }: { agent: AgentInfo }) {
    const line = accountLine(agent);

    return (
        <>
            <div className={ styles.who }>
                <Text variant="sm" color={ TONE_COLOR[line.tone] } truncate title={ line.text }>{ line.text }</Text>
                { line.plan && <Badge size="xs" color="secondary" textValue={ line.plan } className={ styles.plan }>{ line.plan }</Badge> }
            </div>
            { line.detail && <Text variant="xs" color="secondary"><InlineCode text={ line.detail } /></Text> }
        </>
    );
}

/**
 * The button that signs in (or in again), or the vendor's command when the daemon cannot run the sign-in. Nothing while a sign-in runs,
 * and nothing for a program that is missing or a provider that is off, which have nobody to sign in.
 */
export function SignInAction({ agent, commands }: AccountProps) {
    const signedIn = agent.signIn?.status === 'signed-in';

    if (agent.status !== 'ready' || !agent.enabled || isSignInRunning(agent.signInSession)) return null;

    if (!agent.canSignIn) {
        return agent.login ? <Text variant="xs" color="secondary">Run <Text as="code" variant="code">{ agent.login }</Text> in a terminal</Text> : null;
    }

    return (
        <Button
            variant={ signedIn ? 'bordered' : 'filled' }
            color={ signedIn ? 'secondary' : 'primary' }
            size="sm"
            isPending={ commands.pending.has('signIn') }
            onPress={ () => void commands.signIn() }
        >
            { signedIn ? 'Sign in again' : 'Sign in' }
        </Button>
    );
}

/** What the vendor's program printed for the person: a sign-in link to copy into another browser or open here, and a code to enter on the page. */
function SignInLink({ url, code }: { url?: string; code?: string }) {
    return (
        <div className={ styles.link }>
            { url && (
                <>
                    <Text variant="code" color="secondary" className={ styles.url } truncate title={ url }>{ url }</Text>
                    <CopyButton value={ url } variant="bordered" size="xs">Copy link</CopyButton>
                    {/* The app opens `https:` links only; a program may print another kind (a local address), which can only be copied. */}
                    { url.startsWith('https://') && (
                        <Button variant="bordered" size="xs" href={ url } target="_blank" rel="noreferrer">
                            <ArrowUpRight aria-hidden />
                            Open
                        </Button>
                    ) }
                </>
            ) }
            { code && (
                <div className={ styles.code }>
                    <Text variant="xs" color="secondary">Enter this code on the page</Text>
                    <CopyButton value={ code } variant="filling" size="xs" tooltip="Copy the code">{ code }</CopyButton>
                </div>
            ) }
        </div>
    );
}

/**
 * The sign-in the daemon runs with the vendor's login, as it goes: the link the program printed, with Copy and Open, and Cancel; after it,
 * a failure or the account. Nothing when no sign-in has run or the person cancelled it, so the caller lays out no empty row.
 */
export function SignInStatus({ agent, commands, className }: AccountProps & { className?: string }) {
    const session = agent.signInSession;

    if (isSignInRunning(session)) {
        return (
            <div className={ cn(styles.session, className) } role="status">
                <div className={ styles.progress }>
                    <Spinner size="sm" />
                    <Text variant="sm" className={ styles.step }>{ session.step === 'starting' ? 'Starting the sign-in…' : 'Finish signing in in your browser. This page updates when it is done.' }</Text>
                    <Button variant="inline" color="secondary" size="sm" isPending={ commands.pending.has('cancelSignIn') } onPress={ () => void commands.cancelSignIn() }>Cancel</Button>
                </div>
                { (session.url || session.code) && <SignInLink url={ session.url } code={ session.code } /> }
            </div>
        );
    }

    switch (session?.step) {
        case 'failed':
            return <Text variant="sm" color="danger" role="alert" className={ className }>{ session.message ?? 'Sign-in failed' }</Text>;
        case 'done':
            return (
                <Text variant="sm" color="success" className={ cn(styles.done, className) }>
                    <Check aria-hidden />
                    Signed in
                </Text>
            );
        default:
            return null;
    }
}
