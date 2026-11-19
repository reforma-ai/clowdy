import { Button } from '@clowdy/components/Button';
import { CopyButton, copyWithFeedback, useCopyFeedback } from '@clowdy/components/CopyButton';
import { Spinner } from '@clowdy/components/Spinner';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';

import styles from './Account.module.css';
import { InlineCode } from './InlineCode';
import { accountLine, isSignInRunning } from './providerView';

import type { AgentInfo, AgentSignInSession } from '@clowdy/protocol';
import type { useAgentCommands } from './useAgentCommands';

const TONE_COLOR = { default: undefined, muted: 'secondary', warning: 'warning' } as const;

export interface AccountProps {
    agent: AgentInfo;
    commands: ReturnType<typeof useAgentCommands>;
}

/** The link the vendor's program printed, copied for another browser. The label says when it is done. */
function CopyLinkButton({ url }: { url: string }) {
    const { copied, markCopied } = useCopyFeedback();

    return <Button variant="inline" color="primary" onPress={ () => copyWithFeedback(url, markCopied) }>{ copied ? 'Copied' : 'Copy link' }</Button>;
}

/**
 * A sign-in the daemon runs, in the place of the account: a small spinner, where to finish it, and the link the program printed, to open
 * here (`https:` only: the app opens nothing else) or copy into another browser. Under it, a one-time code to enter on the page.
 */
function SignInProgress({ session }: { session: AgentSignInSession }) {
    const { url, code } = session;

    return (
        <>
            <div className={ styles.progress }>
                <Spinner size="xxs" className={ styles.spinner } />
                <Text variant="sm" color="secondary" role="status">{ session.step === 'starting' ? 'Starting the sign-in…' : 'Continue in your browser' }</Text>
                { url?.startsWith('https://') && <Button variant="inline" color="primary" href={ url } target="_blank" rel="noreferrer">Open page</Button> }
                { url && <CopyLinkButton url={ url } /> }
            </div>
            { code && (
                <div className={ styles.code }>
                    <Text variant="sm" color="secondary">Enter this code on the page</Text>
                    <CopyButton value={ code } variant="filling" size="xs" tooltip="Copy the code">{ code }</CopyButton>
                </div>
            ) }
        </>
    );
}

/**
 * Who is signed in to the agent and the plan, or why there is nobody, with the daemon's note on that; a sign-in that failed says why
 * under it. While a sign-in runs, how it goes instead.
 */
export function AccountLine({ agent }: { agent: AgentInfo }) {
    const session = agent.signInSession;

    if (isSignInRunning(session)) return <SignInProgress session={ session } />;

    const line = accountLine(agent);

    return (
        <>
            <div className={ styles.who }>
                <Text variant="sm" color={ TONE_COLOR[line.tone] } truncate title={ line.text }>{ line.text }</Text>
                { line.plan && <Badge size="xs" color="secondary" textValue={ line.plan } className={ styles.plan }>{ line.plan }</Badge> }
            </div>
            { line.detail && <Text variant="xs" color="secondary"><InlineCode text={ line.detail } /></Text> }
            { session?.step === 'failed' && <Text variant="sm" color="danger" role="alert">{ session.message ?? 'Sign-in failed' }</Text> }
        </>
    );
}

/**
 * The button at the end of the card's first row: Sign in (or Sign in again), Cancel while a sign-in runs, or the vendor's command when the
 * daemon cannot run the sign-in. Nothing for a program that is missing or a provider that is off, which have nobody to sign in.
 */
export function SignInAction({ agent, commands }: AccountProps) {
    const signedIn = agent.signIn?.status === 'signed-in';

    if (agent.status !== 'ready' || !agent.enabled) return null;

    if (isSignInRunning(agent.signInSession)) {
        return (
            <Button variant="bordered" color="secondary" size="sm" isPending={ commands.pending.has('cancelSignIn') } onPress={ () => void commands.cancelSignIn() }>
                Cancel
            </Button>
        );
    }

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
