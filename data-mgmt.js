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
        if (cleanedTableHead && cleanedTableBody && state.cleanedRecords.length > 0) {
            const cols = Object.keys(state.cleanedRecords[0]);
            cleanedTableHead.innerHTML = `<tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;

            cleanedTableBody.innerHTML = '';
            state.cleanedRecords.forEach(row => {
                const tr = document.createElement('tr');
                tr.innerHTML = cols.map(c => `<td>${escapeHtml(String(row[c] || ''))}</td>`).join('');
                cleanedTableBody.appendChild(tr);
            });
        }

        // Raw Text View
        if (rawTableView) {
            rawTableView.textContent = rawText || JSON.stringify(data.records, null, 2);
        }

        // Anomalies List
        if (anomaliesListEl) {
            if (!state.anomalies.length) {
                anomaliesListEl.innerHTML = '<div class="data-no-anomalies"><i class="fas fa-check-circle"></i> No critical data anomalies detected.</div>';
            } else {
                anomaliesListEl.innerHTML = state.anomalies.map(a => `
                    <div class="data-anomaly-item glass">
                        <span class="anomaly-row-tag">Row ${a.row || 'N/A'} [${escapeHtml(a.column || '')}]</span>
                        <strong>${escapeHtml(a.value || '')}</strong>
                        <span class="anomaly-reason">${escapeHtml(a.reason || 'Flagged value')}</span>
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
        const text = pasteInput ? pasteInput.value.trim() : '';
        if (!text) {
            if (statusEl) {
                statusEl.textContent = 'Please paste tabular data or choose a sample dataset above.';
                statusEl.className = 'data-status-msg error';
            }
            return;
        }

        const session = await getSession();
        if (!session) {
            window.showToast?.('Please sign in or create an account to use Data Management.');
            window.openAuthModal?.('signup');
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

        const requestId = generateUuid();
        const operations = {
            deduplicate: opDedup ? opDedup.checked : true,
            cleanWhitespace: opWhitespace ? opWhitespace.checked : true,
            normalizeEmails: opEmails ? opEmails.checked : true,
            formatPhones: opPhones ? opPhones.checked : true,
            normalizeDates: opDates ? opDates.checked : true,
            detectAnomalies: opAnomalies ? opAnomalies.checked : true
        };

        const payload = {
            requestId,
            csvText: text,
            operations,
            dedupKey: dedupKeySelect ? dedupKeySelect.value : 'Email'
        };

        try {
            const res = await fetch('/api/data/clean', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                    'Idempotency-Key': requestId
                },
                body: JSON.stringify(payload)
            });

            const result = await res.json();
            if (!res.ok) {
                throw new Error(result.error || 'Failed to clean dataset.');
            }

            renderResults(result, text);
            if (statusEl) {
                statusEl.textContent = `Cleaned ${result.summary?.cleanedCount || 0} records (${result.summary?.duplicatesRemoved || 0} duplicates purged).`;
                statusEl.className = 'data-status-msg success';
            }
            window.showToast?.('Dataset cleaned and normalized successfully!');
            window.JEVEXA_CREDITS?.fetchBalance?.();
        } catch (err) {
            console.error('Data clean error:', err);
            if (statusEl) {
                statusEl.textContent = err.message || 'Data cleaning failed.';
                statusEl.className = 'data-status-msg error';
            }
            window.showToast?.(err.message || 'Data management error.');
        } finally {
            state.isProcessing = false;
            if (processBtn) {
                processBtn.disabled = false;
                processBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Clean & Normalize Dataset';
            }
        }
    }

    function init() {
        bindSafe(backBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(closeBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(processBtn, 'click', processData);

        // Preset selector
        if (presetSelect) {
            bindSafe(presetSelect, 'change', () => {
                const sample = SAMPLE_DATASETS[presetSelect.value];
                if (sample && pasteInput) {
                    pasteInput.value = sample;
                    if (statusEl) {
                        statusEl.textContent = `Loaded sample dataset (${presetSelect.value.replace(/_/g, ' ')}). Click "Clean & Normalize Dataset" to process.`;
                        statusEl.className = 'data-status-msg info';
                    }
                }
            });
        }

        // Tab switching
        bindSafe(tabCleaned, 'click', () => switchTab('cleaned'));
        bindSafe(tabRaw, 'click', () => switchTab('raw'));
        bindSafe(tabAnomalies, 'click', () => switchTab('anomalies'));

        // Download CSV
        bindSafe(downloadCsvBtn, 'click', () => {
            if (!state.cleanedRecords.length) {
                window.showToast?.('No cleaned records available to download.');
                return;
            }
            const headers = Object.keys(state.cleanedRecords[0]);
            const rows = state.cleanedRecords.map(r => headers.map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(','));
            const csv = [headers.join(','), ...rows].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `Cleaned_Data_${new Date().toISOString().split('T')[0]}.csv`;
            link.click();
            window.showToast?.('Cleaned dataset downloaded as CSV!');
        });

        // Download JSON
        bindSafe(downloadJsonBtn, 'click', () => {
            if (!state.cleanedRecords.length) return;
            const blob = new Blob([JSON.stringify(state.cleanedRecords, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `Cleaned_Data_${new Date().toISOString().split('T')[0]}.json`;
            link.click();
            window.showToast?.('Cleaned dataset downloaded as JSON!');
        });

        // Copy to Clipboard
        bindSafe(copyClipboardBtn, 'click', () => {
            if (!state.cleanedRecords.length) return;
            const headers = Object.keys(state.cleanedRecords[0]);
            const rows = state.cleanedRecords.map(r => headers.map(h => String(r[h] || '')).join('\t'));
            const tsv = [headers.join('\t'), ...rows].join('\n');
            navigator.clipboard.writeText(tsv)
                .then(() => window.showToast?.('Cleaned data copied to clipboard (TSV format)!'))
                .catch(() => window.showToast?.('Could not copy to clipboard.'));
        });

        // Load default preset into textarea
        if (pasteInput && !pasteInput.value) {
            pasteInput.value = SAMPLE_DATASETS.messy_leads;
        }
    }

    window.JEVEXA_DATA = {
        init,
        processData,
        loadSample: (key) => {
            if (SAMPLE_DATASETS[key] && pasteInput) {
                pasteInput.value = SAMPLE_DATASETS[key];
            }
        }
    };
    window.JEVEXA_DATA_MGMT = window.JEVEXA_DATA;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
