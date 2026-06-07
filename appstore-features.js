// App Store workflow enhancements: full-language management, per-language and
// folder uploads (fastlane-aware), CSV text import/export, and main-language sync.
// Loaded after app.js + language-utils.js; it extends/overrides a few globals.

// ---- Language code normalization (fastlane / App Store → internal codes) ----
const LANG_CODE_MAP = {
    'en-us': 'en', 'en-gb': 'en-gb', 'en-au': 'en-au', 'en-ca': 'en-ca',
    'de-de': 'de', 'fr-fr': 'fr', 'fr-ca': 'fr-ca', 'es-es': 'es', 'es-mx': 'es-mx',
    'es-419': 'es-mx', 'pt-pt': 'pt', 'pt-br': 'pt-br', 'zh-hans': 'zh', 'zh-cn': 'zh',
    'zh-hant': 'zh-tw', 'zh-tw': 'zh-tw', 'ar-sa': 'ar', 'nl-nl': 'nl',
    'nb': 'no', 'nb-no': 'no', 'nn': 'no'
};

function normalizeLangCode(raw) {
    if (!raw) return null;
    const c = String(raw).trim().toLowerCase().replace(/_/g, '-');
    if (LANG_CODE_MAP[c]) return LANG_CODE_MAP[c];
    if (typeof languageNames !== 'undefined' && languageNames[c]) return c;
    const base = c.split('-')[0];
    if (typeof languageNames !== 'undefined' && languageNames[base]) return base;
    return null; // not a recognized language
}

// ---- Add every App Store language to the project ----
function addAllAppStoreLanguages() {
    Object.keys(languageNames).forEach(lang => {
        if (!state.projectLanguages.includes(lang)) addProjectLanguage(lang);
    });
    updateLanguagesList();
    updateAddLanguageSelect();
    updateLanguageMenu();
    saveState();
}

// ---- Count screenshots that have an image for a language ----
function countImagesForLanguage(lang) {
    return state.screenshots.filter(s => s.localizedImages && s.localizedImages[lang] && s.localizedImages[lang].image).length;
}

// ---- Assign one image File to a specific language (silent, batch-friendly) ----
function assignImageFileToLanguage(file, lang) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const ratio = img.width / img.height;
                const deviceType = ratio > 0.6 ? 'iPad' : 'iPhone';
                const idx = findScreenshotByBaseFilename(file.name);
                if (idx !== -1) {
                    addLocalizedImage(idx, lang, img, e.target.result, file.name);
                } else {
                    createNewScreenshot(img, e.target.result, file.name, lang, deviceType);
                }
                resolve();
            };
            img.onerror = () => resolve();
            img.src = e.target.result;
        };
        reader.onerror = () => resolve();
        reader.readAsDataURL(file);
    });
}

async function uploadFilesForLanguage(lang, fileList) {
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    if (!state.projectLanguages.includes(lang)) addProjectLanguage(lang);
    // Sort by name so screens line up across languages.
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const f of files) await assignImageFileToLanguage(f, lang);
    updateLanguagesList();
    if (typeof updateScreenshotList === 'function') updateScreenshotList();
    updateCanvas();
    saveState();
}

// ---- Folder import (fastlane-aware): classify by sub-folder name ----
async function importFolderFiles(fileList) {
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    // Decide each file's language from its parent folder, else from its filename.
    const tagged = files.map(f => {
        const rel = f.webkitRelativePath || f.name;
        const parts = rel.split('/');
        let lang = null;
        if (parts.length >= 2) lang = normalizeLangCode(parts[parts.length - 2]);
        if (!lang) lang = detectLanguageFromFilename(f.name);
        if (!lang) lang = 'en';
        return { f, lang };
    });
    // Group by language, sort within each so screens align.
    const byLang = {};
    tagged.forEach(({ f, lang }) => { (byLang[lang] = byLang[lang] || []).push(f); });
    for (const lang of Object.keys(byLang)) {
        if (!state.projectLanguages.includes(lang)) addProjectLanguage(lang);
        byLang[lang].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        for (const f of byLang[lang]) await assignImageFileToLanguage(f, lang);
    }
    updateLanguagesList();
    if (typeof updateScreenshotList === 'function') updateScreenshotList();
    updateCanvas();
    saveState();
    const total = tagged.length;
    const langs = Object.keys(byLang).map(l => `${languageFlags[l] || ''} ${languageNames[l] || l}`).join(', ');
    if (typeof showAppAlert === 'function') showAppAlert(`Imported ${total} image(s) across: ${langs}`, 'info');
}

// ---- CSV text template (export / import) ----
function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function screenshotLabel(i) {
    const s = state.screenshots[i];
    if (s && s.localizedImages) {
        const first = Object.values(s.localizedImages).find(v => v && v.name);
        if (first && first.name) return getBaseFilename(first.name);
    }
    return `Screenshot ${i + 1}`;
}

function downloadTextCsvTemplate() {
    const langs = state.projectLanguages;
    const rows = [['screenshot', 'name', 'language', 'headline', 'subheadline']];
    const count = Math.max(state.screenshots.length, 1);
    for (let i = 0; i < count; i++) {
        const s = state.screenshots[i];
        for (const lang of langs) {
            const headline = s && s.text && s.text.headlines ? (s.text.headlines[lang] || '') : '';
            const sub = s && s.text && s.text.subheadlines ? (s.text.subheadlines[lang] || '') : '';
            rows.push([i + 1, screenshotLabel(i), lang, headline, sub]);
        }
    }
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'appscreen-text.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
}

// Minimal RFC-4180-ish CSV parser (handles quotes, commas, newlines).
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ',') { row.push(field); field = ''; }
            else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
            else if (ch === '\r') { /* skip */ }
            else field += ch;
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function importTextCsv(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const rows = parseCsv(String(e.target.result));
        if (!rows.length) return;
        const header = rows[0].map(h => h.trim().toLowerCase());
        const col = (name) => header.indexOf(name);
        const ci = col('screenshot'), cl = col('language'), ch = col('headline'), cs = col('subheadline');
        if (cl === -1 || (ch === -1 && cs === -1)) {
            if (typeof showAppAlert === 'function') showAppAlert('CSV must have at least: language + headline/subheadline columns.', 'error');
            return;
        }
        let applied = 0;
        for (let r = 1; r < rows.length; r++) {
            const cells = rows[r];
            if (!cells || cells.every(c => c.trim() === '')) continue;
            const idx = ci !== -1 ? (parseInt(cells[ci], 10) - 1) : (r - 1);
            const lang = normalizeLangCode(cells[cl]);
            if (!lang || idx < 0 || idx >= state.screenshots.length) continue;
            if (!state.projectLanguages.includes(lang)) addProjectLanguage(lang);
            const s = state.screenshots[idx];
            s.text.headlines = s.text.headlines || {};
            s.text.subheadlines = s.text.subheadlines || {};
            if (ch !== -1 && cells[ch] !== undefined) {
                s.text.headlines[lang] = cells[ch];
                if (s.text.headlineLanguages && !s.text.headlineLanguages.includes(lang)) s.text.headlineLanguages.push(lang);
            }
            if (cs !== -1 && cells[cs] !== undefined) {
                s.text.subheadlines[lang] = cells[cs];
                if (s.text.subheadlineLanguages && !s.text.subheadlineLanguages.includes(lang)) s.text.subheadlineLanguages.push(lang);
            }
            applied++;
        }
        if (typeof syncUIWithState === 'function') syncUIWithState();
        updateCanvas();
        saveState();
        if (typeof showAppAlert === 'function') showAppAlert(`Applied ${applied} text row(s) from CSV.`, 'info');
    };
    reader.readAsText(file);
}

// ---- Propagate the main language's text/layout to all languages ----
function propagateFromMainLanguage() {
    const main = state.projectLanguages[0];
    if (!main) return;
    state.screenshots.forEach(s => {
        if (!s.text) return;
        s.text.headlines = s.text.headlines || {};
        s.text.subheadlines = s.text.subheadlines || {};
        const h = s.text.headlines[main] || '';
        const sub = s.text.subheadlines[main] || '';
        const layoutMain = s.text.languageSettings ? s.text.languageSettings[main] : null;
        state.projectLanguages.forEach(lang => {
            if (lang === main) return;
            s.text.headlines[lang] = h;
            s.text.subheadlines[lang] = sub;
            if (layoutMain && s.text.languageSettings) {
                s.text.languageSettings[lang] = JSON.parse(JSON.stringify(layoutMain));
            }
        });
    });
}

// Live sync: when enabled and editing the main language, mirror to all others.
if (typeof window !== 'undefined' && typeof setTextValue === 'function') {
    const _origSetTextValue = setTextValue;
    // eslint-disable-next-line no-global-assign
    setTextValue = function (key, value) {
        _origSetTextValue(key, value);
        if (state.syncMainLanguage && state.currentLanguage === state.projectLanguages[0]) {
            propagateFromMainLanguage();
        }
    };
}

// ---- Override updateLanguagesList: language cards + per-language drop zones ----
function updateLanguagesList() {
    const container = document.getElementById('languages-list');
    if (!container) return;
    container.innerHTML = '';

    const chip = document.getElementById('lang-count-chip');
    if (chip) chip.textContent = state.projectLanguages.length;

    state.projectLanguages.forEach((lang, i) => {
        const flag = languageFlags[lang] || '🏳️';
        const name = languageNames[lang] || lang.toUpperCase();
        const isCurrent = lang === state.currentLanguage;
        const isMain = i === 0;
        const isOnly = state.projectLanguages.length === 1;
        const count = countImagesForLanguage(lang);

        const item = document.createElement('div');
        item.className = 'lang-card';
        item.innerHTML = `
            <div class="lang-card-head">
                <div class="lang-flag-tile">${flag}</div>
                <div class="lang-meta">
                    <div class="lang-name-row">
                        <span class="lang-name">${name}</span>
                        ${isMain ? '<span class="lang-badge main">Main</span>' : ''}
                        ${isCurrent ? '<span class="lang-badge current">Current</span>' : ''}
                    </div>
                    <div class="lang-sub">${lang} · ${count} screenshot${count === 1 ? '' : 's'}</div>
                </div>
                <button class="lang-remove" ${isOnly ? 'disabled' : ''} title="${isOnly ? 'Cannot remove the only language' : 'Remove language'}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>
            <div class="lang-dropzone${count > 0 ? ' has-img' : ''}" tabindex="0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                <span>Drop ${name} screenshots here, or click to browse</span>
                <input type="file" accept="image/*" multiple hidden>
            </div>
        `;

        const removeBtn = item.querySelector('.lang-remove');
        if (!isOnly) removeBtn.addEventListener('click', () => removeProjectLanguage(lang));

        const dz = item.querySelector('.lang-dropzone');
        const input = item.querySelector('input[type=file]');
        dz.addEventListener('click', () => input.click());
        dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
        input.addEventListener('change', () => { if (input.files.length) uploadFilesForLanguage(lang, input.files); input.value = ''; });
        ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover'); }));
        ['dragleave', 'dragend'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover'); }));
        dz.addEventListener('drop', (e) => {
            e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover');
            if (e.dataTransfer.files.length) uploadFilesForLanguage(lang, e.dataTransfer.files);
        });

        container.appendChild(item);
    });
}

// ---- Wire up the new buttons once the DOM is ready ----
function initAppStoreFeatures() {
    const addAllBtn = document.getElementById('add-all-languages-btn');
    if (addAllBtn) addAllBtn.addEventListener('click', addAllAppStoreLanguages);

    const syncToggle = document.getElementById('sync-main-language');
    if (syncToggle) {
        syncToggle.checked = !!state.syncMainLanguage;
        syncToggle.addEventListener('change', () => {
            state.syncMainLanguage = syncToggle.checked;
            if (syncToggle.checked) { propagateFromMainLanguage(); updateCanvas(); }
            saveState();
        });
    }
    const propagateBtn = document.getElementById('propagate-main-btn');
    if (propagateBtn) propagateBtn.addEventListener('click', () => {
        propagateFromMainLanguage();
        if (typeof syncUIWithState === 'function') syncUIWithState();
        updateCanvas(); saveState();
        if (typeof showAppAlert === 'function') showAppAlert('Main language copied to all languages.', 'info');
    });

    const csvDownloadBtn = document.getElementById('csv-template-btn');
    if (csvDownloadBtn) csvDownloadBtn.addEventListener('click', downloadTextCsvTemplate);
    const csvImportInput = document.getElementById('csv-import-input');
    const csvImportBtn = document.getElementById('csv-import-btn');
    if (csvImportBtn && csvImportInput) {
        csvImportBtn.addEventListener('click', () => csvImportInput.click());
        csvImportInput.addEventListener('change', () => { if (csvImportInput.files[0]) importTextCsv(csvImportInput.files[0]); csvImportInput.value = ''; });
    }

    const folderInput = document.getElementById('folder-import-input');
    const folderBtn = document.getElementById('folder-import-btn');
    if (folderBtn && folderInput) {
        folderBtn.addEventListener('click', () => folderInput.click());
        folderInput.addEventListener('change', () => { if (folderInput.files.length) importFolderFiles(folderInput.files); folderInput.value = ''; });
    }
}

// ============================================================================
// "All languages" canvas view — one rendered row per language for the current
// screenshot, each a drop zone to upload that language's image.
// ============================================================================
let allLanguagesMode = false;

function assignFileToScreenshotLang(file, idx, lang) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            if (!state.projectLanguages.includes(lang)) addProjectLanguage(lang);
            addLocalizedImage(idx, lang, img, e.target.result, file.name);
            renderAllLanguagesView();
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function renderAllLanguagesView() {
    const view = document.getElementById('all-languages-view');
    if (!view) return;
    view.innerHTML = '';

    const idx = state.selectedIndex;
    const ss = state.screenshots[idx];
    if (idx == null || !ss) {
        view.innerHTML = '<div class="alv-empty">Upload a screenshot to see all languages.</div>';
        return;
    }

    const dims = getCanvasDimensions();
    const rowW = 150;
    const previewScale = rowW / dims.width;

    const savedLang = state.currentLanguage;
    const savedH = ss.text.currentHeadlineLang;
    const savedS = ss.text.currentSubheadlineLang;

    state.projectLanguages.forEach(lang => {
        const hasImg = !!(ss.localizedImages && ss.localizedImages[lang] && ss.localizedImages[lang].image);

        // Temporarily render this screenshot as if `lang` were current.
        state.currentLanguage = lang;
        ss.text.currentHeadlineLang = lang;
        ss.text.currentSubheadlineLang = lang;

        const canvas = document.createElement('canvas');
        try { renderScreenshotToCanvas(idx, canvas, canvas.getContext('2d'), dims, previewScale); } catch (e) {}
        canvas.className = 'alv-canvas';
        canvas.style.width = rowW + 'px';
        canvas.style.height = (rowW * dims.height / dims.width) + 'px';

        const row = document.createElement('div');
        row.className = 'alv-row';
        row.innerHTML = `
            <div class="alv-label">
                <span class="flag">${languageFlags[lang] || '🏳️'}</span>
                <span class="nm">${languageNames[lang] || lang}</span>
                ${lang === state.projectLanguages[0] ? '<span class="alv-main">Main</span>' : ''}
                ${hasImg ? '' : '<span class="alv-missing">no image</span>'}
            </div>`;
        const dz = document.createElement('div');
        dz.className = 'alv-drop' + (hasImg ? '' : ' empty');
        dz.title = 'Drop or click to set the ' + (languageNames[lang] || lang) + ' screenshot';
        dz.appendChild(canvas);
        const hint = document.createElement('div');
        hint.className = 'alv-hint';
        hint.textContent = hasImg ? 'Replace' : 'Drop image';
        dz.appendChild(hint);

        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*'; input.hidden = true;
        dz.appendChild(input);
        dz.addEventListener('click', () => input.click());
        input.addEventListener('change', () => { if (input.files[0]) assignFileToScreenshotLang(input.files[0], idx, lang); });
        ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover'); }));
        ['dragleave', 'dragend'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover'); }));
        dz.addEventListener('drop', (e) => {
            e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover');
            if (e.dataTransfer.files[0]) assignFileToScreenshotLang(e.dataTransfer.files[0], idx, lang);
        });

        row.appendChild(dz);
        view.appendChild(row);
    });

    state.currentLanguage = savedLang;
    ss.text.currentHeadlineLang = savedH;
    ss.text.currentSubheadlineLang = savedS;
}

function setCanvasView(view) {
    allLanguagesMode = view === 'all-languages';
    const strip = document.querySelector('.preview-strip');
    const alv = document.getElementById('all-languages-view');
    if (strip) strip.style.display = allLanguagesMode ? 'none' : '';
    if (alv) alv.style.display = allLanguagesMode ? 'flex' : 'none';
    document.querySelectorAll('#canvas-view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    if (allLanguagesMode) renderAllLanguagesView();
}

// Live-ish refresh: debounced re-render when the canvas updates while in ALV mode.
let _alvTimer = null;
function scheduleAlvRender() {
    if (!allLanguagesMode) return;
    clearTimeout(_alvTimer);
    _alvTimer = setTimeout(renderAllLanguagesView, 180);
}
if (typeof updateCanvas === 'function') {
    const _origUpdateCanvas = updateCanvas;
    // eslint-disable-next-line no-global-assign
    updateCanvas = function () {
        _origUpdateCanvas.apply(this, arguments);
        scheduleAlvRender();
    };
}

function initCanvasViewToggle() {
    document.querySelectorAll('#canvas-view-toggle button').forEach(btn => {
        btn.addEventListener('click', () => setCanvasView(btn.dataset.view));
    });
}

// ============================================================================
// Device notch (2D "Device Model") + text background controls
// ============================================================================
// iPhone vs Samsung corner-radius defaults (slider value; render scales it).
const DEVICE_2D_RADIUS = { iphone: 52, samsung: 34 };

function initDeviceTextExtras() {
    // 2D Device Model (iPhone / Samsung) — auto-adapts corner radius + notch.
    document.querySelectorAll('#device-model-2d-selector button').forEach(btn => {
        btn.addEventListener('click', () => {
            const model = btn.dataset.model2d;
            document.querySelectorAll('#device-model-2d-selector button').forEach(b => b.classList.toggle('active', b === btn));
            setScreenshotSetting('deviceModel2D', model);
            // Adapt corner radius to the model
            const r = DEVICE_2D_RADIUS[model] ?? 24;
            setScreenshotSetting('cornerRadius', r);
            const slider = document.getElementById('corner-radius');
            const val = document.getElementById('corner-radius-value');
            if (slider) slider.value = r;
            if (val) val.textContent = r + 'px';
            // Sensible default notch for the model
            const defNotch = model === 'samsung' ? 'punch' : 'island';
            setScreenshotSetting('frame.notch', defNotch);
            document.querySelectorAll('#notch-selector button').forEach(b => b.classList.toggle('active', b.dataset.notch === defNotch));
            updateCanvas();
        });
    });

    // Device bezel toggle
    const bezelToggle = document.getElementById('bezel-toggle');
    if (bezelToggle) bezelToggle.addEventListener('click', function () {
        this.classList.toggle('active');
        setScreenshotSetting('bezelEnabled', this.classList.contains('active'));
        updateCanvas();
    });

    // Notch / camera selector
    document.querySelectorAll('#notch-selector button').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#notch-selector button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            setScreenshotSetting('frame.notch', btn.dataset.notch);
            updateCanvas();
        });
    });

    // Text background (color + opacity) for headline & subheadline
    const bindBg = (colorId, opacityId, valueId, colorKey, opacityKey) => {
        const color = document.getElementById(colorId);
        const opacity = document.getElementById(opacityId);
        const val = document.getElementById(valueId);
        if (color) color.addEventListener('input', () => { setTextSetting(colorKey, color.value); updateCanvas(); });
        if (opacity) opacity.addEventListener('input', () => {
            const v = parseInt(opacity.value, 10);
            setTextSetting(opacityKey, v);
            if (val) val.textContent = v === 0 ? 'Off' : v + '%';
            updateCanvas();
        });
    };
    bindBg('headline-bg-color', 'headline-bg-opacity', 'headline-bg-opacity-value', 'headlineBgColor', 'headlineBgOpacity');
    bindBg('subheadline-bg-color', 'subheadline-bg-opacity', 'subheadline-bg-opacity-value', 'subheadlineBgColor', 'subheadlineBgOpacity');
}

function syncDeviceTextExtras() {
    const ss = typeof getScreenshotSettings === 'function' ? getScreenshotSettings() : null;
    const txt = typeof getTextSettings === 'function' ? getTextSettings() : null;
    if (ss) {
        const notch = (ss.frame && ss.frame.notch) || 'none';
        document.querySelectorAll('#notch-selector button').forEach(b => b.classList.toggle('active', b.dataset.notch === notch));
        const model2d = ss.deviceModel2D || 'iphone';
        document.querySelectorAll('#device-model-2d-selector button').forEach(b => b.classList.toggle('active', b.dataset.model2d === model2d));
        const bezelToggle = document.getElementById('bezel-toggle');
        if (bezelToggle) bezelToggle.classList.toggle('active', !!ss.bezelEnabled);
        // In 3D, the notch still applies (baked into the texture) but the bezel/model
        // selectors are 2D-only; keep the Notch sub-control visible, hide the rest.
        const group = document.getElementById('device-model-2d-group');
        if (group) group.style.display = 'block';
        const sel = document.getElementById('device-model-2d-selector');
        const bz = bezelToggle ? bezelToggle.closest('.toggle-row') : null;
        if (sel) sel.style.display = ss.use3D ? 'none' : 'flex';
        if (bz) bz.style.display = ss.use3D ? 'none' : 'flex';
    }
    if (txt) {
        const setCtl = (colorId, opacityId, valueId, color, opacity) => {
            const c = document.getElementById(colorId), o = document.getElementById(opacityId), v = document.getElementById(valueId);
            if (c && color) c.value = color;
            if (o) o.value = opacity || 0;
            if (v) v.textContent = (opacity || 0) === 0 ? 'Off' : opacity + '%';
        };
        setCtl('headline-bg-color', 'headline-bg-opacity', 'headline-bg-opacity-value', txt.headlineBgColor || '#000000', txt.headlineBgOpacity || 0);
        setCtl('subheadline-bg-color', 'subheadline-bg-opacity', 'subheadline-bg-opacity-value', txt.subheadlineBgColor || '#000000', txt.subheadlineBgOpacity || 0);
    }
}

// Keep the new controls in sync when the app refreshes the UI (screenshot switch, etc.)
if (typeof syncUIWithState === 'function') {
    const _origSyncUI = syncUIWithState;
    // eslint-disable-next-line no-global-assign
    syncUIWithState = function () {
        _origSyncUI.apply(this, arguments);
        try { syncDeviceTextExtras(); } catch (e) {}
    };
}

function initAllExtras() {
    initAppStoreFeatures();
    initCanvasViewToggle();
    initDeviceTextExtras();
    try { syncDeviceTextExtras(); } catch (e) {}
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAllExtras);
} else {
    initAllExtras();
}
