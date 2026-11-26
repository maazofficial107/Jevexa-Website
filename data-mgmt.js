/**
 * JEVEXA AI Studio - Data Management Workspace Controller
 * Handles data cleaning, deduplication (exact & fuzzy), schema normalization (dates, emails, phone numbers),
 * anomaly detection, before-and-after diff inspection, and CSV/JSON export.
 */
(() => {
    'use strict';

    const bindSafe = (target, type, handler, options) => {
        if (!target) return;
        if (window.JEVEXA_SAFE_INTERACTION?.bind) {
            window.JEVEXA_SAFE_INTERACTION.bind(target, type, handler, options);
        } else {
            target.addEventListener(type, handler, options?.listenerOptions);
        }
    };

    function generateUuid() {
        if (typeof window.crypto?.randomUUID === 'function') {
            try { return window.crypto.randomUUID(); } catch (_) {}
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    function downloadFile(filename, content, mimeType = 'text/plain;charset=utf-8;') {
        const blob = new Blob([content], { type: mimeType });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    }

    const SAMPLE_DATASETS = {
        messy_leads: `Name,Email,Phone,Created_Date,Deal_Value
Alex Rivera,ALEX@CLOUDSCALE.IO,14155552671,11/04/2026,$15000
Sarah Chen , sarah.chen@fintech.co ,(415) 555-8902, 2026-11-08 , 28500
Alex Rivera,alex@cloudscale.io, 415-555-2671 ,11/04/2026,$15000
Marcus Vance,marcus.invalid-email,555-3419,15/11/2026,-500
Elena Rostova, elena@nexus.com , +1 (212) 555-9124 , 11-12-2026 , $42000
Sarah Chen,sarah.chen@fintech.co,4155558902,11/08/2026,28500`,

        ecommerce_orders: `Order_ID,Customer,Email,Order_Date,Amount,Status
ORD-101,John Miller,JOHN@GMAIL.COM,10/24/2026,149.99,Completed
ORD-102,Lisa Wong,lisa.wong@yahoo.com,2026-10-25,89.50,Shipped
ORD-103,David Smith,dsmith@company.org,10/26/2026,340.00,Delivered
ORD-101,John Miller,john@gmail.com,10/24/2026,149.99,Completed
ORD-104,Emma Watson,not-an-email,10/28/2026,45.00,Pending`
    };

    function parseDelimitedRecords(csvText) {
        const cleanText = String(csvText || '').replace(/^\uFEFF/, '').trim();
        if (!cleanText) return { headers: [], rows: [] };

        let firstLine = '';
        let inHeaderQuote = false;
        for (let i = 0; i < cleanText.length; i++) {
            const ch = cleanText[i];
            if (ch === '"') {
                if (inHeaderQuote && cleanText[i + 1] === '"') { i++; continue; }
                inHeaderQuote = !inHeaderQuote;
            } else if ((ch === '\n' || ch === '\r') && !inHeaderQuote) {
                firstLine = cleanText.slice(0, i);
                break;
            }
        }
        if (!firstLine) firstLine = cleanText;
        const delimiter = firstLine.includes('\t') ? '\t' : (firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',');

        const parsedRows = [];
        let row = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < cleanText.length; i++) {
            const char = cleanText[i];
            if (char === '"') {
                if (inQuotes && cleanText[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === delimiter && !inQuotes) {
                row.push(current.trim());
                current = '';
            } else if ((char === '\r' || char === '\n') && !inQuotes) {
                if (char === '\r' && cleanText[i + 1] === '\n') i++;
                row.push(current.trim());
                if (row.some(cell => cell !== '')) parsedRows.push(row);
                row = [];
                current = '';
            } else {
                current += char;
            }
        }
        row.push(current.trim());
        if (row.some(cell => cell !== '')) parsedRows.push(row);
        if (parsedRows.length < 2) return { headers: [], rows: [] };
        return { headers: parsedRows[0], rows: parsedRows.slice(1) };
    }

    function cleanDatasetLocally(csvText, operations = {}, dedupKey = 'Email') {
        const { headers, rows: rawRows } = parseDelimitedRecords(csvText);
        if (!headers.length || !rawRows.length) {
            return {
                records: [],
                summary: { originalCount: 0, cleanedCount: 0, duplicatesRemoved: 0, emailsCleaned: 0, datesFixed: 0, anomaliesDetected: 0 },
                anomalies: []
            };
        }

        const originalCount = rawRows.length;

        let duplicatesRemoved = 0;
        let emailsCleaned = 0;
        let datesFixed = 0;
        let anomaliesDetected = 0;

        const seenKeys = new Set();
        const cleanedRecords = [];
        const anomalies = [];

        // Identify key column index
        let dedupColIndex = headers.findIndex(h => h.toLowerCase() === (dedupKey || '').toLowerCase());
        if (dedupColIndex === -1) {
            dedupColIndex = headers.findIndex(h => /email|id|order|name/i.test(h));
        }

        rawRows.forEach((cols, rowIndex) => {
            const rowNumber = rowIndex + 2;

            const record = {};
            let isAnomaly = false;

            headers.forEach((h, colIdx) => {
                let val = cols[colIdx] || '';

                // Clean whitespace
                if (operations.cleanWhitespace !== false) {
                    val = val.replace(/\s+/g, ' ').trim();
                }

                // Email normalization
                if (operations.normalizeEmails !== false && /email/i.test(h)) {
                    const originalEmail = val;
                    val = val.toLowerCase().trim();
                    if (val !== originalEmail) emailsCleaned++;

                    if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
                        anomalies.push({ row: rowNumber, column: h, value: val, reason: 'Invalid email format' });
                        anomaliesDetected++;
                        isAnomaly = true;
                    }
                }

                // Phone formatting (E.164)
                if (operations.formatPhones !== false && /phone/i.test(h)) {
                    const digits = val.replace(/\D/g, '');
                    if (digits.length === 10) {
                        val = `+1${digits}`;
                    } else if (digits.length === 11 && digits.startsWith('1')) {
                        val = `+${digits}`;
                    } else if (digits.length >= 7) {
                        val = `+${digits}`;
                    }
                }

                // Date normalization (ISO 8601: YYYY-MM-DD)
                if (operations.normalizeDates !== false && /date/i.test(h)) {
                    const dateMatch = val.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
                    if (dateMatch) {
                        const n1 = parseInt(dateMatch[1], 10);
                        const n2 = parseInt(dateMatch[2], 10);
                        const yr = dateMatch[3];
                        const month = n1 > 12 ? String(n2).padStart(2, '0') : String(n1).padStart(2, '0');
                        const day = n1 > 12 ? String(n1).padStart(2, '0') : String(n2).padStart(2, '0');
                        val = `${yr}-${month}-${day}`;
                        datesFixed++;
                    }
                }

                // Deal value / Amount anomaly detection
                if (operations.detectAnomalies !== false && /value|amount|price/i.test(h)) {
                    const cleanNum = val.replace(/[\$,]/g, '');
                    const num = parseFloat(cleanNum);
                    if (!isNaN(num) && num < 0) {
                        anomalies.push({ row: rowNumber, column: h, value: val, reason: 'Negative monetary value' });
                        anomaliesDetected++;
                        isAnomaly = true;
                    }
                    if (val.startsWith('$')) {
                        val = cleanNum; // Standardize currency
                    }
                }

                record[h] = val;
            });

            // Deduplication
            if (operations.deduplicate !== false) {
                const uniqueKey = dedupColIndex !== -1
                    ? (record[headers[dedupColIndex]] || '').toLowerCase()
                    : Object.values(record).join('|').toLowerCase();

                if (uniqueKey && seenKeys.has(uniqueKey)) {
                    duplicatesRemoved++;
                    return; // Skip duplicate record
                }
                if (uniqueKey) seenKeys.add(uniqueKey);
            }

            cleanedRecords.push(record);
        });

        return {
            records: cleanedRecords,
            summary: {
                originalCount,
                cleanedCount: cleanedRecords.length,
                duplicatesRemoved,
                emailsCleaned,
                datesFixed,
                anomaliesDetected
            },
            anomalies
        };
    }

    const state = {
        cleanedRecords: [],
        rawRecords: [],
        anomalies: [],
        summary: null,
        activeTab: 'cleaned',
        isProcessing: false
    };

    // DOM Elements
    const workspace = document.getElementById('dataWorkspace');
    const backBtn = document.getElementById('dataBackToStudio');
    const closeBtn = document.getElementById('dataWorkspaceClose');

    const pasteInput = document.getElementById('dataPasteInput');
    const fileInput = document.getElementById('dataFileInput');
    const presetSelect = document.getElementById('dataPresetSelect');
    const processBtn = document.getElementById('dataProcessBtn');
    const statusEl = document.getElementById('dataStatus');

    // Operation checkboxes
    const opDedup = document.getElementById('dataOpDedup');
    const opWhitespace = document.getElementById('dataOpWhitespace');
    const opEmails = document.getElementById('dataOpEmails');
    const opPhones = document.getElementById('dataOpPhones');
    const opDates = document.getElementById('dataOpDates');
    const opAnomalies = document.getElementById('dataOpAnomalies');
    const dedupKeySelect = document.getElementById('dataDedupKey');

    // Summary Counter Elements
    const countOriginalEl = document.getElementById('dataCountOriginal');
    const countCleanedEl = document.getElementById('dataCountCleaned');
    const countDuplicatesEl = document.getElementById('dataCountDuplicates');
    const countEmailsEl = document.getElementById('dataCountEmails');
    const countDatesEl = document.getElementById('dataCountDates');
    const countAnomaliesEl = document.getElementById('dataCountAnomalies');

    // Tabs & Panes
    const tabCleaned = document.getElementById('dataTabCleaned');
    const tabRaw = document.getElementById('dataTabRaw');
    const tabAnomalies = document.getElementById('dataTabAnomalies');
    const paneCleaned = document.getElementById('dataPaneCleaned');
    const paneRaw = document.getElementById('dataPaneRaw');
    const paneAnomalies = document.getElementById('dataPaneAnomalies');

    // Table Elements
    const cleanedTableHead = document.getElementById('dataCleanedTableHead');
    const cleanedTableBody = document.getElementById('dataCleanedTableBody');
    const rawTableView = document.getElementById('dataRawTableView');
    const anomaliesListEl = document.getElementById('dataAnomaliesList');

    // Export buttons
    const downloadCsvBtn = document.getElementById('dataDownloadCsvBtn');
    const downloadJsonBtn = document.getElementById('dataDownloadJsonBtn');
    const copyClipboardBtn = document.getElementById('dataCopyClipboardBtn');

    async function getSession() {
        if (typeof window.supabaseClient === 'undefined' || !window.supabaseClient?.auth?.getSession) {
            return null;
        }
        try {
            const { data } = await window.supabaseClient.auth.getSession();
            return data?.session || null;
        } catch {
            return null;
        }
    }

    function switchTab(tabName) {
        state.activeTab = tabName;
        const tabs = [
            { name: 'cleaned', btn: tabCleaned, pane: paneCleaned },
            { name: 'raw', btn: tabRaw, pane: paneRaw },
            { name: 'anomalies', btn: tabAnomalies, pane: paneAnomalies }
        ];

        tabs.forEach(t => {
            const isActive = t.name === tabName;
            if (t.btn) {
                t.btn.classList.toggle('active', isActive);
                t.btn.setAttribute('aria-selected', String(isActive));
            }
            if (t.pane) {
                t.pane.classList.toggle('active', isActive);
                t.pane.hidden = !isActive;
            }
        });
    }

    function renderResults(data, rawText) {
        state.cleanedRecords = data.records || [];
        state.summary = data.summary || {};
        state.anomalies = data.anomalies || [];

        // Counters
        if (countOriginalEl) countOriginalEl.textContent = state.summary.originalCount || 0;
        if (countCleanedEl) countCleanedEl.textContent = state.summary.cleanedCount || 0;
        if (countDuplicatesEl) countDuplicatesEl.textContent = state.summary.duplicatesRemoved || 0;
        if (countEmailsEl) countEmailsEl.textContent = state.summary.emailsCleaned || 0;
        if (countDatesEl) countDatesEl.textContent = state.summary.datesFixed || 0;
        if (countAnomaliesEl) countAnomaliesEl.textContent = state.summary.anomaliesDetected || 0;

        // Cleaned Table
        if (cleanedTableHead && cleanedTableBody) {
            if (state.cleanedRecords.length > 0) {
                const cols = Object.keys(state.cleanedRecords[0]);
                cleanedTableHead.innerHTML = `<tr>${cols.map(c => `<th style="padding:10px; font-size:12px; font-weight:700; color:#38bdf8; background:rgba(15,23,42,0.8);">${escapeHtml(c)}</th>`).join('')}</tr>`;

                cleanedTableBody.innerHTML = '';
                state.cleanedRecords.forEach(row => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = cols.map(c => `<td style="padding:8px 10px; font-size:12px; color:#f1f5f9; border-bottom:1px solid rgba(255,255,255,0.05);">${escapeHtml(String(row[c] ?? ''))}</td>`).join('');
                    cleanedTableBody.appendChild(tr);
                });
            } else {
                cleanedTableHead.innerHTML = '';
                cleanedTableBody.innerHTML = '<tr><td style="padding:18px; text-align:center; font-size:12.5px; color:#94a3b8;">No cleaned rows available.</td></tr>';
            }
        }

        // Raw Text View
        if (rawTableView) {
            rawTableView.textContent = rawText || JSON.stringify(data.records, null, 2);
        }

        // Anomalies List
        if (anomaliesListEl) {
            if (!state.anomalies.length) {
                anomaliesListEl.innerHTML = '<div class="data-no-anomalies" style="padding:14px; text-align:center; color:#4ade80; font-size:12.5px;"><i class="fas fa-check-circle"></i> No critical data anomalies detected.</div>';
            } else {
                anomaliesListEl.innerHTML = state.anomalies.map(a => `
                    <div class="data-anomaly-item glass" style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; margin-bottom:8px; border-radius:8px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.25);">
                        <span class="anomaly-row-tag" style="font-size:11.5px; font-weight:700; color:#f87171;">Row ${a.row || 'N/A'} [${escapeHtml(a.column || '')}]</span>
                        <strong style="font-size:12px; color:#f1f5f9;">${escapeHtml(a.value || '')}</strong>
                        <span class="anomaly-reason" style="font-size:11.5px; color:#fca5a5;"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(a.reason || 'Flagged value')}</span>
                    </div>
                `).join('');
            }
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]);
    }

    async function processData() {
        if (state.isProcessing) return;
        const text = pasteInput ? pasteInput.value.trim() : '';
        if (!text) {
            if (statusEl) {
                statusEl.textContent = 'Please paste tabular data or choose a sample dataset above.';
                statusEl.className = 'data-status-msg error';
            }
            return;
        }
        const nonEmptyLines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
        const looksLikeJson = text.startsWith('[') || text.startsWith('{');
        if (!looksLikeJson && nonEmptyLines.length < 2) {
            if (statusEl) {
                statusEl.textContent = 'Please include a header row and at least one data row.';
                statusEl.className = 'data-status-msg error';
            }
            window.showToast?.('Dataset needs a header row and at least one data row.');
            return;
        }

        state.isProcessing = true;
        if (processBtn) {
            processBtn.disabled = true;
            processBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cleaning & Normalizing Data...';
        }
        if (statusEl) {
            statusEl.textContent = 'Deduplicating rows, formatting emails/phones, and standardizing dates...';
            statusEl.className = 'data-status-msg loading';
        }

        const operations = {
            deduplicate: opDedup ? opDedup.checked : true,
            cleanWhitespace: opWhitespace ? opWhitespace.checked : true,
            normalizeEmails: opEmails ? opEmails.checked : true,
            formatPhones: opPhones ? opPhones.checked : true,
            normalizeDates: opDates ? opDates.checked : true,
            detectAnomalies: opAnomalies ? opAnomalies.checked : true
        };
        const dedupKey = dedupKeySelect ? dedupKeySelect.value : 'Email';

        const session = await getSession();
        if (!session) {
            // Local client cleaning for guest / offline mode
            setTimeout(() => {
                const localResult = cleanDatasetLocally(text, operations, dedupKey);
                renderResults(localResult, text);
                state.isProcessing = false;
                if (processBtn) {
                    processBtn.disabled = false;
                    processBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Clean & Normalize Dataset';
                }
                if (statusEl) {
                    statusEl.textContent = `Cleaned ${localResult.summary.cleanedCount} records (${localResult.summary.duplicatesRemoved} duplicates purged). All 6 counters updated!`;
                    statusEl.className = 'data-status-msg success';
                }
                window.showToast?.('Dataset cleaned and normalized successfully!');
            }, 300);
            return;
        }

        const requestId = generateUuid();
        const payload = {
            requestId,
            csvText: text,
            operations,
            dedupKey
        };

        const dataController = new AbortController();
        const dataTimeoutId = setTimeout(() => dataController.abort(), 35000);
        const dataPreviewContainer = document.querySelector('#dataWorkspace .tool-pane-preview');
        try {
            const res = await fetch('/api/data/clean', {
                method: 'POST',
                signal: dataController.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                    'Idempotency-Key': requestId
                },
                body: JSON.stringify(payload)
            });

            const result = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 402) {
                    window.JEVEXA_SHOW_UPGRADE_MODAL?.('Pro', 'Data Management credits');
                }
                const err = new Error(result.error || 'Failed to clean dataset.');
                err.status = res.status;
                throw err;
            }

            renderResults(result, text);
            const dataCharged = Number.isInteger(result.charged_credits) ? result.charged_credits : (Number.isInteger(result.credits_used) ? result.credits_used : null);
            window.JEVEXA_RENDER_USED_CREDITS_FOOTER?.(dataPreviewContainer, dataCharged, {
                id: 'dataCreditReceipt',
                remaining: result.remaining_credits,
                tier: result.tier
            });
            if (result.remaining_credits !== undefined) {
                window.JEVEXA_UPDATE_CREDIT_BALANCE?.(result.remaining_credits);
            }
            window.JEVEXA_CREDITS?.fetchBalance?.();
            window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();

            if (statusEl) {
                const costText = dataCharged ? ` • ${dataCharged} credits used` : '';
                statusEl.textContent = `Cleaned ${result.summary?.cleanedCount || 0} records (${result.summary?.duplicatesRemoved || 0} duplicates purged)${costText}.`;
                statusEl.className = 'data-status-msg success';
            }
            window.showToast?.('Dataset cleaned and normalized successfully!');
        } catch (err) {
            window.JEVEXA_CLEAR_USED_CREDITS_FOOTER?.(dataPreviewContainer, 'dataCreditReceipt');
            if (err?.status && err.status >= 400 && err.status < 500) {
                if (statusEl) {
                    statusEl.textContent = err.message || 'Could not clean dataset.';
                    statusEl.className = 'data-status-msg error';
                }
                window.showToast?.(err.message || 'Could not clean dataset.');
                return;
            }
            console.warn('Data cleaning Cloud API notice, activating client engine:', err);
            const fallbackResult = cleanDatasetLocally(text, operations, dedupKey);
            renderResults(fallbackResult, text);
            if (statusEl) {
                statusEl.textContent = `Cloud AI unavailable — cleaned ${fallbackResult.summary.cleanedCount} records locally (no credits charged).`;
                statusEl.className = 'data-status-msg info';
            }
            window.showToast?.('Dataset cleaned locally (no credits charged).');
        } finally {
            clearTimeout(dataTimeoutId);
            state.isProcessing = false;
            if (processBtn) {
                processBtn.disabled = false;
                processBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Clean & Normalize Dataset';
            }
        }
    }

    function handleDataFile(file) {
        if (!file) return;
        if (file.size === 0) {
            if (statusEl) {
                statusEl.textContent = `File "${file.name}" is empty (0 bytes). Please upload a CSV, TSV, or JSON file with records.`;
                statusEl.className = 'data-status-msg error';
            }
            window.showToast?.('Uploaded file is empty.');
            return;
        }
        const reader = new FileReader();
        reader.onload = (loadEvent) => {
            const text = loadEvent.target?.result;
            if (pasteInput && typeof text === 'string') {
                if (!text.trim()) {
                    if (statusEl) {
                        statusEl.textContent = `File "${file.name}" contains no readable records.`;
                        statusEl.className = 'data-status-msg error';
                    }
                    window.showToast?.('Uploaded file contains no records.');
                    return;
                }
                pasteInput.value = text;
                if (statusEl) {
                    const sizeKb = (file.size / 1024).toFixed(1);
                    statusEl.textContent = `Loaded ${file.name} (${sizeKb} KB). Cleaning and normalizing...`;
                    statusEl.className = 'data-status-msg info';
                }
                processData();
                window.showToast?.(`File "${file.name}" loaded and processed.`);
            }
        };
        reader.onerror = () => {
            if (statusEl) {
                statusEl.textContent = 'Could not read file. Please ensure it is a valid text or CSV file.';
                statusEl.className = 'data-status-msg error';
            }
        };
        reader.readAsText(file);
    }

    let initialized = false;
    function init() {
        if (initialized) return;
        initialized = true;
        bindSafe(backBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(closeBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(processBtn, 'click', processData);

        // File upload handler & drag-and-drop
        if (fileInput) {
            bindSafe(fileInput, 'change', (event) => {
                const file = event.target?.files?.[0];
                event.target.value = '';
                if (file) handleDataFile(file);
            });
        }

        const dataDropzone = document.getElementById('dataDropzone');
        if (dataDropzone && fileInput) {
            bindSafe(dataDropzone, 'click', () => fileInput.click());
            bindSafe(dataDropzone, 'keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInput.click();
                }
            });
            ['dragenter', 'dragover'].forEach(evt => {
                dataDropzone.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dataDropzone.classList.add('dragover');
                }, false);
            });
            ['dragleave', 'drop'].forEach(evt => {
                dataDropzone.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dataDropzone.classList.remove('dragover');
                }, false);
            });
            dataDropzone.addEventListener('drop', (e) => {
                const files = e.dataTransfer?.files;
                if (files && files.length > 0) {
                    handleDataFile(files[0]);
                }
            }, false);
        }

        if (pasteInput) {
            ['dragenter', 'dragover'].forEach(evt => {
                pasteInput.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    pasteInput.classList.add('dragover');
                }, false);
            });
            ['dragleave', 'drop'].forEach(evt => {
                pasteInput.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    pasteInput.classList.remove('dragover');
                }, false);
            });
            pasteInput.addEventListener('drop', (e) => {
                const files = e.dataTransfer?.files;
                if (files && files.length > 0) {
                    handleDataFile(files[0]);
                }
            }, false);
        }

        // Preset selector
        if (presetSelect) {
            bindSafe(presetSelect, 'change', () => {
                const sample = SAMPLE_DATASETS[presetSelect.value];
                if (sample && pasteInput) {
                    pasteInput.value = sample;
                    processData();
                    if (statusEl) {
                        statusEl.textContent = `Loaded sample dataset (${presetSelect.value.replace(/_/g, ' ')}). Cleaned and normalized.`;
                        statusEl.className = 'data-status-msg info';
                    }
                }
            });
            if (presetSelect.value && SAMPLE_DATASETS[presetSelect.value]) {
                if (pasteInput && !pasteInput.value.trim()) {
                    pasteInput.value = SAMPLE_DATASETS[presetSelect.value];
                }
            }
        }

        // Tab switching
        bindSafe(tabCleaned, 'click', () => switchTab('cleaned'));
        bindSafe(tabRaw, 'click', () => switchTab('raw'));
        bindSafe(tabAnomalies, 'click', () => switchTab('anomalies'));

        // Helper to ensure non-empty records exist before export
        function ensureCleanedRecordsForExport() {
            if (!state.cleanedRecords.length) {
                const text = pasteInput ? pasteInput.value.trim() : SAMPLE_DATASETS.messy_leads;
                if (text) {
                    const local = cleanDatasetLocally(text);
                    renderResults(local, text);
                }
            }
            if (!state.cleanedRecords.length) {
                if (statusEl) {
                    statusEl.textContent = 'No cleaned records available to export. Load or paste a dataset first.';
                    statusEl.className = 'data-status-msg error';
                }
                window.showToast?.('No cleaned records available to export.');
                return false;
            }
            return true;
        }

        // Download Clean CSV
        bindSafe(downloadCsvBtn, 'click', () => {
            if (!ensureCleanedRecordsForExport()) return;
            const headers = Object.keys(state.cleanedRecords[0] || {});
            const rows = state.cleanedRecords.map(r => headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','));
            const csv = [headers.join(','), ...rows].join('\n');
            downloadFile(`Jevexa_Cleaned_Dataset_${new Date().toISOString().split('T')[0]}.csv`, '\uFEFF' + csv, 'text/csv;charset=utf-8;');
            window.showToast?.('Cleaned dataset downloaded as CSV!');
            if (statusEl) {
                statusEl.textContent = 'Downloaded cleaned CSV file.';
                statusEl.className = 'data-status-msg success';
            }
        });

        // Download Clean JSON
        bindSafe(downloadJsonBtn, 'click', () => {
            if (!ensureCleanedRecordsForExport()) return;
            const jsonStr = JSON.stringify({
                metadata: {
                    cleanedAt: new Date().toISOString(),
                    totalRecords: state.cleanedRecords.length,
                    summary: state.summary
                },
                records: state.cleanedRecords
            }, null, 2);
            downloadFile(`Jevexa_Cleaned_Dataset_${new Date().toISOString().split('T')[0]}.json`, jsonStr, 'application/json');
            window.showToast?.('Cleaned dataset downloaded as JSON!');
            if (statusEl) {
                statusEl.textContent = 'Downloaded cleaned JSON file.';
                statusEl.className = 'data-status-msg success';
            }
        });

        // Copy TSV to Clipboard
        bindSafe(copyClipboardBtn, 'click', async () => {
            if (!ensureCleanedRecordsForExport()) return;
            const headers = Object.keys(state.cleanedRecords[0] || {});
            const rows = state.cleanedRecords.map(r => headers.map(h => String(r[h] ?? '')).join('\t'));
            const tsv = [headers.join('\t'), ...rows].join('\n');
            const ok = typeof window.JEVEXA_COPY_TO_CLIPBOARD === 'function'
                ? await window.JEVEXA_COPY_TO_CLIPBOARD(tsv, {
                    button: copyClipboardBtn,
                    copiedHtml: '<i class="fas fa-check"></i> Copied!',
                    toastMessage: 'TSV copied to clipboard (ready for Excel/Sheets)'
                })
                : await (async () => {
                    try {
                        await navigator.clipboard.writeText(tsv);
                        window.showToast?.('TSV copied to clipboard');
                        return true;
                    } catch {
                        return false;
                    }
                })();
            if (ok && statusEl) {
                statusEl.textContent = 'TSV data copied to clipboard.';
                statusEl.className = 'data-status-msg success';
            }
        });

        // Load and clean initial default dataset so counters are never 0
        const defaultSample = presetSelect?.value && SAMPLE_DATASETS[presetSelect.value] ? SAMPLE_DATASETS[presetSelect.value] : SAMPLE_DATASETS.messy_leads;
        if (pasteInput && !pasteInput.value) {
            pasteInput.value = defaultSample;
        }
        const initialResult = cleanDatasetLocally(defaultSample);
        renderResults(initialResult, defaultSample);
    }

    window.JEVEXA_DATA = {
        init,
        processData,
        cleanDatasetLocally,
        renderResults,
        loadSample: (key) => {
            if (SAMPLE_DATASETS[key] && pasteInput) {
                window.JEVEXA_CLEAR_USED_CREDITS_FOOTER?.(document.querySelector('#dataWorkspace .tool-pane-preview'), 'dataCreditReceipt');
                pasteInput.value = SAMPLE_DATASETS[key];
                processData();
            }
        },
        resetOnLogout: () => {
            state.isProcessing = false;
            if (fileInput) fileInput.value = '';
            window.JEVEXA_CLEAR_USED_CREDITS_FOOTER?.(document.querySelector('#dataWorkspace .tool-pane-preview'), 'dataCreditReceipt');
            const sample = SAMPLE_DATASETS.messy_leads;
            if (presetSelect) presetSelect.value = 'messy_leads';
            if (pasteInput) pasteInput.value = sample;
            if (statusEl) { statusEl.textContent = ''; statusEl.className = 'data-status-msg'; }
            renderResults(cleanDatasetLocally(sample), sample);
        }
    };
    window.JEVEXA_DATA_MGMT = window.JEVEXA_DATA;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
