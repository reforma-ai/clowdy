type WindowControlsOverlay = EventTarget & {
    visible: boolean;
    getTitlebarAreaRect: () => DOMRect;
};

const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay;

/** macOS parks the window controls on the left, so the titlebar area starts inset. Windows parks them on the right. */
function buttonsCoverLeadingEdge(): boolean {
    return overlay?.visible === true && overlay.getTitlebarAreaRect().x > 0;
}

/** Mirrors the window's chrome onto `<html>`, where `base.css` reads it. */
function syncWindowChrome(): void {
    const material = window.desktop?.material === true && overlay?.visible === true;

    document.documentElement.toggleAttribute('data-window-material', material);
    document.documentElement.toggleAttribute('data-window-buttons-leading', buttonsCoverLeadingEdge());
}

syncWindowChrome();
// Full screen hides the controls, and the overlay reports it with a geometry change.
overlay?.addEventListener('geometrychange', syncWindowChrome);
