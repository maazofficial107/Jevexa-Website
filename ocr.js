/**
 * JEVEXA AI Studio - Document AI & OCR Workspace Controller
 * Handles document upload / text ingestion, structured data extraction (vendor, dates, totals, line items),
 * confidence scoring, multi-view inspection (Structured, JSON, Raw Text), and CSV/JSON export.
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
        currentResult: null,
        isProcessing: false,
        activeTab: 'structured',
        userPlan: 'free'
    };

    // DOM Elements
    const workspace = document.getElementById('ocrWorkspace');
    const backBtn = document.getElementById('ocrBackToStudio');
    const closeBtn = document.getElementById('ocrWorkspaceClose');

    const fileInput = document.getElementById('ocrFileInput');
    const dropzone = document.getElementById('ocrDropzone');
    const textInput = document.getElementById('ocrTextInput');
    const docTypeSelect = document.getElementById('ocrDocType');
    const currencySelect = document.getElementById('ocrCurrency');
    const extractBtn = document.getElementById('ocrExtractBtn');
    const sampleSelect = document.getElementById('ocrSampleSelect');
    const statusEl = document.getElementById('ocrStatus');

    // Result elements
    const resultCard = document.getElementById('ocrResultCard');
    const vendorNameEl = document.getElementById('ocrVendorName');
    const docTypeBadgeEl = document.getElementById('ocrDocTypeBadge');
    const invoiceNumEl = document.getElementById('ocrInvoiceNumber');
    const dateEl = document.getElementById('ocrDate');
    const dueDateEl = document.getElementById('ocrDueDate');
    const paymentStatusEl = document.getElementById('ocrPaymentStatus');
    const confidenceEl = document.getElementById('ocrConfidence');
    const lineItemsBody = document.getElementById('ocrLineItemsTableBody');
    const subtotalEl = document.getElementById('ocrSubtotal');
    const taxEl = document.getElementById('ocrTax');
    const totalEl = document.getElementById('ocrTotal');
    const jsonViewEl = document.getElementById('ocrJsonView');
    const rawTextViewEl = document.getElementById('ocrRawTextView');

    // Tab buttons & panes
    const tabStructured = document.getElementById('ocrTabStructured');
    const tabJson = document.getElementById('ocrTabJson');
    const tabText = document.getElementById('ocrTabText');
    const paneStructured = document.getElementById('ocrPaneStructured');
    const paneJson = document.getElementById('ocrPaneJson');
    const paneText = document.getElementById('ocrPaneText');

    // Actions
    const copyJsonBtn = document.getElementById('ocrCopyJsonBtn');
    const exportCsvBtn = document.getElementById('ocrExportCsvBtn');
    const copyTextBtn = document.getElementById('ocrCopyTextBtn');

    const SAMPLE_DOCS = {
        saas_invoice: `APEX CLOUD COMPUTING INC.
100 Tech Promenade, Suite 400, San Francisco, CA 94107
Tax ID: 94-3829104
INVOICE #: INV-2026-8842
Date: 2026-11-15
Due Date: 2026-11-29
Billed To: Jevexa Operations LLC (ops@jevexa.net)

Items:
1. High-Performance GPU Cluster Node (Nov 2026) - Qty: 1 - Unit Price: $450.00 - Total: $450.00
2. Enterprise SSD Volume 2TB - Qty: 2 - Unit Price: $65.00 - Total: $130.00
3. Dedicated Load Balancer & DDoS Guard - Qty: 1 - Unit Price: $120.00 - Total: $120.00

Subtotal: $700.00
Tax (8.25%): $57.75
Grand Total: $757.75
Payment Status: Paid (Stripe Auth: ch_3P92k)`,

        office_receipt: `OFFICE ESSENTIALS DIRECT
Receipt No: REC-54910
Date: 2026-11-18
Cashier: Station 04
Store: #102 - Downtown Metro

1. Ergonomic Mesh Chair - Black - 1 @ $229.99 = $229.99
2. Dual Monitor Desk Mount - 1 @ $59.50 = $59.50
3. Premium Recycled Copy Paper (Box) - 2 @ $32.00 = $64.00

Subtotal: $353.49
Sales Tax: $28.28
Total Paid: $381.77
Payment Method: Visa Ending *8841 (Approved)`,

        consulting_statement: `NEXUS STRATEGY PARTNERS
Statement of Account: SOW-2026-03
Date: 2026-11-01
Client: Horizon Ventures

Services Rendered:
- Phase 1 System Architecture Discovery: 10 hrs @ $150.00 = $1,500.00
- AI Automation Pipeline Blueprint: 15 hrs @ $150.00 = $2,250.00

Subtotal: $3,750.00
Tax: $0.00
Total Due: $3,750.00
Terms: Net 30`
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
            { name: 'structured', btn: tabStructured, pane: paneStructured },
            { name: 'json', btn: tabJson, pane: paneJson },
            { name: 'text', btn: tabText, pane: paneText }
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

    function renderExtraction(data, rawText) {
        state.currentResult = data;
        if (!resultCard) return;

        resultCard.hidden = false;
        resultCard.classList.remove('is-empty');

        if (vendorNameEl) vendorNameEl.textContent = data.vendor_name || 'Vendor Detected';
        if (docTypeBadgeEl) docTypeBadgeEl.textContent = data.document_type || 'Document';
        if (invoiceNumEl) invoiceNumEl.textContent = data.invoice_number || 'N/A';
        if (dateEl) dateEl.textContent = data.date || '—';
        if (dueDateEl) dueDateEl.textContent = data.due_date || 'N/A';
        if (paymentStatusEl) {
            paymentStatusEl.textContent = data.payment_status || 'Paid';
            paymentStatusEl.className = 'ocr-status-pill ' + (data.payment_status?.toLowerCase() === 'paid' ? 'status-paid' : 'status-pending');
        }
        if (confidenceEl) confidenceEl.textContent = `${data.confidence_score || 95}% Match`;

        // Render line items
        if (lineItemsBody) {
            lineItemsBody.innerHTML = '';
            const items = Array.isArray(data.line_items) && data.line_items.length > 0
                ? data.line_items
                : [{ description: 'General Services / Products', quantity: 1, unit_price: data.subtotal || data.total_amount || 0, total: data.total_amount || 0 }];

            items.forEach(item => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td class="ocr-item-desc">${escapeHtml(item.description || 'Item')}</td>
                    <td class="ocr-item-qty">${item.quantity || 1}</td>
                    <td class="ocr-item-rate">$${Number(item.unit_price || 0).toFixed(2)}</td>
                    <td class="ocr-item-total">$${Number(item.total || 0).toFixed(2)}</td>
                `;
                lineItemsBody.appendChild(tr);
            });
        }

        const curr = data.currency || 'USD';
        const symbol = curr === 'EUR' ? '€' : (curr === 'GBP' ? '£' : '$');
        if (subtotalEl) subtotalEl.textContent = `${symbol}${Number(data.subtotal || 0).toFixed(2)}`;
        if (taxEl) taxEl.textContent = `${symbol}${Number(data.tax_amount || 0).toFixed(2)} (${data.tax_rate || 0}%)`;
        if (totalEl) totalEl.textContent = `${symbol}${Number(data.total_amount || 0).toFixed(2)}`;

        // JSON View
        if (jsonViewEl) {
            jsonViewEl.textContent = JSON.stringify(data, null, 2);
        }

        // Raw Text View
        if (rawTextViewEl) {
            rawTextViewEl.textContent = rawText || JSON.stringify(data, null, 2);
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]);
    }

    async function extractDocument() {
        const text = textInput ? textInput.value.trim() : '';
        if (!text) {
            if (statusEl) {
                statusEl.textContent = 'Please paste document text or choose a sample document above.';
                statusEl.className = 'ocr-status-msg error';
            }
            return;
        }

        const session = await getSession();
        if (!session) {
            window.showToast?.('Please sign in or create an account to use Document AI & OCR.');
            window.openAuthModal?.('signup');
            return;
        }

        state.isProcessing = true;
        if (extractBtn) {
            extractBtn.disabled = true;
            extractBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Extracting Data...';
        }
        if (statusEl) {
            statusEl.textContent = 'Analyzing document layout and structured line items...';
            statusEl.className = 'ocr-status-msg loading';
        }

        const requestId = generateUuid();
        const payload = {
            requestId,
            documentText: text,
            documentType: docTypeSelect ? docTypeSelect.value : 'auto',
            currency: currencySelect ? currencySelect.value : 'USD',
            fileData: state.uploadedFileData || undefined,
            fileName: state.uploadedFileName || undefined,
            fileSizeBytes: state.uploadedFileSize || undefined
        };

        try {
            const res = await fetch('/api/ocr/extract', {
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
                if (res.status === 402) {
                    window.JEVEXA_SHOW_UPGRADE_MODAL?.('Pro', 'Document AI & OCR credits');
                }
                throw new Error(result.error || 'Failed to extract document data.');
            }

            renderExtraction(result.data, text);
            if (result.remaining_credits !== undefined) {
                window.JEVEXA_UPDATE_CREDIT_BALANCE?.(result.remaining_credits);
            }
            window.JEVEXA_CREDITS?.fetchBalance?.();
            window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();

            if (statusEl) {
                const costText = result.charged_credits ? ` (${result.charged_credits} credits used)` : '';
                statusEl.textContent = `Data extracted successfully!${costText}`;
                statusEl.className = 'ocr-status-msg success';
            }
            window.showToast?.('Document data extracted successfully!');
        } catch (err) {
            console.error('OCR Extraction error:', err);
            if (statusEl) {
                statusEl.textContent = err.message || 'Extraction failed. Please try again.';
                statusEl.className = 'ocr-status-msg error';
            }
            window.showToast?.(err.message || 'Document OCR extraction failed.');
        } finally {
            state.isProcessing = false;
            if (extractBtn) {
                extractBtn.disabled = false;
                extractBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Extract Structured Data';
            }
        }
    }

    function init() {
        bindSafe(backBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(closeBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(extractBtn, 'click', extractDocument);

        // Sample preset selection
        if (sampleSelect) {
            bindSafe(sampleSelect, 'change', () => {
                const val = sampleSelect.value;
                state.uploadedFileData = null;
                state.uploadedFileName = null;
                state.uploadedFileSize = null;
                if (SAMPLE_DOCS[val] && textInput) {
                    textInput.value = SAMPLE_DOCS[val];
                    if (statusEl) {
                        statusEl.textContent = `Loaded sample ${val.replace(/_/g, ' ')}. Click "Extract Structured Data" to run.`;
                        statusEl.className = 'ocr-status-msg info';
                    }
                }
            });
            if (textInput && !textInput.value.trim() && sampleSelect.value && SAMPLE_DOCS[sampleSelect.value]) {
                textInput.value = SAMPLE_DOCS[sampleSelect.value];
            }
        }

        // File dropzone simulation & real file upload
        if (dropzone && fileInput) {
            bindSafe(dropzone, 'click', () => fileInput.click());
            bindSafe(fileInput, 'change', () => {
                const file = fileInput.files?.[0];
                if (file) {
                    state.uploadedFileName = file.name;
                    state.uploadedFileSize = file.size;
                    const isBinary = file.type.startsWith('image/') || file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
                    const reader = new FileReader();

                    if (isBinary) {
                        reader.onload = (e) => {
                            state.uploadedFileData = e.target?.result || null;
                            if (textInput) {
                                textInput.value = `[Uploaded Binary File: ${file.name} (${(file.size / 1024).toFixed(1)} KB)]\nReady for OCR extraction and token-weighted processing.`;
                            }
                            if (statusEl) {
                                statusEl.textContent = `Document "${file.name}" loaded (${(file.size / 1024).toFixed(1)} KB). Ready to extract.`;
                                statusEl.className = 'ocr-status-msg info';
                            }
                        };
                        reader.readAsDataURL(file);
                    } else {
                        reader.onload = (e) => {
                            state.uploadedFileData = null;
                            if (textInput) textInput.value = e.target?.result || '';
                            if (statusEl) {
                                statusEl.textContent = `File "${file.name}" loaded (${(file.size / 1024).toFixed(1)} KB). Ready to extract.`;
                                statusEl.className = 'ocr-status-msg info';
                            }
                        };
                        reader.readAsText(file);
                    }
                }
            });
        }

        // Tab navigation
        bindSafe(tabStructured, 'click', () => switchTab('structured'));
        bindSafe(tabJson, 'click', () => switchTab('json'));
        bindSafe(tabText, 'click', () => switchTab('text'));

        // Copy JSON action
        bindSafe(copyJsonBtn, 'click', () => {
            if (!state.currentResult) return;
            navigator.clipboard.writeText(JSON.stringify(state.currentResult, null, 2))
                .then(() => window.showToast?.('Extracted JSON copied to clipboard!'))
                .catch(() => window.showToast?.('Could not copy JSON.'));
        });

        // Copy Text action
        bindSafe(copyTextBtn, 'click', () => {
            if (!state.currentResult) return;
            const summary = `Vendor: ${state.currentResult.vendor_name}\nDoc #: ${state.currentResult.invoice_number}\nDate: ${state.currentResult.date}\nTotal: $${state.currentResult.total_amount}\nStatus: ${state.currentResult.payment_status}`;
            navigator.clipboard.writeText(summary)
                .then(() => window.showToast?.('Formatted summary copied!'))
                .catch(() => window.showToast?.('Could not copy summary.'));
        });

        // Export CSV action
        bindSafe(exportCsvBtn, 'click', () => {
            if (!state.currentResult || !state.currentResult.line_items) return;
            const items = state.currentResult.line_items;
            const headers = ['Description', 'Quantity', 'UnitPrice', 'Total'];
            const rows = items.map(it => [
                `"${(it.description || '').replace(/"/g, '""')}"`,
                it.quantity || 1,
                it.unit_price || 0,
                it.total || 0
            ].join(','));
            const csv = [headers.join(','), ...rows].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `OCR_${state.currentResult.invoice_number || 'document'}.csv`;
            link.click();
            window.showToast?.('Line items exported to CSV!');
        });
    }

    window.JEVEXA_OCR = {
        init,
        extractDocument,
        loadSample: (key) => {
            if (SAMPLE_DOCS[key] && textInput) {
                textInput.value = SAMPLE_DOCS[key];
            }
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
