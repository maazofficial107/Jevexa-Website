/**
 * JEVEXA AI Studio - Mini CRM Workspace Controller
 * Handles lead management, Kanban board, table view, CSV import/export,
 * 50-lead free tier enforcement, lead detail drawer, activity timeline,
 * and token-metered AI Lead Scoring with real-time balance sync.
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

    // Helper: RFC4122 v4 UUID generator (guaranteed to match /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    function generateUuid() {
        if (typeof window.crypto?.randomUUID === 'function') {
            try {
                return window.crypto.randomUUID();
            } catch (_) {}
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // State
    const state = {
        leads: [],
        activities: {}, // leadId -> array of activities
        activeView: 'kanban', // 'kanban' | 'table'
        selectedLeadId: null,
        userPlan: 'free',
        searchQuery: '',
        filterStage: 'all',
        filterScore: 'all',
        maxFreeLeads: 50,
        isAiScoring: false,
        isLoadingLeads: false
    };

    // DOM Elements
    const workspace = document.getElementById('crmWorkspace');
    const backBtn = document.getElementById('crmBackToStudio');
    const closeBtn = document.getElementById('crmWorkspaceClose');
    const viewKanbanBtn = document.getElementById('crmViewKanban');
    const viewTableBtn = document.getElementById('crmViewTable');
    const kanbanContainer = document.getElementById('crmKanbanContainer');
    const tableContainer = document.getElementById('crmTableContainer');
    const searchInput = document.getElementById('crmSearchInput');
    const stageFilter = document.getElementById('crmFilterStage');
    const scoreFilter = document.getElementById('crmFilterScore');
    const addLeadBtn = document.getElementById('crmAddLeadBtn');
    const importCsvBtn = document.getElementById('crmImportCsvBtn');
    const csvFileInput = document.getElementById('crmCsvFileInput');
    const exportCsvBtn = document.getElementById('crmExportCsvBtn');

    // Metrics elements
    const metricTotalLeads = document.getElementById('crmMetricTotalLeads');
    const metricPipelineVal = document.getElementById('crmMetricPipelineVal');
    const metricQualifiedCount = document.getElementById('crmMetricQualifiedCount');
    const metricAvgScore = document.getElementById('crmMetricAvgScore');
    const freeTierBar = document.getElementById('crmFreeTierBar');
    const freeTierProgress = document.getElementById('crmFreeTierProgress');
    const freeTierText = document.getElementById('crmFreeTierText');
    const freeTierUpgradeBtn = document.getElementById('crmFreeTierUpgradeBtn');

    // Modal elements
    const leadModal = document.getElementById('crmLeadModal');
    const leadForm = document.getElementById('crmLeadForm');
    const leadModalTitle = document.getElementById('crmLeadModalTitle');
    const leadModalCloseBtn = document.getElementById('crmLeadModalClose');
    const leadModalCancelBtn = document.getElementById('crmLeadModalCancel');
    const leadIdInput = document.getElementById('crmLeadId');
    const leadNameInput = document.getElementById('crmLeadName');
    const leadEmailInput = document.getElementById('crmLeadEmail');
    const leadPhoneInput = document.getElementById('crmLeadPhone');
    const leadCompanyInput = document.getElementById('crmLeadCompany');
    const leadRoleInput = document.getElementById('crmLeadRole');
    const leadWebsiteInput = document.getElementById('crmLeadWebsite');
    const leadValueInput = document.getElementById('crmLeadValue');
    const leadStageInput = document.getElementById('crmLeadStage');
    const leadFollowupInput = document.getElementById('crmLeadFollowup');
    const leadNotesInput = document.getElementById('crmLeadNotes');

    // Drawer elements
    const leadDrawer = document.getElementById('crmLeadDrawer');
    const drawerBackdrop = document.getElementById('crmDrawerBackdrop');
    const drawerCloseBtn = document.getElementById('crmDrawerClose');
    const drawerLeadName = document.getElementById('crmDrawerLeadName');
    const drawerLeadRoleCompany = document.getElementById('crmDrawerLeadRoleCompany');
    const drawerLeadStageBadge = document.getElementById('crmDrawerLeadStageBadge');
    const drawerEmail = document.getElementById('crmDrawerEmail');
    const drawerPhone = document.getElementById('crmDrawerPhone');
    const drawerWebsite = document.getElementById('crmDrawerWebsite');
    const drawerValue = document.getElementById('crmDrawerValue');
    const drawerFollowup = document.getElementById('crmDrawerFollowup');
    const drawerLastContacted = document.getElementById('crmDrawerLastContacted');
    const drawerNotes = document.getElementById('crmDrawerNotes');
    const drawerAiScoreBox = document.getElementById('crmDrawerAiScoreBox');
    const drawerAiScoreValue = document.getElementById('crmDrawerAiScoreValue');
    const drawerAiLikelihood = document.getElementById('crmDrawerAiLikelihood');
    const drawerAiSummary = document.getElementById('crmDrawerAiSummary');
    const drawerAiAction = document.getElementById('crmDrawerAiAction');
    const drawerAiScoreBtn = document.getElementById('crmAiScoreBtn');
    const drawerDraftOutreachBtn = document.getElementById('crmDraftOutreachBtn');
    const drawerEditBtn = document.getElementById('crmDrawerEditBtn');
    const drawerDeleteBtn = document.getElementById('crmDrawerDeleteBtn');
    const drawerNoteInput = document.getElementById('crmDrawerNoteInput');
    const drawerAddNoteBtn = document.getElementById('crmDrawerAddNoteBtn');
    const drawerTimeline = document.getElementById('crmActivityTimeline');

    // Helper: format currency
    function formatCurrency(val) {
        const num = Number(val) || 0;
        return '$' + num.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    // Helper: escape HTML
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Helper: get current session
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

    // Check user plan
    async function checkUserPlan() {
        const session = await getSession();
        if (!session?.user?.id) {
            state.userPlan = 'free';
            return 'free';
        }
        try {
            const { data, error } = await window.supabaseClient
                .from('user_credits')
                .select('plan')
                .eq('user_id', session.user.id)
                .maybeSingle();
            if (!error && data?.plan) {
                state.userPlan = data.plan.toLowerCase();
            } else {
                state.userPlan = 'free';
            }
        } catch {
            state.userPlan = 'free';
        }
        return state.userPlan;
    }

    function isPaidPlan() {
        return ['lite', 'starter', 'pro', 'max', 'business', 'ultra'].includes(state.userPlan);
    }

    // Load leads
    async function fetchLeads() {
        const session = await getSession();
        if (!session?.user?.id) {
            state.leads = [];
            renderAll();
            return;
        }

        state.isLoadingLeads = true;
        try {
            await checkUserPlan();

            // Try backend API proxy first, fallback to Supabase Client
            let leads = null;
            try {
                const res = await fetch('/api/crm/leads', {
                    headers: { 'Authorization': `Bearer ${session.access_token}` }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data?.leads)) leads = data.leads;
                }
            } catch (_) {}

            if (!leads) {
                const { data, error } = await window.supabaseClient
                    .from('crm_leads')
                    .select('*')
                    .order('created_at', { ascending: false });
                if (!error && Array.isArray(data)) {
                    leads = data;
                }
            }

            state.leads = leads || [];
        } catch (err) {
            console.error('Error fetching leads:', err);
            if (typeof window.showToast === 'function') {
                window.showToast('Could not load CRM leads. Please try again.');
            }
        } finally {
            state.isLoadingLeads = false;
            renderAll();
            if (typeof window.JEVEXA_SYNC_WORKSPACE_CREDITS === 'function') {
                window.JEVEXA_SYNC_WORKSPACE_CREDITS();
            }
        }
    }

    // Load activities for a lead
    async function fetchActivities(leadId) {
        if (!leadId) return [];
        const session = await getSession();
        if (!session) return [];

        try {
            const { data, error } = await window.supabaseClient
                .from('crm_activities')
                .select('*')
                .eq('lead_id', leadId)
                .order('created_at', { ascending: false });
            if (!error && Array.isArray(data)) {
                state.activities[leadId] = data;
                return data;
            }
        } catch (err) {
            console.warn('Error fetching activities:', err);
        }
        return [];
    }

    // Filter leads
    function getFilteredLeads() {
        const q = state.searchQuery.trim().toLowerCase();
        return state.leads.filter(lead => {
            if (q) {
                const matchName = lead.name?.toLowerCase().includes(q);
                const matchCompany = lead.company?.toLowerCase().includes(q);
                const matchEmail = lead.email?.toLowerCase().includes(q);
                const matchRole = lead.role?.toLowerCase().includes(q);
                if (!matchName && !matchCompany && !matchEmail && !matchRole) return false;
            }
            if (state.filterStage !== 'all' && lead.stage !== state.filterStage) {
                return false;
            }
            if (state.filterScore !== 'all') {
                const score = lead.lead_score;
                if (state.filterScore === 'unscored' && (score !== null && score !== undefined)) return false;
                if (state.filterScore === 'high' && (score === null || score < 70)) return false;
                if (state.filterScore === 'medium' && (score === null || score < 40 || score >= 70)) return false;
                if (state.filterScore === 'low' && (score === null || score >= 40)) return false;
            }
            return true;
        });
    }

    // Render Metrics Bar & Free Tier Progress
    function renderMetrics() {
        const total = state.leads.length;
        let pipelineVal = 0;
        let qualifiedCount = 0;
        let totalScore = 0;
        let scoredCount = 0;

        state.leads.forEach(lead => {
            pipelineVal += Number(lead.deal_value) || 0;
            if (['Qualified', 'Won'].includes(lead.stage)) qualifiedCount++;
            if (typeof lead.lead_score === 'number' && lead.lead_score >= 0) {
                totalScore += lead.lead_score;
                scoredCount++;
            }
        });

        const avgScore = scoredCount > 0 ? Math.round(totalScore / scoredCount) : 0;

        if (metricTotalLeads) metricTotalLeads.textContent = String(total);
        if (metricPipelineVal) metricPipelineVal.textContent = formatCurrency(pipelineVal);
        if (metricQualifiedCount) metricQualifiedCount.textContent = String(qualifiedCount);
        if (metricAvgScore) metricAvgScore.textContent = scoredCount > 0 ? `${avgScore}/100` : '—';

        // Free tier progress bar
        if (freeTierBar) {
            if (isPaidPlan()) {
                if (freeTierProgress) {
                    freeTierProgress.style.width = '100%';
                    freeTierProgress.className = 'crm-progress-fill is-unlimited';
                }
                if (freeTierText) freeTierText.innerHTML = `<strong>${total} Leads</strong> <span class="badge-tier-unlimited"><i class="fas fa-crown"></i> Unlimited</span>`;
                if (freeTierUpgradeBtn) freeTierUpgradeBtn.hidden = true;
            } else {
                const pct = Math.min(100, Math.round((total / state.maxFreeLeads) * 100));
                if (freeTierProgress) {
                    freeTierProgress.style.width = `${pct}%`;
                    freeTierProgress.className = pct >= 90 ? 'crm-progress-fill is-danger' : pct >= 70 ? 'crm-progress-fill is-warning' : 'crm-progress-fill';
                }
                if (freeTierText) {
                    freeTierText.innerHTML = `<strong>${total} / ${state.maxFreeLeads}</strong> Free Leads Used`;
                }
                if (freeTierUpgradeBtn) freeTierUpgradeBtn.hidden = false;
            }
        }
    }

    // Render Kanban Board
    const STAGES = ['New', 'Contacted', 'Replied', 'Qualified', 'Won', 'Lost'];

    function renderKanban() {
        if (!kanbanContainer) return;
        const filtered = getFilteredLeads();

        const columnsHtml = STAGES.map(stage => {
            const stageLeads = filtered.filter(l => l.stage === stage);
            const stageVal = stageLeads.reduce((acc, l) => acc + (Number(l.deal_value) || 0), 0);

            const cardsHtml = stageLeads.map(lead => {
                const scorePill = lead.lead_score !== null && lead.lead_score !== undefined
                    ? `<span class="crm-score-pill ${lead.lead_score >= 70 ? 'score-high' : lead.lead_score >= 40 ? 'score-med' : 'score-low'}"><i class="fas fa-bolt"></i> ${lead.lead_score}</span>`
                    : `<span class="crm-score-pill score-none">Unscored</span>`;

                const followupBadge = lead.next_followup_at
                    ? `<span class="crm-card-followup"><i class="far fa-calendar-alt"></i> ${new Date(lead.next_followup_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`
                    : '';

                return `
                    <div class="crm-kanban-card" data-lead-id="${lead.id}" tabindex="0" role="button" aria-label="Lead: ${escapeHtml(lead.name)}">
                        <div class="crm-card-header">
                            <h4 class="crm-card-title">${escapeHtml(lead.name)}</h4>
                            <span class="crm-card-value">${formatCurrency(lead.deal_value)}</span>
                        </div>
                        <div class="crm-card-sub">
                            ${lead.role ? `<span>${escapeHtml(lead.role)}</span>` : ''}
                            ${lead.role && lead.company ? `<span>•</span>` : ''}
                            ${lead.company ? `<strong>${escapeHtml(lead.company)}</strong>` : ''}
                        </div>
                        <div class="crm-card-meta">
                            ${scorePill}
                            ${followupBadge}
                        </div>
                        <div class="crm-card-actions" onclick="event.stopPropagation()">
                            <select class="crm-stage-mover" data-lead-id="${lead.id}" aria-label="Change stage for ${escapeHtml(lead.name)}">
                                ${STAGES.map(s => `<option value="${s}" ${s === stage ? 'selected' : ''}>Move: ${s}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div class="crm-kanban-col" data-stage="${stage}">
                    <div class="crm-col-header">
                        <div class="crm-col-title-wrap">
                            <span class="crm-col-dot stage-${stage.toLowerCase()}"></span>
                            <h3 class="crm-col-title">${stage}</h3>
                            <span class="crm-col-count">${stageLeads.length}</span>
                        </div>
                        <span class="crm-col-val">${formatCurrency(stageVal)}</span>
                    </div>
                    <div class="crm-col-body">
                        ${cardsHtml.length > 0 ? cardsHtml : `<div class="crm-col-empty">No leads in ${stage}</div>`}
                    </div>
                </div>
            `;
        }).join('');

        kanbanContainer.innerHTML = columnsHtml;

        // Card clicks open drawer
        kanbanContainer.querySelectorAll('.crm-kanban-card').forEach(card => {
            const leadId = card.dataset.leadId;
            card.addEventListener('click', () => openLeadDrawer(leadId));
            card.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openLeadDrawer(leadId);
                }
            });
        });

        // Stage changer dropdown
        kanbanContainer.querySelectorAll('.crm-stage-mover').forEach(select => {
            select.addEventListener('change', async (e) => {
                const leadId = select.dataset.leadId;
                const newStage = e.target.value;
                await updateLeadStage(leadId, newStage);
            });
        });
    }

    // Render Table View
    function renderTable() {
        if (!tableContainer) return;
        const filtered = getFilteredLeads();

        if (filtered.length === 0) {
            tableContainer.innerHTML = `
                <div class="crm-table-empty">
                    <i class="fas fa-search"></i>
                    <p>No leads match your current search and filters.</p>
                </div>
            `;
            return;
        }

        const rowsHtml = filtered.map(lead => {
            const scoreBadge = lead.lead_score !== null && lead.lead_score !== undefined
                ? `<span class="crm-score-pill ${lead.lead_score >= 70 ? 'score-high' : lead.lead_score >= 40 ? 'score-med' : 'score-low'}">${lead.lead_score}</span>`
                : `<span class="crm-score-pill score-none">—</span>`;

            const followupStr = lead.next_followup_at
                ? new Date(lead.next_followup_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                : '—';

            return `
                <tr data-lead-id="${lead.id}">
                    <td>
                        <div class="crm-table-name-cell">
                            <strong>${escapeHtml(lead.name)}</strong>
                            <small>${escapeHtml(lead.role || 'No title')}</small>
                        </div>
                    </td>
                    <td>
                        <div class="crm-table-company-cell">
                            <span>${escapeHtml(lead.company || '—')}</span>
                            ${lead.website ? `<a href="${escapeHtml(lead.website.startsWith('http') ? lead.website : 'https://' + lead.website)}" target="_blank" rel="noopener" class="crm-web-link"><i class="fas fa-external-link-alt"></i></a>` : ''}
                        </div>
                    </td>
                    <td>
                        <span class="crm-stage-pill stage-${lead.stage?.toLowerCase() || 'new'}">${escapeHtml(lead.stage || 'New')}</span>
                    </td>
                    <td><strong>${formatCurrency(lead.deal_value)}</strong></td>
                    <td>${scoreBadge}</td>
                    <td>${followupStr}</td>
                    <td>
                        <div class="crm-table-actions">
                            <button type="button" class="crm-row-btn crm-view-btn" data-lead-id="${lead.id}" title="View Details" aria-label="View Details"><i class="fas fa-eye"></i></button>
                            <button type="button" class="crm-row-btn crm-edit-btn" data-lead-id="${lead.id}" title="Edit Lead" aria-label="Edit Lead"><i class="fas fa-pencil-alt"></i></button>
                            <button type="button" class="crm-row-btn crm-del-btn" data-lead-id="${lead.id}" title="Delete Lead" aria-label="Delete Lead"><i class="fas fa-trash-alt"></i></button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        tableContainer.innerHTML = `
            <table class="crm-table" role="table">
                <thead>
                    <tr>
                        <th>Lead / Contact</th>
                        <th>Company</th>
                        <th>Stage</th>
                        <th>Deal Value</th>
                        <th>AI Score</th>
                        <th>Next Follow-up</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        `;

        tableContainer.querySelectorAll('.crm-view-btn').forEach(btn => {
            btn.addEventListener('click', () => openLeadDrawer(btn.dataset.leadId));
        });
        tableContainer.querySelectorAll('.crm-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const lead = state.leads.find(l => l.id === btn.dataset.leadId);
                if (lead) openLeadModal(lead);
            });
        });
        tableContainer.querySelectorAll('.crm-del-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteLead(btn.dataset.leadId));
        });
    }

    // Render All
    function renderAll() {
        renderMetrics();
        if (state.activeView === 'kanban') {
            if (kanbanContainer) kanbanContainer.hidden = false;
            if (tableContainer) tableContainer.hidden = true;
            renderKanban();
        } else {
            if (kanbanContainer) kanbanContainer.hidden = true;
            if (tableContainer) tableContainer.hidden = false;
            renderTable();
        }
    }

    // Update Stage
    async function updateLeadStage(leadId, newStage) {
        const session = await getSession();
        if (!session) return;
        const lead = state.leads.find(l => l.id === leadId);
        if (!lead || lead.stage === newStage) return;

        const oldStage = lead.stage;
        lead.stage = newStage;
        renderAll();

        try {
            await window.supabaseClient
                .from('crm_leads')
                .update({ stage: newStage, updated_at: new Date().toISOString() })
                .eq('id', leadId)
                .eq('user_id', session.user.id);

            // Log activity
            await window.supabaseClient
                .from('crm_activities')
                .insert({
                    user_id: session.user.id,
                    lead_id: leadId,
                    type: 'stage_change',
                    description: `Moved stage from ${oldStage} to ${newStage}`
                });

            if (state.selectedLeadId === leadId) {
                await renderDrawerTimeline(leadId);
                if (drawerLeadStageBadge) {
                    drawerLeadStageBadge.textContent = newStage;
                    drawerLeadStageBadge.className = `crm-stage-pill stage-${newStage.toLowerCase()}`;
                }
            }
            if (typeof window.showToast === 'function') {
                window.showToast(`Lead moved to ${newStage}`);
            }
        } catch (err) {
            console.error('Error updating stage:', err);
            lead.stage = oldStage;
            renderAll();
        }
    }

    // Lead Modal (Add / Edit) - Strict open/close state handling
    function openLeadModal(leadToEdit = null) {
        if (!leadToEdit && !isPaidPlan() && state.leads.length >= state.maxFreeLeads) {
            if (typeof window.showToast === 'function') {
                window.showToast(`Free plan limit reached (${state.maxFreeLeads} leads). Please upgrade to Pro for unlimited leads.`);
            }
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'unlimited CRM leads');
            }
            return;
        }

        if (leadModalTitle) {
            leadModalTitle.textContent = leadToEdit ? 'Edit CRM Lead' : 'Add New CRM Lead';
        }
        if (leadIdInput) leadIdInput.value = leadToEdit ? leadToEdit.id : '';
        if (leadNameInput) leadNameInput.value = leadToEdit ? leadToEdit.name : '';
        if (leadEmailInput) leadEmailInput.value = leadToEdit ? (leadToEdit.email || '') : '';
        if (leadPhoneInput) leadPhoneInput.value = leadToEdit ? (leadToEdit.phone || '') : '';
        if (leadCompanyInput) leadCompanyInput.value = leadToEdit ? (leadToEdit.company || '') : '';
        if (leadRoleInput) leadRoleInput.value = leadToEdit ? (leadToEdit.role || '') : '';
        if (leadWebsiteInput) leadWebsiteInput.value = leadToEdit ? (leadToEdit.website || '') : '';
        if (leadValueInput) leadValueInput.value = leadToEdit ? (leadToEdit.deal_value || 0) : '';
        if (leadStageInput) leadStageInput.value = leadToEdit ? leadToEdit.stage : 'New';
        if (leadFollowupInput) {
            leadFollowupInput.value = leadToEdit && leadToEdit.next_followup_at
                ? leadToEdit.next_followup_at.split('T')[0]
                : '';
        }
        if (leadNotesInput) leadNotesInput.value = leadToEdit ? (leadToEdit.notes || '') : '';

        if (leadModal) {
            leadModal.hidden = false;
            leadModal.removeAttribute('hidden');
            leadModal.classList.add('open');
            leadModal.setAttribute('aria-hidden', 'false');
            setTimeout(() => leadNameInput?.focus(), 60);
        }
    }

    function closeLeadModal() {
        if (leadModal) {
            leadModal.classList.remove('open');
            leadModal.setAttribute('aria-hidden', 'true');
            leadModal.setAttribute('hidden', '');
            leadModal.hidden = true;
        }
        if (leadForm) leadForm.reset();
    }

    // Save Lead Form Submit
    async function handleLeadFormSubmit(e) {
        e.preventDefault();
        const session = await getSession();
        if (!session?.user?.id) {
            if (typeof window.openAuthModal === 'function') window.openAuthModal('signup');
            else if (typeof window.openLogin === 'function') window.openLogin();
            return;
        }

        const id = leadIdInput?.value?.trim() || null;
        const name = leadNameInput?.value?.trim() || '';
        if (!name) {
            if (typeof window.showToast === 'function') window.showToast('Lead name is required.');
            return;
        }

        if (!id && !isPaidPlan() && state.leads.length >= state.maxFreeLeads) {
            closeLeadModal();
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'unlimited CRM leads');
            }
            return;
        }

        const payload = {
            user_id: session.user.id,
            name,
            email: leadEmailInput?.value?.trim() || null,
            phone: leadPhoneInput?.value?.trim() || null,
            company: leadCompanyInput?.value?.trim() || null,
            role: leadRoleInput?.value?.trim() || null,
            website: leadWebsiteInput?.value?.trim() || null,
            deal_value: Number(leadValueInput?.value) || 0,
            stage: leadStageInput?.value || 'New',
            next_followup_at: leadFollowupInput?.value ? new Date(leadFollowupInput.value).toISOString() : null,
            notes: leadNotesInput?.value?.trim() || null,
            updated_at: new Date().toISOString()
        };

        try {
            if (id) {
                // Update existing lead
                let updatedData = null;
                try {
                    const res = await fetch(`/api/crm/leads/${encodeURIComponent(id)}`, {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${session.access_token}`
                        },
                        body: JSON.stringify(payload)
                    });
                    if (res.ok) {
                        const resJson = await res.json();
                        if (resJson?.lead) updatedData = resJson.lead;
                    }
                } catch (_) {}

                if (!updatedData) {
                    const { data, error } = await window.supabaseClient
                        .from('crm_leads')
                        .update(payload)
                        .eq('id', id)
                        .eq('user_id', session.user.id)
                        .select()
                        .single();
                    if (error) throw error;
                    updatedData = data;
                }

                const idx = state.leads.findIndex(l => l.id === id);
                if (idx !== -1 && updatedData) {
                    state.leads[idx] = { ...state.leads[idx], ...updatedData };
                }
                if (typeof window.showToast === 'function') window.showToast('Lead updated successfully!');
            } else {
                // Create new lead
                payload.created_at = new Date().toISOString();
                let createdData = null;
                try {
                    const res = await fetch('/api/crm/leads', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${session.access_token}`
                        },
                        body: JSON.stringify(payload)
                    });
                    if (res.ok) {
                        const resJson = await res.json();
                        if (resJson?.lead) createdData = resJson.lead;
                    }
                } catch (_) {}

                if (!createdData) {
                    const { data, error } = await window.supabaseClient
                        .from('crm_leads')
                        .insert(payload)
                        .select()
                        .single();
                    if (error) throw error;
                    createdData = data;
                }

                if (createdData) {
                    state.leads.unshift(createdData);
                    await window.supabaseClient
                        .from('crm_activities')
                        .insert({
                            user_id: session.user.id,
                            lead_id: createdData.id,
                            type: 'note',
                            description: `Lead created with initial stage: ${createdData.stage}`
                        }).catch(() => {});
                }

                if (typeof window.showToast === 'function') window.showToast('Lead created successfully!');
            }

            closeLeadModal();
            renderAll();
        } catch (err) {
            console.error('Error saving lead:', err);
            if (typeof window.showToast === 'function') window.showToast('Could not save lead: ' + (err.message || 'Error'));
        }
    }

    // Delete Lead
    async function deleteLead(leadId) {
        if (!confirm('Are you sure you want to delete this lead? All associated activities will also be removed.')) {
            return;
        }
        const session = await getSession();
        if (!session?.user?.id) return;

        try {
            let deleted = false;
            try {
                const res = await fetch(`/api/crm/leads/${encodeURIComponent(leadId)}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${session.access_token}` }
                });
                if (res.ok) deleted = true;
            } catch (_) {}

            if (!deleted) {
                const { error } = await window.supabaseClient
                    .from('crm_leads')
                    .delete()
                    .eq('id', leadId)
                    .eq('user_id', session.user.id);
                if (error) throw error;
            }

            state.leads = state.leads.filter(l => l.id !== leadId);
            if (state.selectedLeadId === leadId) closeLeadDrawer();
            renderAll();
            if (typeof window.showToast === 'function') window.showToast('Lead deleted.');
        } catch (err) {
            console.error('Error deleting lead:', err);
            if (typeof window.showToast === 'function') window.showToast('Could not delete lead.');
        }
    }

    // CSV Export
    function exportCsv() {
        if (state.leads.length === 0) {
            if (typeof window.showToast === 'function') window.showToast('No leads available to export.');
            return;
        }

        const headers = ['name', 'email', 'phone', 'company', 'role', 'website', 'deal_value', 'stage', 'lead_score', 'notes', 'next_followup_at'];
        const csvRows = [headers.join(',')];

        state.leads.forEach(lead => {
            const row = headers.map(h => {
                let val = lead[h] ?? '';
                if (typeof val === 'string') {
                    val = `"${val.replace(/"/g, '""')}"`;
                }
                return val;
            });
            csvRows.push(row.join(','));
        });

        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `jevexa-crm-leads-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        if (typeof window.showToast === 'function') window.showToast(`Exported ${state.leads.length} leads to CSV.`);
    }

    // CSV Import
    async function handleCsvImport(file) {
        if (!file) return;
        const session = await getSession();
        if (!session?.user?.id) {
            if (typeof window.openAuthModal === 'function') window.openAuthModal('signup');
            return;
        }

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const text = e.target.result;
                const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
                if (lines.length <= 1) {
                    if (typeof window.showToast === 'function') window.showToast('CSV file is empty or missing headers.');
                    return;
                }

                const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));
                const newLeads = [];

                for (let i = 1; i < lines.length; i++) {
                    const rowText = lines[i];
                    const values = rowText.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || rowText.split(',');
                    const cleanValues = values.map(v => v ? v.trim().replace(/^"|"$/g, '').replace(/""/g, '"') : '');

                    const leadObj = {
                        user_id: session.user.id,
                        deal_value: 0,
                        stage: 'New'
                    };

                    headers.forEach((h, idx) => {
                        const val = cleanValues[idx] || '';
                        if (h === 'name') leadObj.name = val;
                        else if (h === 'email') leadObj.email = val;
                        else if (h === 'phone') leadObj.phone = val;
                        else if (h === 'company') leadObj.company = val;
                        else if (h === 'role') leadObj.role = val;
                        else if (h === 'website') leadObj.website = val;
                        else if (h.includes('value')) leadObj.deal_value = Number(val) || 0;
                        else if (h === 'stage' && STAGES.includes(val)) leadObj.stage = val;
                        else if (h.includes('score')) leadObj.lead_score = val ? Number(val) : null;
                        else if (h === 'notes') leadObj.notes = val;
                        else if (h.includes('followup')) leadObj.next_followup_at = val ? new Date(val).toISOString() : null;
                    });

                    if (leadObj.name) {
                        newLeads.push(leadObj);
                    }
                }

                if (newLeads.length === 0) {
                    if (typeof window.showToast === 'function') window.showToast('No valid leads found in CSV.');
                    return;
                }

                let leadsToInsert = newLeads;
                let capReached = false;
                if (!isPaidPlan()) {
                    const availableSlots = Math.max(0, state.maxFreeLeads - state.leads.length);
                    if (newLeads.length > availableSlots) {
                        capReached = true;
                        leadsToInsert = newLeads.slice(0, availableSlots);
                    }
                }

                if (leadsToInsert.length === 0) {
                    if (typeof window.showToast === 'function') {
                        window.showToast(`Free plan limit reached (${state.maxFreeLeads} leads). Upgrade to Pro to import.`);
                    }
                    if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                        window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'unlimited CRM leads');
                    }
                    return;
                }

                const { data, error } = await window.supabaseClient
                    .from('crm_leads')
                    .insert(leadsToInsert)
                    .select();

                if (error) throw error;
                if (Array.isArray(data)) {
                    state.leads = [...data, ...state.leads];
                    renderAll();
                }

                if (capReached) {
                    if (typeof window.showToast === 'function') {
                        window.showToast(`Imported ${leadsToInsert.length} leads. ${newLeads.length - leadsToInsert.length} skipped due to 50-lead Free tier limit.`);
                    }
                    if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                        setTimeout(() => window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'unlimited CRM leads'), 800);
                    }
                } else {
                    if (typeof window.showToast === 'function') {
                        window.showToast(`Successfully imported ${leadsToInsert.length} leads!`);
                    }
                }
            } catch (err) {
                console.error('Error importing CSV:', err);
                if (typeof window.showToast === 'function') window.showToast('CSV import failed: ' + err.message);
            }
        };
        reader.readAsText(file);
    }

    // Lead Detail Drawer - Strict open/close state handling
    async function openLeadDrawer(leadId) {
        const lead = state.leads.find(l => l.id === leadId);
        if (!lead) return;
        state.selectedLeadId = leadId;

        if (drawerLeadName) drawerLeadName.textContent = lead.name;
        if (drawerLeadRoleCompany) {
            const role = lead.role || '';
            const company = lead.company || '';
            drawerLeadRoleCompany.textContent = (role && company) ? `${role} at ${company}` : (role || company || 'No company specified');
        }
        if (drawerLeadStageBadge) {
            drawerLeadStageBadge.textContent = lead.stage;
            drawerLeadStageBadge.className = `crm-stage-pill stage-${lead.stage.toLowerCase()}`;
        }
        if (drawerEmail) {
            drawerEmail.innerHTML = lead.email
                ? `<a href="mailto:${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</a>`
                : '<span class="text-muted">Not provided</span>';
        }
        if (drawerPhone) {
            drawerPhone.innerHTML = lead.phone
                ? `<a href="tel:${escapeHtml(lead.phone)}">${escapeHtml(lead.phone)}</a>`
                : '<span class="text-muted">Not provided</span>';
        }
        if (drawerWebsite) {
            drawerWebsite.innerHTML = lead.website
                ? `<a href="${escapeHtml(lead.website.startsWith('http') ? lead.website : 'https://' + lead.website)}" target="_blank" rel="noopener">${escapeHtml(lead.website)} <i class="fas fa-external-link-alt"></i></a>`
                : '<span class="text-muted">Not provided</span>';
        }
        if (drawerValue) drawerValue.textContent = formatCurrency(lead.deal_value);
        if (drawerFollowup) {
            drawerFollowup.textContent = lead.next_followup_at
                ? new Date(lead.next_followup_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                : 'None scheduled';
        }
        if (drawerLastContacted) {
            drawerLastContacted.textContent = lead.last_contacted_at
                ? new Date(lead.last_contacted_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                : 'Never';
        }
        if (drawerNotes) {
            drawerNotes.textContent = lead.notes || 'No notes added yet.';
        }

        renderAiStrategyBox(lead);
        await renderDrawerTimeline(leadId);

        if (leadDrawer) {
            leadDrawer.hidden = false;
            leadDrawer.removeAttribute('hidden');
            leadDrawer.classList.add('open');
            leadDrawer.setAttribute('aria-hidden', 'false');
        }
        if (drawerBackdrop) {
            drawerBackdrop.hidden = false;
            drawerBackdrop.removeAttribute('hidden');
            drawerBackdrop.classList.add('open');
            drawerBackdrop.setAttribute('aria-hidden', 'false');
        }
    }

    function closeLeadDrawer() {
        state.selectedLeadId = null;
        if (leadDrawer) {
            leadDrawer.classList.remove('open');
            leadDrawer.setAttribute('aria-hidden', 'true');
            leadDrawer.setAttribute('hidden', '');
            leadDrawer.hidden = true;
        }
        if (drawerBackdrop) {
            drawerBackdrop.classList.remove('open');
            drawerBackdrop.setAttribute('aria-hidden', 'true');
            drawerBackdrop.setAttribute('hidden', '');
            drawerBackdrop.hidden = true;
        }
    }

    function renderAiStrategyBox(lead) {
        if (!drawerAiScoreBox) return;
        if (lead.lead_score !== null && lead.lead_score !== undefined) {
            drawerAiScoreBox.hidden = false;
            drawerAiScoreBox.removeAttribute('hidden');
            if (drawerAiScoreValue) drawerAiScoreValue.textContent = String(lead.lead_score);
            if (drawerAiLikelihood) {
                const likelihood = lead.lead_score >= 70 ? 'High Likelihood' : lead.lead_score >= 40 ? 'Medium Likelihood' : 'Low Likelihood';
                drawerAiLikelihood.textContent = likelihood;
                drawerAiLikelihood.className = `crm-ai-likelihood ${lead.lead_score >= 70 ? 'high' : lead.lead_score >= 40 ? 'med' : 'low'}`;
            }
            if (drawerAiSummary) {
                drawerAiSummary.textContent = lead.ai_summary || 'AI qualified lead with tailored recommendations.';
            }
        } else {
            drawerAiScoreBox.hidden = true;
            drawerAiScoreBox.setAttribute('hidden', '');
        }
    }

    async function renderDrawerTimeline(leadId) {
        if (!drawerTimeline) return;
        drawerTimeline.innerHTML = '<div class="crm-timeline-loading"><i class="fas fa-circle-notch fa-spin"></i> Loading activity...</div>';

        const activities = await fetchActivities(leadId);
        if (activities.length === 0) {
            drawerTimeline.innerHTML = '<div class="crm-timeline-empty">No activity recorded for this lead yet.</div>';
            return;
        }

        const icons = {
            note: 'fa-sticky-note',
            stage_change: 'fa-exchange-alt',
            ai_score: 'fa-wand-magic-sparkles',
            email_generated: 'fa-envelope-open-text',
            email_sent: 'fa-paper-plane'
        };

        const timelineHtml = activities.map(act => {
            const icon = icons[act.type] || 'fa-circle-dot';
            const dateStr = new Date(act.created_at).toLocaleString(undefined, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            return `
                <div class="crm-timeline-item type-${act.type || 'note'}">
                    <div class="crm-timeline-icon"><i class="fas ${icon}"></i></div>
                    <div class="crm-timeline-content">
                        <div class="crm-timeline-header">
                            <span class="crm-timeline-type">${formatActivityType(act.type)}</span>
                            <span class="crm-timeline-date">${dateStr}</span>
                        </div>
                        <p class="crm-timeline-desc">${escapeHtml(act.description)}</p>
                    </div>
                </div>
            `;
        }).join('');

        drawerTimeline.innerHTML = timelineHtml;
    }

    function formatActivityType(type) {
        switch (type) {
            case 'stage_change': return 'Stage Changed';
            case 'ai_score': return 'AI Lead Scored';
            case 'email_generated': return 'Outreach Sequence Drafted';
            case 'email_sent': return 'Email Sent';
            default: return 'Note Added';
        }
    }

    // Add Note to Lead
    async function handleAddNote() {
        const leadId = state.selectedLeadId;
        if (!leadId || !drawerNoteInput) return;
        const note = drawerNoteInput.value.trim();
        if (!note) return;

        const session = await getSession();
        if (!session?.user?.id) {
            if (typeof window.openAuthModal === 'function') window.openAuthModal('signup');
            return;
        }

        drawerAddNoteBtn.disabled = true;
        try {
            await window.supabaseClient
                .from('crm_activities')
                .insert({
                    user_id: session.user.id,
                    lead_id: leadId,
                    type: 'note',
                    description: note
                });

            drawerNoteInput.value = '';
            await renderDrawerTimeline(leadId);
            if (typeof window.showToast === 'function') window.showToast('Note added to timeline.');
        } catch (err) {
            console.error('Error adding note:', err);
            if (typeof window.showToast === 'function') window.showToast('Could not add note.');
        } finally {
            drawerAddNoteBtn.disabled = false;
        }
    }

    // AI Score & Strategy Action
    async function handleAiScore() {
        const leadId = state.selectedLeadId;
        const lead = state.leads.find(l => l.id === leadId);
        if (!lead || state.isAiScoring) return;

        const session = await getSession();
        if (!session?.user?.id) {
            if (typeof window.openAuthModal === 'function') window.openAuthModal('signup');
            return;
        }

        state.isAiScoring = true;
        if (drawerAiScoreBtn) {
            drawerAiScoreBtn.disabled = true;
            drawerAiScoreBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> <span>Scoring Lead…</span>';
        }

        const requestId = generateUuid();

        try {
            const res = await fetch('/api/crm/score', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                    'Idempotency-Key': requestId
                },
                body: JSON.stringify({
                    lead: {
                        id: lead.id,
                        name: lead.name,
                        company: lead.company,
                        role: lead.role,
                        website: lead.website,
                        deal_value: lead.deal_value,
                        stage: lead.stage,
                        notes: lead.notes
                    },
                    requestId
                })
            });

            const data = await res.json();
            if (!res.ok) {
                if (res.status === 402) {
                    if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                        window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'AI Lead Scoring credits');
                    }
                }
                throw new Error(data?.error || 'AI scoring request failed.');
            }

            lead.lead_score = data.lead_score;
            lead.ai_summary = data.summary;
            if (data.suggested_outreach_angle) {
                lead.suggested_outreach_angle = data.suggested_outreach_angle;
            }

            // Immediately update credits in UI
            if (typeof data.remaining_credits === 'number') {
                if (typeof window.JEVEXA_UPDATE_CREDIT_BALANCE === 'function') {
                    window.JEVEXA_UPDATE_CREDIT_BALANCE(data.remaining_credits);
                }
                if (typeof window.JEVEXA_SYNC_WORKSPACE_CREDITS === 'function') {
                    window.JEVEXA_SYNC_WORKSPACE_CREDITS();
                }
            }

            renderAiStrategyBox(lead);
            renderAll();
            await renderDrawerTimeline(leadId);

            if (typeof window.showToast === 'function') {
                window.showToast(`AI Score generated: ${data.lead_score}/100 (${data.conversion_likelihood})`);
            }
        } catch (err) {
            console.error('AI Score error:', err);
            if (typeof window.showToast === 'function') {
                window.showToast(err.message || 'Could not complete AI Lead Scoring.');
            }
        } finally {
            state.isAiScoring = false;
            if (drawerAiScoreBtn) {
                drawerAiScoreBtn.disabled = false;
                drawerAiScoreBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> <span>AI Score & Strategy</span>';
            }
        }
    }

    // Shortcut: Draft Outreach Email -> Handoff to Email & Outreach AI
    function handleDraftOutreachShortcut() {
        const leadId = state.selectedLeadId;
        const lead = state.leads.find(l => l.id === leadId);
        if (!lead) return;

        closeLeadDrawer();
        if (typeof window.JEVEXA_STUDIO?.openOutreach === 'function') {
            window.JEVEXA_STUDIO.openOutreach(lead);
        } else if (typeof window.openOutreachWorkspace === 'function') {
            window.openOutreachWorkspace(true, lead);
        } else if (typeof window.JEVEXA_OUTREACH?.prefillLead === 'function') {
            window.JEVEXA_OUTREACH.prefillLead(lead);
        } else if (typeof window.JEVEXA_OUTREACH?.openWithLead === 'function') {
            window.JEVEXA_OUTREACH.openWithLead(lead);
        }
    }

    // Initialize event listeners
    function initEvents() {
        // Ensure starting closed
        closeLeadModal();
        closeLeadDrawer();

        // Workspace back / close buttons
        bindSafe(backBtn, 'click', () => {
            closeLeadModal();
            closeLeadDrawer();
            if (typeof window.returnToStudio === 'function') {
                window.returnToStudio();
            }
        });
        bindSafe(closeBtn, 'click', () => {
            closeLeadModal();
            closeLeadDrawer();
            if (typeof window.returnToStudio === 'function') {
                window.returnToStudio();
            }
        });

        // View switcher
        bindSafe(viewKanbanBtn, 'click', () => {
            state.activeView = 'kanban';
            viewKanbanBtn?.classList.add('active');
            viewTableBtn?.classList.remove('active');
            renderAll();
        });
        bindSafe(viewTableBtn, 'click', () => {
            state.activeView = 'table';
            viewTableBtn?.classList.add('active');
            viewKanbanBtn?.classList.remove('active');
            renderAll();
        });

        // Search & Filters
        bindSafe(searchInput, 'input', () => {
            state.searchQuery = searchInput.value;
            renderAll();
        });
        bindSafe(stageFilter, 'change', () => {
            state.filterStage = stageFilter.value;
            renderAll();
        });
        bindSafe(scoreFilter, 'change', () => {
            state.filterScore = scoreFilter.value;
            renderAll();
        });

        // Add lead & Modal handlers
        bindSafe(addLeadBtn, 'click', () => openLeadModal());
        bindSafe(leadModalCloseBtn, 'click', closeLeadModal);
        bindSafe(leadModalCancelBtn, 'click', closeLeadModal);
        bindSafe(leadModal, 'click', (e) => {
            if (e.target === leadModal) {
                e.preventDefault();
                closeLeadModal();
            }
        });
        bindSafe(leadForm, 'submit', handleLeadFormSubmit);

        // CSV Export & Import
        bindSafe(exportCsvBtn, 'click', exportCsv);
        bindSafe(importCsvBtn, 'click', () => csvFileInput?.click());
        bindSafe(csvFileInput, 'change', (e) => {
            const file = e.target.files?.[0];
            if (file) handleCsvImport(file);
            csvFileInput.value = '';
        });

        // Free tier upgrade trigger
        bindSafe(freeTierUpgradeBtn, 'click', () => {
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'unlimited CRM leads');
            }
        });

        // Drawer handlers
        bindSafe(drawerCloseBtn, 'click', closeLeadDrawer);
        bindSafe(drawerBackdrop, 'click', closeLeadDrawer);
        bindSafe(drawerAddNoteBtn, 'click', handleAddNote);
        bindSafe(drawerAiScoreBtn, 'click', handleAiScore);
        bindSafe(drawerDraftOutreachBtn, 'click', handleDraftOutreachShortcut);
        bindSafe(drawerEditBtn, 'click', () => {
            const lead = state.leads.find(l => l.id === state.selectedLeadId);
            if (lead) {
                closeLeadDrawer();
                openLeadModal(lead);
            }
        });
        bindSafe(drawerDeleteBtn, 'click', () => {
            if (state.selectedLeadId) deleteLead(state.selectedLeadId);
        });

        // Escape key to close modal/drawer safely with event propagation stopped
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || e.key === 'Esc') {
                const isModalOpen = leadModal && (!leadModal.hidden || leadModal.classList.contains('open'));
                const isDrawerOpen = leadDrawer && (!leadDrawer.hidden || leadDrawer.classList.contains('open'));

                if (isModalOpen) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    closeLeadModal();
                } else if (isDrawerOpen) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    closeLeadDrawer();
                }
            }
        });
    }

    // Public API
    window.JEVEXA_CRM = {
        fetchLeads,
        openLeadDrawer,
        closeLeadDrawer,
        openLeadModal,
        closeLeadModal,
        deleteLead,
        exportCsv,
        getLeads: () => state.leads
    };

    // Auto-init on DOMContentLoaded or immediate
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initEvents();
        });
    } else {
        initEvents();
    }
})();
