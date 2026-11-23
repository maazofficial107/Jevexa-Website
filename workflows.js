/**
 * JEVEXA AI Studio - Workflow Automation Workspace Controller
 * Handles multi-step autonomous sequence builder (Lead -> CRM Score -> Cold Outreach -> Social Draft -> Analytics),
 * step-by-step visual execution progress, run history logs, and pipeline templates.
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
        currentWorkflow: null,
        steps: [],
        runs: [],
        isRunning: false,
        maxSteps: 3,
        userTier: 'free'
    };

    // DOM Elements
    const workspace = document.getElementById('workflowsWorkspace');
    const backBtn = document.getElementById('workflowsBackToStudio');
    const closeBtn = document.getElementById('workflowsWorkspaceClose');

    const templateSelect = document.getElementById('workflowsTemplateSelect');
    const workflowTitleEl = document.getElementById('workflowBuilderTitle');
    const stepListEl = document.getElementById('workflowStepList');
    const addStepBtn = document.getElementById('workflowAddStepBtn');
    const runWorkflowBtn = document.getElementById('workflowRunBtn');
    const statusEl = document.getElementById('workflowStatus');

    // Execution Modal
    const execModal = document.getElementById('workflowExecModal');
    const execModalClose = document.getElementById('workflowExecClose');
    const execProgressFill = document.getElementById('workflowExecProgressFill');
    const execProgressText = document.getElementById('workflowExecProgressText');
    const execLogsEl = document.getElementById('workflowExecLogs');

    // History Table
    const historyTableBody = document.getElementById('workflowHistoryTableBody');

    const TEMPLATES = {
        lead_conversion: {
            name: "Inbound Lead Conversion Pipeline",
            trigger: { type: "crm_lead", name: "When New Inbound Lead is Added" },
            steps: [
                { id: "step_1", type: "score_lead", name: "AI Lead Scoring & Qualification", desc: "Calculates conversion likelihood and identifies top pain points." },
                { id: "step_2", type: "generate_outreach", name: "Draft Personalized 3-Step Sequence", desc: "Generates custom initial email and Day 3/Day 7 follow-ups." },
                { id: "step_3", type: "analytics_log", name: "Record Pipeline Value & Log KPIs", desc: "Updates Business Analytics conversion funnel and revenue forecast." }
            ]
        },
        content_repurposing: {
            name: "Multi-Channel Content Repurposing",
            trigger: { type: "blog_published", name: "When Core Article or Long-Form Post is Ready" },
            steps: [
                { id: "step_1", type: "social_draft", name: "Draft High-Impact LinkedIn Post", desc: "Extracts 3 core lessons with professional formatting." },
                { id: "step_2", type: "social_draft", name: "Draft Twitter / X Thread Hook", desc: "Formats punchy hook under 280 characters with hashtags." },
                { id: "step_3", type: "generate_outreach", name: "Draft Subscriber Newsletter Teaser", desc: "Composes email broadcast sharing the main takeaway." }
            ]
        },
        expense_audit: {
            name: "Smart Expense & Receipt Processing",
            trigger: { type: "document_upload", name: "When Vendor Receipt or Invoice is Uploaded" },
            steps: [
                { id: "step_1", type: "score_lead", name: "Extract Document OCR & Line Items", desc: "Extracts vendor, invoice number, line items, and totals." },
                { id: "step_2", type: "analytics_log", name: "Reconcile Against Monthly Budget", desc: "Matches against expense budget and flags anomalies." }
            ]
        }
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

    function loadTemplate(key) {
        const tmpl = TEMPLATES[key] || TEMPLATES.lead_conversion;
        state.currentWorkflow = tmpl;
        state.steps = tmpl.steps ? JSON.parse(JSON.stringify(tmpl.steps)) : [];
        if (workflowTitleEl) workflowTitleEl.textContent = tmpl.name;
        renderSteps();
    }

    function renderSteps() {
        if (!stepListEl) return;
        stepListEl.innerHTML = '';

        state.steps.forEach((step, index) => {
            const card = document.createElement('div');
            card.className = 'workflow-step-card glass';
            card.innerHTML = `
                <div class="workflow-step-badge">Step ${index + 1}</div>
                <div class="workflow-step-info">
                    <strong>${escapeHtml(step.name)}</strong>
                    <p>${escapeHtml(step.desc || 'Automated action step')}</p>
                </div>
                <div class="workflow-step-actions">
                    <button type="button" class="btn btn-xs btn-outline workflow-move-up-btn" data-step-index="${index}" title="Move Up" ${index === 0 ? 'disabled' : ''}>
                        <i class="fas fa-arrow-up"></i>
                    </button>
                    <button type="button" class="btn btn-xs btn-outline workflow-move-down-btn" data-step-index="${index}" title="Move Down" ${index === state.steps.length - 1 ? 'disabled' : ''}>
                        <i class="fas fa-arrow-down"></i>
                    </button>
                    <button type="button" class="btn btn-xs btn-outline workflow-configure-btn" data-step-index="${index}" title="Configure Step">
                        <i class="fas fa-sliders"></i>
                    </button>
                    <button type="button" class="btn btn-xs btn-outline workflow-del-step-btn" data-step-index="${index}" title="Remove Step">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `;
            stepListEl.appendChild(card);
        });

        stepListEl.querySelectorAll('.workflow-move-up-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = Number(e.currentTarget.dataset.stepIndex);
                if (idx > 0) {
                    const temp = state.steps[idx];
                    state.steps[idx] = state.steps[idx - 1];
                    state.steps[idx - 1] = temp;
                    renderSteps();
                    window.showToast?.('Step moved up.');
                }
            });
        });

        stepListEl.querySelectorAll('.workflow-move-down-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = Number(e.currentTarget.dataset.stepIndex);
                if (idx < state.steps.length - 1) {
                    const temp = state.steps[idx];
                    state.steps[idx] = state.steps[idx + 1];
                    state.steps[idx + 1] = temp;
                    renderSteps();
                    window.showToast?.('Step moved down.');
                }
            });
        });

        stepListEl.querySelectorAll('.workflow-configure-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = Number(e.currentTarget.dataset.stepIndex);
                const step = state.steps[idx];
                if (!step) return;
                const newName = prompt("Configure step action name:", step.name);
                if (newName && newName.trim()) {
                    step.name = newName.trim();
                    const newDesc = prompt("Configure step description:", step.desc || "");
                    if (newDesc !== null) step.desc = newDesc.trim();
                    renderSteps();
                    window.showToast?.('Step configuration updated.');
                }
            });
        });

        stepListEl.querySelectorAll('.workflow-del-step-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = Number(e.currentTarget.dataset.stepIndex);
                if (state.steps.length <= 1) {
                    window.showToast?.('A workflow must have at least one step.');
                    return;
                }
                state.steps.splice(idx, 1);
                renderSteps();
                window.showToast?.('Step removed.');
            });
        });
    }

    function addCustomStep() {
        if (state.steps.length >= state.maxSteps) {
            window.showToast?.(`Maximum steps (${state.maxSteps}) reached for ${state.userTier.toUpperCase()} plan. Upgrade plan to build deeper pipelines.`);
            return;
        }

        const newIndex = state.steps.length + 1;
        state.steps.push({
            id: `step_${newIndex}`,
            type: "custom",
            name: `Action Step ${newIndex}: Data Transformation`,
            desc: "Custom processing and verification step in the sequence."
        });
        renderSteps();
        window.showToast?.('Custom step added to sequence!');
    }

    async function runWorkflow() {
        const session = await getSession();
        if (!session) {
            window.showToast?.('Please sign in or create an account to run Workflow Automation.');
            window.openAuthModal?.('signup');
            return;
        }

        if (!state.steps.length) {
            window.showToast?.('Add at least one step before running the workflow.');
            return;
        }

        state.isRunning = true;
        if (runWorkflowBtn) {
            runWorkflowBtn.disabled = true;
            runWorkflowBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Executing Sequence...';
        }

        if (execModal) {
            execModal.hidden = false;
            execModal.classList.add('open');
        }
        if (execProgressFill) execProgressFill.style.width = '15%';
        if (execProgressText) execProgressText.textContent = 'Triggering sequence pipeline...';
        if (execLogsEl) execLogsEl.innerHTML = '<div class="exec-log-line info">Pipeline runner initialized. Validating steps...</div>';

        const requestId = generateUuid();
        const payload = {
            requestId,
            name: state.currentWorkflow?.name || "Automated Pipeline",
            trigger: state.currentWorkflow?.trigger || { type: "manual" },
            steps: state.steps,
            inputData: {
                lead: { name: "Alex Rivera", company: "CloudScale Inc", deal_value: 15000 },
                topic: "Enterprise AI Automation Launch"
            }
        };

        try {
            const res = await fetch('/api/workflows/run', {
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
                    window.JEVEXA_SHOW_UPGRADE_MODAL?.('Pro', 'Workflow Automation credits');
                }
                throw new Error(result.error || 'Workflow execution failed.');
            }

            if (execProgressFill) execProgressFill.style.width = '100%';
            const chargedNote = result.charged_credits ? ` (${result.charged_credits} credits used)` : '';
            if (execProgressText) execProgressText.textContent = `Sequence completed successfully in ${result.durationMs || 120}ms!${chargedNote}`;

            if (result.remaining_credits !== undefined) {
                window.JEVEXA_UPDATE_CREDIT_BALANCE?.(result.remaining_credits);
            }
            window.JEVEXA_CREDITS?.fetchBalance?.();
            window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();

            if (execLogsEl && Array.isArray(result.stepsExecuted)) {
                result.stepsExecuted.forEach((step, i) => {
                    const line = document.createElement('div');
                    line.className = 'exec-log-line success';
                    line.innerHTML = `<span>✔ [Step ${i+1}] ${escapeHtml(step.name)}</span> <span class="log-ms">${step.durationMs}ms</span>`;
                    execLogsEl.appendChild(line);
                });
            }

            // Record to history
            const historyEntry = {
                id: requestId,
                name: state.currentWorkflow?.name || "Pipeline",
                stepsCount: state.steps.length,
                durationMs: result.durationMs || 120,
                status: "Success",
                timestamp: new Date().toISOString()
            };
            state.runs.unshift(historyEntry);
            renderHistory();

            window.showToast?.('Workflow executed successfully!');
        } catch (err) {
            console.error('Workflow error:', err);
            if (execProgressText) execProgressText.textContent = 'Pipeline execution failed.';
            if (execLogsEl) {
                const errLine = document.createElement('div');
                errLine.className = 'exec-log-line error';
                errLine.textContent = `✖ Error: ${err.message || 'Execution halted'}`;
                execLogsEl.appendChild(errLine);
            }
            window.showToast?.(err.message || 'Workflow run failed.');
        } finally {
            state.isRunning = false;
            if (runWorkflowBtn) {
                runWorkflowBtn.disabled = false;
                runWorkflowBtn.innerHTML = '<i class="fas fa-play"></i> Run Workflow';
            }
        }
    }

    function renderHistory() {
        if (!historyTableBody) return;
        historyTableBody.innerHTML = '';

        if (!state.runs.length) {
            historyTableBody.innerHTML = '<tr><td colspan="5" class="table-empty">No workflow executions yet. Click "Run Workflow" to start.</td></tr>';
            return;
        }

        state.runs.forEach(run => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${escapeHtml(run.name)}</strong></td>
                <td>${run.stepsCount} steps</td>
                <td>${run.durationMs}ms</td>
                <td><span class="workflow-status-badge status-ok">${run.status}</span></td>
                <td><span class="history-time">${new Date(run.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></td>
            `;
            historyTableBody.appendChild(tr);
        });
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]);
    }

    function init() {
        bindSafe(backBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(closeBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());

        bindSafe(templateSelect, 'change', () => {
            if (templateSelect) loadTemplate(templateSelect.value);
        });

        bindSafe(addStepBtn, 'click', addCustomStep);
        bindSafe(runWorkflowBtn, 'click', runWorkflow);

        if (execModalClose) {
            bindSafe(execModalClose, 'click', () => {
                if (execModal) {
                    execModal.hidden = true;
                    execModal.classList.remove('open');
                }
            });
        }

        if (execModal) {
            bindSafe(execModal, 'click', (e) => {
                if (e.target === execModal) {
                    execModal.hidden = true;
                    execModal.classList.remove('open');
                }
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !execModal.hidden) {
                    execModal.hidden = true;
                    execModal.classList.remove('open');
                }
            });
        }

        loadTemplate('lead_conversion');
        renderHistory();
    }

    window.JEVEXA_WORKFLOWS = {
        init,
        loadTemplate,
        runWorkflow,
        addStep: addCustomStep
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
