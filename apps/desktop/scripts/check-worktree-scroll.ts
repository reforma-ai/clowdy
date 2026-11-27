import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Browser-only regression: actual focus geometry, which happy-dom cannot model. Run against the fixture dev server. */
const url = process.argv[2] ?? 'http://127.0.0.1:5273/?fixtures=static&worktrees';
const out = process.argv[3] ?? join(tmpdir(), 'clowdy-worktree-scroll.png');
const check = `(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
    const transport = window.__clowdy.root.transport;
    const read = transport.getProjectWorktrees.bind(transport);
    transport.getProjectWorktrees = async (...args) => {
        const groups = await read(...args);
        const sample = groups[0].worktrees[1];
        groups[0].worktrees.push(...Array.from({ length: 32 }, (_, i) => ({
            ...sample, path: '/fixture/worktree-' + i, branch: 'fixture/worktree-' + i,
            workspaceId: undefined, changes: 0, merged: true, locked: undefined,
            blocked: undefined, chats: [], submodules: false,
        })));
        return groups;
    };
    document.querySelector('button[aria-label="Manage worktrees"]').click();
    while (!button('Tidy up…') || button('Tidy up…').disabled) await sleep(30);
    button('Tidy up…').click();
    await sleep(600);
    const modal = document.querySelector('[data-modal-window]');
    const scroller = modal.querySelector('[class*=worktreeRows]');
    const footer = modal.querySelector('[class*=footer]');
    const checkbox = [...modal.querySelectorAll('input[type=checkbox]')].filter(input => !input.disabled).at(-1);
    scroller.scrollTop = scroller.scrollHeight;
    await sleep(100);
    const before = { footer: footer.getBoundingClientRect().top, scroll: scroller.scrollTop, checked: checkbox.checked };
    if (before.scroll < 500) throw new Error('Fixture did not overflow');
    for (let i = 0; i < 2; i++) {
        // Focusing the real visually hidden input triggers Chromium's scroll-to-focus behavior.
        checkbox.focus();
        checkbox.click();
        await sleep(150);
        const after = { footer: footer.getBoundingClientRect().top, scroll: scroller.scrollTop, checked: checkbox.checked };
        if (Math.abs(after.footer - before.footer) > 1 || after.scroll !== before.scroll || after.checked !== (i === 0 ? !before.checked : before.checked))
            throw new Error('Worktree dialog moved or lost its selection: ' + JSON.stringify({ before, after }));
        checkbox.blur();
    }
    return { scrollTop: before.scroll, footerTop: before.footer, selectionToggled: true };
})()`;
const child = Bun.spawn(
    [
        process.execPath,
        `${import.meta.dir}/screenshot.ts`,
        '--url',
        url,
        '--out',
        out,
        '--width',
        '1200',
        '--height',
        '850',
        '--theme',
        'light',
        '--wait-for',
        'button[aria-label="Manage worktrees"]',
        '--eval',
        check,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
);
process.exit(await child.exited);
