const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', process.env.CLOWDY_SCROLL_TEST_PROFILE);
app.whenReady()
    .then(() => {
        const addon = require(process.env.CLOWDY_SCROLL_TEST_ADDON);
        const emit = require(process.env.CLOWDY_SCROLL_TEST_EMITTER).emit;
        const a = new BrowserWindow({ show: false });
        const b = new BrowserWindow({ show: false });
        const aa = [];
        const bb = [];
        const stopA = addon.start(a.getNativeWindowHandle(), e => aa.push(e));
        const stopB = addon.start(b.getNativeWindowHandle(), e => bb.push(e));
        emit(a.getNativeWindowHandle());
        console.log(JSON.stringify({ aa, bb }));
        assert.equal(aa.length, 1);
        assert.equal(bb.length, 0);
        assert.equal(aa[0].phase, 1);
        assert.equal(aa[0].deltaX, -5);
        assert.equal(aa[0].deltaY, 2);
        assert.equal(aa[0].precise, true);
        stopA();
        emit(a.getNativeWindowHandle());
        assert.equal(aa.length, 1);
        stopB();
        a.destroy();
        b.destroy();
        console.log('synthetic window isolation and serialization passed');
        app.quit();
    })
    .catch(error => {
        console.error(error);
        app.exit(1);
    });
