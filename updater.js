// Update checker. Detects when the container/server has been redeployed with a
// newer build (by watching a core asset's ETag / Last-Modified) and lets the
// user reload the whole app to apply it. No version numbers to maintain.
(function () {
    const ASSET = 'app.js';      // changes on every code deploy
    const POLL_MS = 60 * 1000;   // check every minute + on window focus
    let baseline = null;
    let available = false;
    let btn = null;

    async function fetchTag() {
        try {
            const res = await fetch(ASSET + '?_=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
            if (!res.ok) return null;
            return res.headers.get('etag') || res.headers.get('last-modified') || null;
        } catch (e) {
            return null;
        }
    }

    function setAvailable(v) {
        available = v;
        if (!btn) return;
        btn.classList.toggle('available', v);
        btn.title = v ? 'Update available — click to reload the app' : 'Up to date';
    }

    function flash(msg) {
        if (typeof showAppAlert === 'function') { try { showAppAlert(msg, 'info'); return; } catch (e) {} }
        if (btn) { const t = btn.title; btn.title = msg; setTimeout(() => { btn.title = t; }, 1600); }
    }

    async function check(manual) {
        if (manual && btn) btn.classList.add('checking');
        const tag = await fetchTag();
        if (btn) btn.classList.remove('checking');
        if (!tag) { if (manual) flash("Couldn't check for updates"); return; }
        if (baseline === null) { baseline = tag; if (manual) flash('Up to date'); return; }
        if (tag !== baseline) setAvailable(true);
        else if (manual) flash('Up to date');
    }

    async function doUpdate() {
        // Drop any caches / service workers so the reload pulls the new build.
        try { if ('caches' in window) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } } catch (e) {}
        try {
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
            }
        } catch (e) {}
        // State is auto-flushed on beforeunload; reload fresh.
        location.reload();
    }

    function init() {
        btn = document.getElementById('update-btn');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            if (available) {
                const ok = window.confirm('A new version of the app is available. Update now?\nYour project is saved automatically.');
                if (ok) doUpdate();
            } else {
                check(true);
            }
        });
        check();
        setInterval(() => check(false), POLL_MS);
        window.addEventListener('focus', () => check(false));
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(false); });

        // Exposed for testing / manual control.
        window.__appUpdater = {
            check, doUpdate, setAvailable,
            get available() { return available; },
            get baseline() { return baseline; },
        };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
