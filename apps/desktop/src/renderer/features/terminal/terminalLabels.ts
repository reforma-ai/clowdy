import type { TerminalInfo } from '@clowdy/protocol';

/** What a terminal's tab says: the shell's name, numbered among the others of the same name when there are several (`zsh`, `zsh 2`). */
export function terminalLabels(terminals: ReadonlyArray<Pick<TerminalInfo, 'shell'>>): string[] {
    const counts = new Map<string, number>();

    for (const { shell } of terminals) counts.set(shell, (counts.get(shell) ?? 0) + 1);

    const seen = new Map<string, number>();

    return terminals.map(({ shell }) => {
        const number = (seen.get(shell) ?? 0) + 1;

        seen.set(shell, number);

        return number === 1 ? shell : `${ shell } ${ number }`;
    });
}
