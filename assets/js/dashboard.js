(function () {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    // ─── STATE ───────────────────────────────────────────────────────────────────
    const state = {
        pdfs: [],
        activeDates: new Set(),
        currentUnit: null,
        pdfDoc: null,
        pdfCurrentPage: 1,
        pdfTotalPages: 1,
        pdfCurrentDateKey: null,
    };
    let overviewChartInst = null, donutRIInst = null, donutRFInst = null, lineHInst = null, lineCInst = null;

    // Initialize Firebase (Compat) - firebaseConfig should be defined in config.js
    if (window.firebaseConfig) {
        firebase.initializeApp(window.firebaseConfig);
    } else {
        console.error("Firebase configuration not found. Make sure config.js is loaded.");
    }
    const dbCloud = firebase.database();
    const stCloud = firebase.storage();

    function setCloudStatus(status) {
        const icon = document.getElementById('cloudIcon');
        if (!icon) return;
        if (status === 'syncing') { icon.textContent = '🔄'; icon.style.animation = 'spin 2s linear infinite'; }
        if (status === 'online') { icon.textContent = '☁️'; icon.style.animation = 'none'; }
        if (status === 'error') { icon.textContent = '⚠️'; icon.style.animation = 'none'; }
        if (status === 'offline') { icon.textContent = '💤'; icon.style.animation = 'none'; }
    }

    async function pushToCloud(entry) {
        setCloudStatus('syncing');
        try {
            const fileRef = stCloud.ref().child(`tms_pdfs/${entry.fileName}`);
            const metadataRef = dbCloud.ref(`tms_metadata/${entry.fileName.replace(/[.#$[\]]/g, '_')}`);

            // 1. Upload PDF bytes to Storage
            const blob = new Blob([entry.pdfBytes], { type: 'application/pdf' });
            await fileRef.put(blob);
            const downloadUrl = await fileRef.getDownloadURL();

            // 2. Upload metadata + rows to Database
            const cloudEntry = {
                fileName: entry.fileName,
                dateStr: entry.dateStr,
                dateTs: entry.dateObj?.getTime() ?? 0,
                rows: entry.rows,
                downloadUrl: downloadUrl,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            };
            await metadataRef.set(cloudEntry);
            setCloudStatus('online');
        } catch (e) {
            console.error('Cloud Push Error:', e);
            setCloudStatus('error');
        }
    }

    async function dbDeleteCloud(fileName) {
        setCloudStatus('syncing');
        try {
            const fileRef = stCloud.ref().child(`tms_pdfs/${fileName}`);
            const metadataRef = dbCloud.ref(`tms_metadata/${fileName.replace(/[.#$[\]]/g, '_')}`);
            await Promise.all([
                fileRef.delete().catch(() => { }), // Ignore error if already gone
                metadataRef.remove()
            ]);
            setCloudStatus('online');
        } catch (e) {
            console.error('Cloud Delete Error:', e);
            setCloudStatus('error');
        }
    }

    async function dbClearCloud() {
        setCloudStatus('syncing');
        try {
            // Clearing database is easy
            await dbCloud.ref('tms_metadata').remove();
            // Clearing storage is harder (iterative), usually requires listing.
            // For simplicity, we just clear the metadata which effectively removes them from apps.
            setCloudStatus('online');
        } catch (e) {
            setCloudStatus('error');
        }
    }

    async function pullFromCloud() {
        setCloudStatus('syncing');
        try {
            const snapshot = await dbCloud.ref('tms_metadata').once('value');
            const data = snapshot.val();
            if (!data) { setCloudStatus('online'); return; }

            let newItems = 0;
            for (const key in data) {
                const cloudEntry = data[key];
                // Check if we already have it locally
                if (state.pdfs.find(p => p.fileName === cloudEntry.fileName)) continue;

                // Download PDF bytes if missing
                const response = await fetch(cloudEntry.downloadUrl);
                const bytes = await response.arrayBuffer();

                const entry = {
                    fileName: cloudEntry.fileName,
                    dateStr: cloudEntry.dateStr,
                    dateObj: new Date(cloudEntry.dateTs),
                    rows: cloudEntry.rows,
                    pdfBytes: bytes
                };

                state.pdfs.push(entry);
                state.activeDates.add(entry.dateStr);
                await dbSave(entry); // Save to local IndexedDB too
                newItems++;
            }
            if (newItems > 0) {
                renderUI();
                showToast(`☁️ ${newItems} parte(s) sincronizado(s) desde la nube`, 'success');
            }
            setCloudStatus('online');
        } catch (e) {
            console.error('Cloud Pull Error:', e);
            setCloudStatus('error');
        }
    }

    // ─── INDEXEDDB PERSISTENCE ────────────────────────────────────────────────────
    const DB_NAME = 'tms-dashboard', DB_STORE = 'pdfs', DB_VER = 1;
    let db = null;

    function openDB() {
        return new Promise((res, rej) => {
            const req = indexedDB.open(DB_NAME, DB_VER);
            req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE, { keyPath: 'fileName' });
            req.onsuccess = e => { db = e.target.result; res(db); };
            req.onerror = e => rej(e.target.error);
        });
    }

    async function dbSave(pdfEntry) {
        if (!db) return;
        // dateObj is not serializable directly — store as timestamp
        const record = { ...pdfEntry, dateTs: pdfEntry.dateObj?.getTime() ?? 0 };
        delete record.dateObj;
        return new Promise((res, rej) => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).put(record);
            tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
        });
    }

    async function dbDelete(fileName) {
        if (!db) return;
        return new Promise((res, rej) => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).delete(fileName);
            tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
        });
    }

    async function dbClear() {
        if (!db) return;
        return new Promise((res, rej) => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).clear();
            tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
        });
    }

    async function dbLoadAll() {
        if (!db) return [];
        return new Promise((res, rej) => {
            const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
            req.onsuccess = e => res(e.target.result);
            req.onerror = e => rej(e.target.error);
        });
    }

    // Startup: open DB then restore any previously saved PDFs
    async function initDB() {
        try {
            await openDB();
            const saved = await dbLoadAll();
            if (saved.length) {
                showLoading(true);
                for (const rec of saved) {
                    rec.dateObj = new Date(rec.dateTs);
                    delete rec.dateTs;
                    state.pdfs.push(rec);
                    state.activeDates.add(rec.dateStr);
                }
                showLoading(false);
                renderUI();
                showToast(`📂 ${saved.length} parte(s) restaurado(s) desde el almacenamiento local`, 'success');
            }
            // After loading local data, sync with cloud
            pullFromCloud();
        } catch (e) {
            console.warn('IndexedDB no disponible, los datos no persistirán:', e);
            pullFromCloud();
        }
    }
    initDB();

    // ─── UPLOAD ───────────────────────────────────────────────────────────────────
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');

    if (uploadZone) {
        uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
        uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
        uploadZone.addEventListener('drop', e => { e.preventDefault(); uploadZone.classList.remove('drag-over'); handleFiles([...e.dataTransfer.files]); });
    }
    if (fileInput) {
        fileInput.addEventListener('change', () => handleFiles([...fileInput.files]));
    }

    async function handleFiles(files) {
        const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
        if (!pdfs.length) { showToast('Solo se aceptan archivos PDF', 'error'); return; }
        showLoading(true);
        for (const file of pdfs) {
            if (state.pdfs.find(p => p.fileName === file.name)) { showToast(`"${file.name}" ya fue cargado`, 'error'); continue; }
            try {
                const bytes = await readBytes(file);
                const parsed = await parsePDF(bytes, file.name);
                if (parsed) {
                    const entry = { ...parsed, pdfBytes: bytes, fileName: file.name };
                    state.pdfs.push(entry);
                    state.activeDates.add(parsed.dateStr);
                    await dbSave(entry);          // 💾 persist to IndexedDB
                    pushToCloud(entry);           // ☁️ push to Firebase
                    showToast(`✅ ${file.name} — ${parsed.rows.length} unidades`, 'success');
                }
            } catch (e) { showToast(`❌ Error al procesar "${file.name}"`, 'error'); console.error(e); }
        }
        if (fileInput) fileInput.value = '';
        showLoading(false);
        renderUI();
    }

    function readBytes(file) {
        return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = e => res(e.target.result); fr.onerror = rej; fr.readAsArrayBuffer(file); });
    }

    // ─── PDF PARSER v2 — SPATIAL COLUMN DETECTION ────────────────────────────────
    const NRO_REGEX = /^1[.,]\d{3}$/;

    async function parsePDF(bytes, fileName) {
        const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;

        // 1. Extract date from first page ─────────────────────────────────────────
        let dateStr = '', dateObj = null;
        {
            const firstPage = await pdf.getPage(1);
            const ct = await firstPage.getTextContent();
            const flat = ct.items.map(i => i.str).join(' ');
            // Try "10/2/2026"
            let m = flat.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
            if (m) {
                const [, d, mo, y] = m.map(Number);
                dateObj = new Date(y, mo - 1, d);
                dateStr = fmt(d, mo, y);
            } else {
                // Try "10 2 2.026" pattern following "Fecha:"
                m = flat.match(/Fecha[:\s]+(\d{1,2})\s+(\d{1,2})\s+([\d.]+)/i);
                if (m) {
                    const d = +m[1], mo = +m[2];
                    const y = parseInt(m[3].replace(/\./g, '').padStart(4, '20'));
                    dateObj = new Date(y, mo - 1, d); dateStr = fmt(d, mo, y);
                }
            }
            // Fallback: filename "DD.MM.YYYY"
            if (!dateStr) {
                m = fileName.match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
                if (m) { const d = +m[1], mo = +m[2], y = +m[3]; dateObj = new Date(y, mo - 1, d); dateStr = fmt(d, mo, y); }
                else { dateStr = fileName; dateObj = new Date(); }
            }
        }

        // 2. Extract rows (one page at a time, spatial columns) ───────────────────
        const rows = [];
        for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const ct = await page.getTextContent();

            const items = ct.items
                .map(it => ({ str: it.str.trim(), x: Math.round(it.transform[4]), y: Math.round(it.transform[5]) }))
                .filter(it => it.str.length > 0);

            const lineMap = new Map();
            for (const it of items) {
                let placed = false;
                for (const [ky, arr] of lineMap) {
                    if (Math.abs(ky - it.y) <= 4) { arr.push(it); placed = true; break; }
                }
                if (!placed) lineMap.set(it.y, [it]);
            }
            const lines = [...lineMap.entries()]
                .sort((a, b) => b[0] - a[0])
                .map(([, its]) => its.sort((a, b) => a.x - b.x));

            let headerIdx = -1;
            let colX = null;
            for (let i = 0; i < lines.length; i++) {
                const s = lines[i].map(it => it.str).join(' ');
                if (/nro|interno/i.test(s) && /ronda/i.test(s)) {
                    headerIdx = i;
                    const hi = [...lines[i], ...(lines[i + 1] ?? [])];
                    const fx = re => hi.find(it => re.test(it.str))?.x;
                    colX = {
                        nroX: fx(/^(nro|interno)$/i) ?? 40,
                        rondaIX: fx(/^(ronda|inicial)$/i) ?? 100,
                        estadoX: fx(/^(estado)$/i) ?? 180,
                        descX: fx(/^(descripcion|descripción)$/i) ?? 280,
                        horasX: fx(/^(horas|toma|fuerza)$/i) ?? 455,
                        ciclosX: fx(/^ciclos$/i) ?? 520,
                    };
                    break;
                }
            }
            if (headerIdx === -1 || !colX) continue;

            const blocks = [];
            let cur = null;
            for (let i = headerIdx + 1; i < lines.length; i++) {
                const line = lines[i];
                const nroItem = line.find(it => NRO_REGEX.test(it.str) && it.x <= colX.rondaIX + 10);
                if (nroItem) {
                    if (cur) blocks.push(cur);
                    cur = { nroStr: nroItem.str, items: [...line] };
                } else if (cur) {
                    cur.items.push(...line);
                }
            }
            if (cur) blocks.push(cur);

            for (const block of blocks) {
                const nro = block.nroStr.replace(/[.,]/g, '');
                const all = block.items;
                const col = (minX, maxX) =>
                    all.filter(it => it.x >= minX && it.x < maxX).map(it => it.str).join(' ').trim();

                const descStartX = colX.estadoX + 90;
                const rondaIText = col(colX.rondaIX, colX.estadoX);
                const estadoFText = col(colX.estadoX, descStartX);
                const descText = col(descStartX, colX.horasX - 10);
                const horasText = col(colX.horasX - 10, colX.ciclosX);
                const ciclosText = col(colX.ciclosX, 9999);

                rows.push({
                    nroInterno: nro,
                    rondaInicial: statusFromText(rondaIText),
                    estadoFinal: statusFromText(estadoFText),
                    horas: parseSpanishNum(horasText),
                    ciclos: parseSpanishNum(ciclosText),
                    descripcion: descText.substring(0, 300),
                });
            }
        }
        return { dateStr, dateObj, rows };
    }

    function fmt(d, m, y) {
        return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
    }

    function statusFromText(text) {
        const t = text.toLowerCase();
        if (t.includes('fuera de servicio')) return 'Fuera de servicio';
        if (t.includes('no presente')) return 'No presente';
        if (t.includes('operativo')) return 'Operativo';
        return 'Desconocido';
    }

    function parseSpanishNum(text) {
        if (!text || !text.trim()) return null;
        const raw = text.trim().split(/\s/)[0];
        if (!raw) return null;
        if (/^\d{1,3}\.\d{3}$/.test(raw)) return parseInt(raw.replace('.', ''), 10);
        if (/^(\d{1,3}\.)+\d{3}$/.test(raw)) return parseInt(raw.replace(/\./g, ''), 10);
        if (/^\d+$/.test(raw)) return parseInt(raw, 10);
        const n = parseFloat(raw.replace(',', '.'));
        return isNaN(n) ? null : n;
    }

    // ─── RENDER UI ────────────────────────────────────────────────────────────────
    function renderUI() {
        renderFileChips();
        renderFilterBar();
        renderOverview();
        updateHeaderStats();
        const clearBtn = document.getElementById('clearAllBtn');
        if (clearBtn) clearBtn.style.display = state.pdfs.length ? 'inline-flex' : 'none';
    }

    function renderFileChips() {
        const list = document.getElementById('filesList');
        if (!list) return;
        list.innerHTML = state.pdfs.map((p, i) => `
    <div class="file-chip">
      <div class="file-chip-dot"></div>
      <span>${p.fileName}</span>
      <span style="color:var(--text-muted);font-size:11px;">${p.dateStr}</span>
      <span class="file-chip-remove" onclick="removePdf(${i})">×</span>
    </div>`).join('');
    }

    window.removePdf = function (idx) {
        const removed = state.pdfs.splice(idx, 1)[0];
        dbDelete(removed.fileName);
        dbDeleteCloud(removed.fileName);
        state.activeDates.delete(removed.dateStr);
        state.pdfs.forEach(p => state.activeDates.add(p.dateStr));
        renderUI();
    }

    window.clearAll = async function () {
        if (!confirm('¿Eliminar todos los PDFs guardados (LOCAL y NUBE)?')) return;
        await Promise.all([dbClear(), dbClearCloud()]);
        state.pdfs = []; state.activeDates.clear(); state.currentUnit = null;
        document.getElementById('overviewSection').style.display = 'block';
        document.getElementById('detailSection').style.display = 'none';
        renderUI();
        showToast('🗑️ Todos los datos fueron eliminados', 'success');
    }

    function renderFilterBar() {
        const bar = document.getElementById('filterBar');
        if (!bar) return;
        if (!state.pdfs.length) { bar.style.display = 'none'; return; }
        bar.style.display = 'flex';
        const sorted = [...new Set(state.pdfs.map(p => p.dateStr))].sort((a, b) => dateFromStr(a) - dateFromStr(b));
        document.getElementById('filterDates').innerHTML = sorted.map(d =>
            `<button class="date-chip ${state.activeDates.has(d) ? 'active' : ''}" onclick="toggleDate('${d}')">${d}</button>`
        ).join('');
        document.getElementById('btnAllDates').className = 'date-chip' + (state.activeDates.size === sorted.length ? ' active' : '');
    }

    function dateFromStr(s) {
        const [d, m, y] = s.split('/').map(Number); return new Date(y, m - 1, d).getTime();
    }

    window.toggleDate = function (d) {
        if (state.activeDates.has(d)) { if (state.activeDates.size > 1) state.activeDates.delete(d); }
        else state.activeDates.add(d);
        renderFilterBar(); renderOverview();
        if (state.currentUnit) renderDetail(state.currentUnit);
    }
    window.selectAllDates = function () {
        state.pdfs.forEach(p => state.activeDates.add(p.dateStr));
        renderFilterBar(); renderOverview();
        if (state.currentUnit) renderDetail(state.currentUnit);
    }

    function getFilteredPdfs() { return state.pdfs.filter(p => state.activeDates.has(p.dateStr)); }
    function getFilteredRows() { return getFilteredPdfs().flatMap(p => p.rows.map(r => ({ ...r, dateStr: p.dateStr, dateObj: p.dateObj }))); }

    function renderOverview() {
        const empty = document.getElementById('emptyState');
        const chartCard = document.getElementById('overviewChartCard');
        const statRow = document.getElementById('globalStatRow');
        if (!empty || !chartCard || !statRow) return;
        if (!state.pdfs.length) { empty.style.display = 'block'; chartCard.style.display = 'none'; statRow.style.display = 'none'; return; }
        empty.style.display = 'none'; chartCard.style.display = 'block'; statRow.style.display = 'flex';

        const rows = getFilteredRows();
        document.getElementById('gStatOp').textContent = rows.filter(r => r.estadoFinal === 'Operativo').length;
        document.getElementById('gStatFs').textContent = rows.filter(r => r.estadoFinal === 'Fuera de servicio').length;
        document.getElementById('gStatNp').textContent = rows.filter(r => r.estadoFinal === 'No presente').length;

        const units = [...new Set(rows.map(r => r.nroInterno))].sort((a, b) => +a - (+b));
        const opD = units.map(u => rows.filter(r => r.nroInterno === u && r.estadoFinal === 'Operativo').length);
        const fsD = units.map(u => rows.filter(r => r.nroInterno === u && r.estadoFinal === 'Fuera de servicio').length);
        const npD = units.map(u => rows.filter(r => r.nroInterno === u && r.estadoFinal === 'No presente').length);

        const canvas = document.getElementById('overviewChart');
        if (!canvas) return;
        if (overviewChartInst) overviewChartInst.destroy();
        overviewChartInst = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: units.map(u => `U${u}`), datasets: [
                    { label: '✅ Operativo', data: opD, backgroundColor: 'rgba(52,211,153,0.75)', borderRadius: 6, borderSkipped: false },
                    { label: '✖ Fuera de servicio', data: fsD, backgroundColor: 'rgba(248,113,113,0.75)', borderRadius: 6, borderSkipped: false },
                    { label: '📌 No presente', data: npD, backgroundColor: 'rgba(251,191,36,0.75)', borderRadius: 6, borderSkipped: false },
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: true,
                plugins: {
                    legend: { labels: { color: '#8892b0', font: { family: 'Inter', size: 12 } } },
                    tooltip: { callbacks: { title: c => `Unidad ${units[c[0].dataIndex]}` } }
                },
                scales: {
                    x: { ticks: { color: '#8892b0', font: { family: 'Inter' } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: { ticks: { color: '#8892b0', font: { family: 'Inter' }, stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true }
                },
                onClick: (_, el) => { if (el.length) openUnit(units[el[0].index]); },
                onHover: (_, el) => { canvas.style.cursor = el.length ? 'pointer' : 'default'; }
            }
        });
    }

    function updateHeaderStats() {
        const rows = getFilteredRows();
        const hStatPdfs = document.getElementById('hStatPdfs');
        const hStatUnits = document.getElementById('hStatUnits');
        const hStatOp = document.getElementById('hStatOp');
        if (hStatPdfs) hStatPdfs.textContent = state.pdfs.length;
        if (hStatUnits) hStatUnits.textContent = [...new Set(rows.map(r => r.nroInterno))].length;
        if (hStatOp) hStatOp.textContent = rows.filter(r => r.estadoFinal === 'Operativo').length;
    }

    // ─── DETAIL VIEW ──────────────────────────────────────────────────────────────
    window.openUnit = function (unitId) {
        state.currentUnit = unitId;
        state.pdfCurrentDateKey = null;
        document.getElementById('overviewSection').style.display = 'none';
        document.getElementById('detailSection').style.display = 'block';
        renderDetail(unitId);
    }
    window.goBack = function () {
        state.currentUnit = null; state.pdfCurrentDateKey = null;
        document.getElementById('overviewSection').style.display = 'block';
        document.getElementById('detailSection').style.display = 'none';
        const cv = document.getElementById('pdfCanvas');
        if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    }

    function renderDetail(unitId) {
        document.getElementById('detailUnitName').textContent = unitId;
        const allRows = getFilteredRows();
        const unitRows = allRows.filter(r => r.nroInterno === unitId).sort((a, b) => a.dateObj - b.dateObj);

        const op = unitRows.filter(r => r.estadoFinal === 'Operativo').length;
        const fs = unitRows.filter(r => r.estadoFinal === 'Fuera de servicio').length;
        const np = unitRows.filter(r => r.estadoFinal === 'No presente').length;
        document.getElementById('dStatOp').textContent = op;
        document.getElementById('dStatFs').textContent = fs;
        document.getElementById('dStatNp').textContent = np;

        const cntStatus = (rows, field) => {
            const c = { 'Operativo': 0, 'Fuera de servicio': 0, 'No presente': 0 };
            rows.forEach(r => { if (c[r[field]] !== undefined) c[r[field]]++; });
            return c;
        };
        const riC = cntStatus(unitRows, 'rondaInicial');
        const rfC = cntStatus(unitRows, 'estadoFinal');
        const dColors = ['rgba(52,211,153,0.8)', 'rgba(248,113,113,0.8)', 'rgba(251,191,36,0.8)'];
        const dLabels = ['Operativo', 'Fuera de servicio', 'No presente'];
        const mkDonut = (ctxId, counts, inst) => {
            const canvas = document.getElementById(ctxId);
            if (!canvas) return null;
            if (inst) inst.destroy();
            return new Chart(canvas.getContext('2d'), {
                type: 'doughnut',
                data: { labels: dLabels, datasets: [{ data: dLabels.map(l => counts[l]), backgroundColor: dColors, borderWidth: 0, hoverOffset: 6 }] },
                options: {
                    responsive: true, maintainAspectRatio: true, cutout: '65%',
                    plugins: { legend: { position: 'bottom', labels: { color: '#8892b0', font: { family: 'Inter', size: 11 }, padding: 12 } } }
                }
            });
        };
        donutRIInst = mkDonut('donutRondaInicial', riC, donutRIInst);
        donutRFInst = mkDonut('donutRondaFinal', rfC, donutRFInst);

        const dates = unitRows.map(r => r.dateStr);
        const horas = unitRows.map(r => r.horas ?? null);
        const ciclos = unitRows.map(r => r.ciclos ?? null);

        const mkLine = (canvasId, label, data, color, inst) => {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return null;
            if (inst) inst.destroy();
            return new Chart(canvas.getContext('2d'), {
                type: 'line',
                data: { labels: dates, datasets: [{ label, data, borderColor: color, backgroundColor: color.replace('1)', '0.1)'), tension: 0.3, pointRadius: 5, pointHoverRadius: 7, fill: true, spanGaps: true }] },
                options: {
                    responsive: true, maintainAspectRatio: true,
                    plugins: { legend: { labels: { color: '#8892b0', font: { family: 'Inter', size: 11 } } } },
                    scales: {
                        x: { ticks: { color: '#8892b0', font: { family: 'Inter', size: 11 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                        y: { ticks: { color: '#8892b0', font: { family: 'Inter', size: 11 } }, grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true }
                    }
                }
            });
        };
        lineHInst = mkLine('lineHoras', 'Horas TDF', horas, 'rgba(6,182,212,1)', lineHInst);
        lineCInst = mkLine('lineCiclos', 'Ciclos', ciclos, 'rgba(129,140,248,1)', lineCInst);

        document.getElementById('historicoBody').innerHTML = unitRows.map(r => `
    <tr>
      <td>${r.dateStr}</td>
      <td>${mkBadge(r.rondaInicial)}</td>
      <td>${mkBadge(r.estadoFinal)}</td>
      <td>${r.horas !== null ? r.horas.toLocaleString('es-AR') : '—'}</td>
      <td>${r.ciclos !== null ? r.ciclos.toLocaleString('es-AR') : '—'}</td>
      <td style="color:var(--text-secondary);font-size:12px;max-width:320px;">${r.descripcion || '—'}</td>
    </tr>`).join('');

        const pdfsForUnit = getFilteredPdfs().filter(p => p.rows.some(r => r.nroInterno === unitId));
        document.getElementById('pdfDateSelector').innerHTML = pdfsForUnit.map(p => `
    <button class="pdf-date-btn ${state.pdfCurrentDateKey === p.dateStr ? 'active' : ''}"
      onclick="loadPdfViewer('${p.dateStr}')">${p.dateStr}</button>`).join('');
        if (pdfsForUnit.length && !state.pdfCurrentDateKey) loadPdfViewer(pdfsForUnit[0].dateStr);
        else if (state.pdfCurrentDateKey) loadPdfViewer(state.pdfCurrentDateKey);
    }

    function mkBadge(status) {
        const cls = { Operativo: 'operative', 'Fuera de servicio': 'outofservice', 'No presente': 'absent' }[status] || 'absent';
        const icon = { Operativo: '✅', 'Fuera de servicio': '✖', 'No presente': '📌' }[status] || '?';
        return `<span class="badge ${cls}">${icon} ${status}</span>`;
    }

    // ─── PDF VIEWER ────────────────────────────────────────────────────────────────
    window.loadPdfViewer = async function (dateStr) {
        state.pdfCurrentDateKey = dateStr;
        document.querySelectorAll('.pdf-date-btn').forEach(b => b.classList.toggle('active', b.textContent.trim() === dateStr));
        const pdfEntry = state.pdfs.find(p => p.dateStr === dateStr);
        if (!pdfEntry) return;
        showLoading(true);
        try {
            state.pdfDoc = await pdfjsLib.getDocument({ data: pdfEntry.pdfBytes.slice(0) }).promise;
            state.pdfCurrentPage = 1; state.pdfTotalPages = state.pdfDoc.numPages;
            await renderPdfPage();
            document.getElementById('pdfNav').style.display = state.pdfTotalPages > 1 ? 'flex' : 'none';
            updatePdfNav();
        } catch (e) { showToast('❌ Error al cargar el PDF', 'error'); console.error(e); }
        showLoading(false);
    }

    async function renderPdfPage() {
        if (!state.pdfDoc) return;
        const page = await state.pdfDoc.getPage(state.pdfCurrentPage);
        const vp = page.getViewport({ scale: window.devicePixelRatio > 1 ? 1.8 : 1.4 });
        const canvas = document.getElementById('pdfCanvas');
        if (!canvas) return;
        canvas.height = vp.height; canvas.width = vp.width; canvas.style.maxWidth = '100%';
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        document.getElementById('pdfPageInfo').textContent = `Página ${state.pdfCurrentPage} / ${state.pdfTotalPages}`;
    }
    window.pdfChangePage = async function (delta) {
        const n = state.pdfCurrentPage + delta;
        if (n < 1 || n > state.pdfTotalPages) return;
        state.pdfCurrentPage = n; await renderPdfPage(); updatePdfNav();
    }
    function updatePdfNav() {
        const prev = document.getElementById('pdfPrevBtn');
        const next = document.getElementById('pdfNextBtn');
        if (prev) prev.disabled = state.pdfCurrentPage === 1;
        if (next) next.disabled = state.pdfCurrentPage === state.pdfTotalPages;
    }

    // ─── UTILS ────────────────────────────────────────────────────────────────────
    window.showToast = function (msg, type = 'success') {
        const c = document.getElementById('toastContainer');
        if (!c) return;
        const t = document.createElement('div'); t.className = `toast ${type}`; t.innerHTML = msg;
        c.appendChild(t); setTimeout(() => t.remove(), 4000);
    }
    window.showLoading = function (show) {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.classList.toggle('show', show);
    }
})();
