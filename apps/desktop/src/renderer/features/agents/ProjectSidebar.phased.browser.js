(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    await wait(500);
    let sequence = 0,
        active = false,
        last = null,
        origin = null;
    const listeners = new Set();
    window.desktop = {
        nativeScroll: {
            available: true,
            snapshot: () => ({ sequence, active, gesture: 1, origin, last }),
            subscribe: fn => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
        },
    };
    const root = window.__clowdy.root;
    root.selectProject('p-car');
    await wait(700);
    root.selectProject('p-personal');
    await wait(700);
    const viewport = document.querySelector('[data-project-sidebar]');
    const target = viewport.querySelector('[class*="Scrollable__container"]');
    const rect = target.getBoundingClientRect();
    const x = rect.left + 15,
        y = rect.top + 15;
    origin = { x, y };
    const phase = value => {
        active = value === 1 || value === 4;
        last = {
            kind: 'scroll',
            sequence: ++sequence,
            phase: value,
            momentumPhase: 0,
            deltaX: 20,
            deltaY: 0,
            x,
            y,
            timestamp: sequence,
            precise: true,
        };
        for (const fn of listeners) fn(last);
    };
    const wheel = dx =>
        target.dispatchEvent(
            new WheelEvent('wheel', { deltaX: dx, clientX: x, clientY: y, bubbles: true, cancelable: true })
        );
    phase(1);
    for (let i = 0; i < 5; i++) wheel(20);
    await wait(2200);
    if (root.selectedProjectId !== 'p-personal') throw Error('Switched while held');
    phase(8);
    await wait(350);
    if (root.selectedProjectId !== 'p-car') throw Error('Did not switch on release: ' + root.selectedProjectId);
    return 'Phased sidebar held 2200 ms and switched once after release';
})();
