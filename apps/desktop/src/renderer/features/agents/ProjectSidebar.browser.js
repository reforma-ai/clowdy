// Run with the desktop screenshot harness against /?fixtures=static, passing this file to --eval.
(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    await wait(1500);
    const root = window.__clowdy.root;
    root.selectProject('p-personal');
    await wait(1000);
    const viewport = document.querySelector('[data-project-sidebar]');
    const target = viewport.querySelector('[class*="Scrollable__container"]');
    const left = viewport.getBoundingClientRect().left;
    target.dispatchEvent(new WheelEvent('wheel', { deltaX: 10, bubbles: true, cancelable: true }));
    await wait(50);
    const track = viewport.lastElementChild;
    const preview = track.querySelector('[inert]');
    const observed = {
        scrollLeft: viewport.scrollLeft,
        currentLeft: track.children[0].getBoundingClientRect().left - left,
        previewLeft: preview.getBoundingClientRect().left - left,
        width: viewport.clientWidth,
        selected: root.selectedProjectId,
    };
    if (
        observed.scrollLeft !== 0 ||
        Math.abs(observed.currentLeft + 10) > 1 ||
        Math.abs(observed.previewLeft - (observed.width - 10)) > 1 ||
        observed.selected !== 'p-personal'
    ) {
        throw new Error(`A short swipe jumped to the next project: ${JSON.stringify(observed)}`);
    }
    await wait(500);
    if (root.selectedProjectId !== 'p-personal' || viewport.scrollLeft !== 0) {
        throw new Error('A short swipe must return to the current project');
    }
    root.selectProject('p-car');
    await wait(1000);
    const reverseViewport = document.querySelector('[data-project-sidebar]');
    const reverseTarget = reverseViewport.querySelector('[class*="Scrollable__container"]');
    reverseTarget.dispatchEvent(new WheelEvent('wheel', { deltaX: -10, bubbles: true, cancelable: true }));
    await wait(50);
    const reverseTrack = reverseViewport.lastElementChild;
    const reversePreview = reverseTrack.querySelector('[inert]');
    const reverseLeft = reverseViewport.getBoundingClientRect().left;
    const reverse = {
        scrollLeft: reverseViewport.scrollLeft,
        currentLeft: reverseTrack.lastElementChild.getBoundingClientRect().left - reverseLeft,
        previewLeft: reversePreview.getBoundingClientRect().left - reverseLeft,
        width: reverseViewport.clientWidth,
        selected: root.selectedProjectId,
    };
    if (
        reverse.scrollLeft !== 0 ||
        Math.abs(reverse.currentLeft - 10) > 1 ||
        Math.abs(reverse.previewLeft - (10 - reverse.width)) > 1 ||
        reverse.selected !== 'p-car'
    ) {
        throw new Error(`A short swipe jumped to the previous project: ${JSON.stringify(reverse)}`);
    }
    return { observed, reverse };
})();
