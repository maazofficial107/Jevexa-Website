/**
 * JEVEXA AI Studio - Email & Outreach AI Workspace Controller
 * Handles lead auto-filling from CRM, campaign configuration,
 * token-metered 3-step sequence generation (Initial + A/B, Day 3 Follow-up, Day 7 Breakup),
 * 1-click Gmail web compose URL construction, clipboard copying,
 * CRM sync & status progression, and saved sequences history.
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
        activeStep: 1, // 1 | 2 | 3
        linkedLead: null,
        crmLeads: [],
        savedSequences: [],
        currentSequence: null,
        currentSequenceId: null,
        requestInFlight: false,
        useAlternativeSubject: false
    };

    // DOM Elements
    const workspace = document.getElementById('outreachWorkspace');
    const backBtn = document.getElementById('outreachBackToStudio');
    const closeBtn = document.getElementById('outreachWorkspaceClose');

    // Campaign inputs
    const form = document.getElementById('outreachForm');
    const leadSelect = document.getElementById('outreachLeadSelect');
    const recipientNameInput = document.getElementById('outreachRecipientName');
    const recipientEmailInput = document.getElementById('outreachRecipientEmail');
    const companyInput = document.getElementById('outreachCompany');
    const roleInput = document.getElementById('outreachRole');
    const websiteInput = document.getElementById('outreachWebsite');
    const valuePropInput = document.getElementById('outreachValueProp');
    const ctaSelect = document.getElementById('outreachCta');
    const toneSelect = document.getElementById('outreachTone');
    const depthSelect = document.getElementById('outreachDepth');
    const generateBtn = document.getElementById('outreachGenerateBtn');
    const statusEl = document.getElementById('outreachStatus');

    // Sequence tabs & fields
    const tabStep1 = document.getElementById('outreachTabStep1');
    const tabStep2 = document.getElementById('outreachTabStep2');
    const tabStep3 = document.getElementById('outreachTabStep3');
    const emailSubjectInput = document.getElementById('outreachEmailSubject');
    const emailBodyInput = document.getElementById('outreachEmailBody');
    const abSubjectContainer = document.getElementById('outreachAbSubjectContainer');
    const abSubjectText = document.getElementById('outreachAbSubjectText');
    const abSubjectToggleBtn = document.getElementById('outreachAbSubjectToggleBtn');

    // Sequence action buttons
    const openGmailBtn = document.getElementById('outreachOpenGmailBtn');
    const copyEmailBtn = document.getElementById('outreachCopyEmailBtn');
    const syncCrmBtn = document.getElementById('outreachSyncCrmBtn');
    const exportSeqBtn = document.getElementById('outreachExportBtn');
    const sequenceStatusPill = document.getElementById('outreachSequenceStatusPill');

    // Saved sequences history drawer
    const historyBtn = document.getElementById('outreachHistoryBtn');
    const historyDrawer = document.getElementById('outreachHistoryDrawer');
    const historyBackdrop = document.getElementById('outreachHistoryBackdrop');
    const historyCloseBtn = document.getElementById('outreachHistoryClose');
    const historyList = document.getElementById('outreachHistoryList');

    // Helpers
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

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function setStatus(msg, type = 'info') {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.className = `crm-status-msg status-${type}`;
    }

    // Load CRM Leads for auto-fill dropdown
    async function loadCrmLeads() {
        if (!leadSelect) return;
        const session = await getSession();
        if (!session?.user?.id) {
            leadSelect.innerHTML = '<option value="">-- Manual Entry Mode --</option>';
            return;
        }

        try {
            const { data, error } = await window.supabaseClient
                .from('crm_leads')
                .select('id,name,company,email,role,website,notes,ai_summary,suggested_outreach_angle')
                .order('created_at', { ascending: false });

            if (!error && Array.isArray(data)) {
                const list = [...data];
                if (state.linkedLead && !list.some(l => l.id === state.linkedLead.id)) {
                    list.unshift(state.linkedLead);
                }
                state.crmLeads = list;
                const options = [
                    '<option value="">-- Manual Entry / Custom Prospect --</option>',
                    ...list.map(lead => {
                        const label = lead.company ? `${lead.name} (${lead.company})` : lead.name;
                        return `<option value="${escapeHtml(lead.id)}">${escapeHtml(label)}</option>`;
                    })
                ];
                leadSelect.innerHTML = options.join('');
                if (state.linkedLead?.id) {
                    leadSelect.value = state.linkedLead.id;
                }
            }
        } catch (err) {
            console.warn('Could not load CRM leads for outreach:', err);
        }
    }

    // Handle lead selection
    function handleLeadSelection(leadId) {
        if (!leadId) {
            state.linkedLead = null;
            return;
        }
        const lead = state.crmLeads.find(l => l.id === leadId);
        if (!lead) return;

        state.linkedLead = lead;
        if (recipientNameInput) recipientNameInput.value = lead.name || '';
        if (recipientEmailInput) recipientEmailInput.value = lead.email || '';
        if (companyInput) companyInput.value = lead.company || '';
        if (roleInput) roleInput.value = lead.role || '';
        if (websiteInput) websiteInput.value = lead.website || '';

        const defaultPlaceholderOffer = 'Scale operational productivity and qualification speed with AI automation.';
        const currentOffer = valuePropInput ? valuePropInput.value.trim() : '';
        if (valuePropInput && (!currentOffer || currentOffer === defaultPlaceholderOffer || currentOffer.startsWith('Suggested hook:') || currentOffer.startsWith('Prospect context:') || currentOffer.startsWith('Lead background:'))) {
            if (lead.suggested_outreach_angle) {
                valuePropInput.value = `Suggested hook: ${lead.suggested_outreach_angle}\n\nProspect context: ${lead.ai_summary || lead.notes || 'Scale operational productivity with AI automation.'}`;
            } else if (lead.ai_summary) {
                valuePropInput.value = `Prospect context: ${lead.ai_summary}\n\nOur solution helps them streamline operations with AI automation.`;
            } else if (lead.notes) {
                valuePropInput.value = `Lead background: ${lead.notes}`;
            }
        }
    }

    // Pre-fill directly from Mini CRM shortcut button
    function prefillLead(lead) {
        if (!lead) return;
        state.linkedLead = lead;

        if (!state.crmLeads.some(l => l.id === lead.id)) {
            state.crmLeads.unshift(lead);
            const opt = document.createElement('option');
            opt.value = lead.id;
            opt.textContent = lead.company ? `${lead.name} (${lead.company})` : lead.name;
            leadSelect?.insertBefore(opt, leadSelect.children[1] || null);
        }

        if (leadSelect) leadSelect.value = lead.id;
        if (recipientNameInput) recipientNameInput.value = lead.name || '';
        if (recipientEmailInput) recipientEmailInput.value = lead.email || '';
        if (companyInput) companyInput.value = lead.company || '';
        if (roleInput) roleInput.value = lead.role || '';
        if (websiteInput) websiteInput.value = lead.website || '';

        if (valuePropInput) {
            if (lead.suggested_outreach_angle) {
                valuePropInput.value = `Focus angle: ${lead.suggested_outreach_angle}\n\nContext: ${lead.ai_summary || lead.notes || 'B2B automation'}`;
            } else if (lead.ai_summary) {
                valuePropInput.value = `Context: ${lead.ai_summary}\n\nHelp them scale with JEVEXA AI automation solutions.`;
            } else if (lead.notes) {
                valuePropInput.value = `Context: ${lead.notes}`;
            }
            valuePropInput.focus();
        }
    }
    const prefillWithLead = prefillLead;

    function loadCachedSequences() {
        try {
            const raw = sessionStorage.getItem('jevexa_outreach_sequences_cache');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    state.savedSequences = parsed;
                    renderSavedSequencesList();
                    return true;
                }
            }
        } catch (_) {}
        return false;
    }

    // Load saved sequences history
    async function loadSavedSequences() {
        const session = await getSession();
        if (!session?.user?.id) return;

        try {
            let seqs = null;
            try {
                const res = await fetch('/api/outreach/sequences', {
                    headers: { 'Authorization': `Bearer ${session.access_token}` }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data?.sequences)) seqs = data.sequences;
                }
            } catch (_) {}

            if (!seqs) {
                const { data, error } = await window.supabaseClient
                    .from('outreach_sequences')
                    .select('*')
                    .order('created_at', { ascending: false });
                if (!error && Array.isArray(data)) {
                    seqs = data;
                }
            }

            if (seqs) {
                state.savedSequences = seqs;
                try {
                    sessionStorage.setItem('jevexa_outreach_sequences_cache', JSON.stringify(seqs));
                } catch (_) {}
            }
            renderSavedSequencesList();
        } catch (err) {
            console.warn('Could not load saved sequences:', err);
        }
    }

    function renderSavedSequencesList() {
        if (!historyList) return;
        if (state.savedSequences.length === 0) {
            historyList.innerHTML = '<div class="crm-table-empty"><p>No saved sequences found.</p></div>';
            return;
        }

        const itemsHtml = state.savedSequences.map(seq => {
            const title = seq.company
                ? `${seq.recipient_name || 'Prospect'} (${seq.company})`
                : (seq.recipient_name || seq.initial_subject || 'Outreach Campaign');

            const dateStr = new Date(seq.created_at).toLocaleDateString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric'
            });

            return `
                <div class="outreach-history-item" data-seq-id="${seq.id}">
                    <div class="outreach-history-top">
                        <strong class="outreach-history-title">${escapeHtml(title)}</strong>
                        <span class="crm-stage-pill stage-${(seq.status || 'draft').toLowerCase().replace(/\s+/g, '-')}">${escapeHtml(seq.status || 'Draft')}</span>
                    </div>
                    <p class="outreach-history-subject">${escapeHtml(seq.initial_subject || 'No subject')}</p>
                    <div class="outreach-history-meta">
                        <span><i class="far fa-clock"></i> ${dateStr}</span>
                        <div class="outreach-history-actions">
                            <button type="button" class="btn btn-sm btn-outline load-seq-btn" data-seq-id="${seq.id}">Load</button>
                            <button type="button" class="btn btn-sm btn-icon-del del-seq-btn" data-seq-id="${seq.id}" title="Delete"><i class="fas fa-trash-alt"></i></button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        historyList.innerHTML = itemsHtml;

        historyList.querySelectorAll('.load-seq-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const seq = state.savedSequences.find(s => s.id === btn.dataset.seqId);
                if (seq) {
                    window.JEVEXA_CLEAR_USED_CREDITS_FOOTER?.(document.querySelector('#outreachWorkspace .outreach-pane-preview'), 'outreachCreditReceipt');
                    loadSequenceIntoWorkspace(seq);
                    closeHistoryDrawer();
                }
            });
        });

        historyList.querySelectorAll('.del-seq-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const confirmed = typeof window.JEVEXA_CONFIRM === 'function'
                    ? await window.JEVEXA_CONFIRM({
                        title: 'Delete outreach sequence?',
                        message: 'Are you sure you want to delete this saved outreach sequence?',
                        confirmText: 'Delete Sequence',
                        danger: true,
                        iconClass: 'fa-trash-can'
                    })
                    : false;
                if (!confirmed) return;
                await deleteSavedSequence(btn.dataset.seqId);
            });
        });
    }

    async function deleteSavedSequence(seqId) {
        const session = await getSession();
        if (!session?.user?.id) {
            state.savedSequences = state.savedSequences.filter(s => s.id !== seqId);
            try {
                sessionStorage.setItem('jevexa_outreach_sequences_cache', JSON.stringify(state.savedSequences));
            } catch (_) {}
            renderSavedSequencesList();
            if (typeof window.showToast === 'function') window.showToast('Sequence deleted.');
            return;
        }
        try {
            let deleted = false;
            try {
                const res = await fetch(`/api/outreach/sequences?id=${encodeURIComponent(seqId)}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${session.access_token}` }
                });
                if (res.ok) deleted = true;
            } catch (_) {}

            if (!deleted) {
                const { error } = await window.supabaseClient
                    .from('outreach_sequences')
                    .delete()
                    .eq('id', seqId)
                    .eq('user_id', session.user.id);
                if (error) throw error;
            }

            state.savedSequences = state.savedSequences.filter(s => s.id !== seqId);
            renderSavedSequencesList();
            if (typeof window.showToast === 'function') window.showToast('Sequence deleted.');
        } catch (err) {
            console.error('Delete sequence failed:', err);
        }
    }

    function loadSequenceIntoWorkspace(seq) {
        state.currentSequenceId = seq.id;
        state.useAlternativeSubject = false;
        const steps = seq.steps || null;
        const initSubject = seq.initial_subject || steps?.initial?.subject || '';
        state.currentSequence = {
            initial: {
                subject: initSubject,
                alternative_subject: steps?.initial?.alternative_subject || (initSubject ? `Alternative: ${initSubject}` : ''),
                body: seq.initial_body || steps?.initial?.body || ''
            },
            followup_1: {
                day: 'Day 3',
                subject: seq.followup_1_subject || steps?.followup_1?.subject || (initSubject ? `Re: ${initSubject}` : ''),
                body: seq.followup_1_body || steps?.followup_1?.body || ''
            },
            followup_2: {
                day: 'Day 7',
                subject: seq.followup_2_subject || steps?.followup_2?.subject || (initSubject ? `Final note: ${initSubject}` : ''),
                body: seq.followup_2_body || steps?.followup_2?.body || ''
            }
        };

        if (recipientNameInput) recipientNameInput.value = seq.recipient_name || '';
        if (recipientEmailInput) recipientEmailInput.value = seq.recipient_email || '';
        if (companyInput) companyInput.value = seq.company || '';
        if (roleInput && seq.role) roleInput.value = seq.role;
        if (valuePropInput) valuePropInput.value = seq.goal || '';
        if (toneSelect && seq.tone) toneSelect.value = seq.tone;

        if (seq.lead_id && leadSelect) {
            leadSelect.value = seq.lead_id;
            state.linkedLead = state.crmLeads.find(l => l.id === seq.lead_id) || null;
        } else {
            if (leadSelect) leadSelect.value = '';
            state.linkedLead = null;
        }

        updateSequenceStatusPill(seq.status || 'Draft');
        switchStep(1);
        if (typeof window.showToast === 'function') {
            window.showToast('Loaded sequence into editor.');
        }
    }

    // Step Switching
    function switchStep(stepNum) {
        state.activeStep = stepNum;

        tabStep1?.classList.toggle('active', stepNum === 1);
        tabStep2?.classList.toggle('active', stepNum === 2);
        tabStep3?.classList.toggle('active', stepNum === 3);

        tabStep1?.setAttribute('aria-selected', stepNum === 1 ? 'true' : 'false');
        tabStep2?.setAttribute('aria-selected', stepNum === 2 ? 'true' : 'false');
        tabStep3?.setAttribute('aria-selected', stepNum === 3 ? 'true' : 'false');

        if (!state.currentSequence) return;

        let stepData;
        if (stepNum === 1) stepData = state.currentSequence.initial;
        else if (stepNum === 2) stepData = state.currentSequence.followup_1;
        else stepData = state.currentSequence.followup_2;

        if (emailSubjectInput) {
            emailSubjectInput.value = stepData?.subject || '';
        }
        if (emailBodyInput) {
            emailBodyInput.value = stepData?.body || '';
        }

        // A/B Subject handling (for Step 1 only)
        if (stepNum === 1 && state.currentSequence.initial?.alternative_subject) {
            if (abSubjectContainer) {
                abSubjectContainer.hidden = false;
                abSubjectContainer.removeAttribute('hidden');
            }
            if (abSubjectText) abSubjectText.textContent = state.currentSequence.initial.alternative_subject;
            if (abSubjectToggleBtn) {
                abSubjectToggleBtn.textContent = state.useAlternativeSubject ? 'Use Primary Subject' : 'Use A/B Subject';
            }
        } else {
            if (abSubjectContainer) {
                abSubjectContainer.hidden = true;
                abSubjectContainer.setAttribute('hidden', '');
            }
        }
    }

    function toggleAbSubject() {
        if (!state.currentSequence?.initial) return;
        state.useAlternativeSubject = !state.useAlternativeSubject;

        if (state.useAlternativeSubject) {
            const alt = state.currentSequence.initial.alternative_subject;
            if (emailSubjectInput && alt) emailSubjectInput.value = alt;
            if (abSubjectToggleBtn) abSubjectToggleBtn.textContent = 'Use Primary Subject';
            if (typeof window.showToast === 'function') window.showToast('Switched to A/B test subject line.');
        } else {
            const prim = state.currentSequence.initial.subject;
            if (emailSubjectInput && prim) emailSubjectInput.value = prim;
            if (abSubjectToggleBtn) abSubjectToggleBtn.textContent = 'Use A/B Subject';
            if (typeof window.showToast === 'function') window.showToast('Switched back to primary subject line.');
        }
    }

    function deterministicClientOutreach(name, company, role, website, goal, tone, cta) {
        const pName = name || 'Alex Rivera';
        const pComp = company || 'CloudScale Inc';
        const pRole = role || 'VP of Operations';
        const pGoal = goal || 'scale operations with intelligent AI automation';
        const pCta = cta || 'Book a 15-minute intro call';

        const subject1 = `Quick question regarding ${pComp}'s growth`;
        const altSubject = `Idea for ${pName} & ${pComp}`;
        const body1 = `Hi ${pName},\n\nI noticed your work as ${pRole} at ${pComp}${website ? ' (' + website + ')' : ''} and wanted to reach out directly.\n\nTeams in your space typically spend 15+ hours weekly juggling manual workflows. We developed an integrated AI Automation Studio that solves this by unifying CRM, outreach, and document extraction under one predictable credit wallet.\n\nOur clients typically see measurable efficiency gains within their first two weeks.\n\n${pCta} — would you have 10 minutes this Thursday afternoon?\n\nBest regards,\n[Your Name]`;

        const subject2 = `Re: ${subject1}`;
        const body2 = `Hi ${pName},\n\nFollowing up on my previous note. I know how busy scaling ${pComp} can be.\n\nTo share a quick example: a growing SaaS team recently automated their lead qualification and outreach pipeline, reducing response time across their funnel.\n\nWould you be open to a brief 10-minute preview this week?\n\nBest,\n[Your Name]`;

        const subject3 = `Permission to close your file, ${pName}?`;
        const body3 = `Hi ${pName},\n\nI realize you are likely heads-down scaling ${pComp}, so I will pause my outreach here.\n\nIf you ever look to streamline customer data extraction and automated outreach without managing multiple disjointed tools, feel free to reach out anytime at jevexa.net.\n\nWishing you and ${pComp} continued growth!\n\nBest,\n[Your Name]`;

        return {
            initial: {
                subject: subject1,
                alternative_subject: altSubject,
                body: body1
            },
            followup_1: {
                subject: subject2,
                body: body2
            },
            followup_2: {
                subject: subject3,
                body: body3
            }
        };
    }

    // Generate 3-Step Sequence Submit
    async function handleGenerateSubmit(e) {
        e.preventDefault();
        if (state.requestInFlight) return;

        const valueProp = valuePropInput?.value?.trim() || '';
        if (!valueProp) {
            setStatus('Please describe your offer or value proposition.', 'error');
            valuePropInput?.focus();
            return;
        }

        state.requestInFlight = true;
        if (generateBtn) {
            generateBtn.disabled = true;
            generateBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> <span>Drafting 3-Step Sequence…</span>';
        }
        setStatus('AI analyzing prospect and drafting personalized cold email sequence…', 'loading');

        const session = await getSession();
        if (!session?.user?.id) {
            // Local client generator for guests & offline testing
            setTimeout(async () => {
                const seq = deterministicClientOutreach(
                    recipientNameInput?.value?.trim() || 'Alex Rivera',
                    companyInput?.value?.trim() || 'CloudScale Inc',
                    roleInput?.value?.trim() || 'VP of Operations',
                    websiteInput?.value?.trim() || 'cloudscale.io',
                    valueProp,
                    toneSelect?.value || 'professional',
                    ctaSelect?.value || 'Book a 15-minute intro call'
                );
                state.currentSequence = seq;
                state.currentSequenceId = 'seq_' + Date.now();
                state.useAlternativeSubject = false;

                state.savedSequences.unshift({
                    id: state.currentSequenceId,
                    recipient_name: recipientNameInput?.value?.trim() || 'Alex Rivera',
                    recipient_email: recipientEmailInput?.value?.trim() || '',
                    company: companyInput?.value?.trim() || 'CloudScale Inc',
                    role: roleInput?.value?.trim() || 'VP of Operations',
                    goal: valueProp,
                    tone: toneSelect?.value || 'professional',
                    initial_subject: seq.initial.subject,
                    initial_body: seq.initial.body,
                    followup_1_subject: seq.followup_1?.subject || '',
                    followup_1_body: seq.followup_1?.body || '',
                    followup_2_subject: seq.followup_2?.subject || '',
                    followup_2_body: seq.followup_2?.body || '',
                    status: 'Draft',
                    created_at: new Date().toISOString(),
                    steps: seq
                });
                try {
                    sessionStorage.setItem('jevexa_outreach_sequences_cache', JSON.stringify(state.savedSequences.slice(0, 30)));
                } catch (_) {}

                updateSequenceStatusPill('Draft');
                switchStep(1);
                setStatus('3-step outreach sequence generated successfully! (Sign in to sync with cloud CRM)', 'success');
                renderSavedSequencesList();
                state.requestInFlight = false;
                if (generateBtn) {
                    generateBtn.disabled = false;
                    generateBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> <span>Generate 3-Step Sequence</span>';
                }
                window.showToast?.('Outreach sequence generated! Ready to review and send.');
            }, 300);
            return;
        }

        const requestId = generateUuid();

        const payload = {
            lead_id: state.linkedLead?.id || leadSelect?.value || null,
            recipient_name: recipientNameInput?.value?.trim() || 'Prospect',
            recipient_email: recipientEmailInput?.value?.trim() || null,
            company: companyInput?.value?.trim() || null,
            role: roleInput?.value?.trim() || null,
            website: websiteInput?.value?.trim() || null,
            goal: valueProp,
            tone: toneSelect?.value || 'professional',
            call_to_action: ctaSelect?.value || 'Book a 15-minute intro call',
            personalization_depth: depthSelect?.value || 'standard',
            requestId
        };

        const outreachController = new AbortController();
        const outreachTimeoutId = setTimeout(() => outreachController.abort(), 35000);
        const outreachPreview = document.querySelector('#outreachWorkspace .outreach-pane-preview');
        try {
            const res = await fetch('/api/outreach/generate', {
                method: 'POST',
                signal: outreachController.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                    'Idempotency-Key': requestId
                },
                body: JSON.stringify(payload)
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 402) {
                    if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                        window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'Email & Outreach AI credits');
                    }
                }
                const err = new Error(data?.error || 'Sequence generation failed.');
                err.status = res.status;
                throw err;
            }

            state.currentSequence = data.sequence;
            state.currentSequenceId = data.sequence_id || null;
            state.useAlternativeSubject = false;
            const usage = window.JEVEXA_EXTRACT_CREDIT_USAGE?.(data);
            const outreachCharged = usage?.used ?? (Number.isInteger(data.charged_credits) ? data.charged_credits : (Number.isInteger(data.credits_used) ? data.credits_used : null));
            const outreachRemaining = usage?.remaining ?? data.remaining_credits;
            window.JEVEXA_RENDER_USED_CREDITS_FOOTER?.(outreachPreview, outreachCharged, {
                id: 'outreachCreditReceipt',
                remaining: outreachRemaining,
                tier: usage?.tier || data.tier
            });

            // Immediately update credits in UI
            if (typeof outreachRemaining === 'number') {
                if (typeof window.JEVEXA_UPDATE_CREDIT_BALANCE === 'function') {
                    window.JEVEXA_UPDATE_CREDIT_BALANCE(outreachRemaining);
                }
                if (typeof window.JEVEXA_SYNC_WORKSPACE_CREDITS === 'function') {
                    window.JEVEXA_SYNC_WORKSPACE_CREDITS();
                }
            }

            updateSequenceStatusPill('Draft');
            switchStep(1);
            const costText = outreachCharged !== null && outreachRemaining !== undefined
                ? ` (Used credit: ${outreachCharged} · Remaining credit: ${outreachRemaining})`
                : (outreachCharged ? ` (Used credit: ${outreachCharged})` : '');
            setStatus(`3-step outreach sequence generated successfully!${costText}`, 'success');
            await loadSavedSequences();

            if (typeof window.showToast === 'function') {
                window.showToast('Outreach sequence generated! Ready to review and send.');
            }
        } catch (err) {
            if (err?.status && err.status >= 400 && err.status < 500) {
                window.JEVEXA_CLEAR_USED_CREDITS_FOOTER?.(outreachPreview, 'outreachCreditReceipt');
                setStatus(err.message || 'Sequence generation failed.', 'error');
                if (typeof window.showToast === 'function') {
                    window.showToast(err.message || 'Sequence generation failed.');
                }
                return;
            }
            console.warn('Sequence generation notice, using deterministic fallback:', err);
            const fallbackSeq = deterministicClientOutreach(
                recipientNameInput?.value?.trim() || 'Alex Rivera',
                companyInput?.value?.trim() || 'CloudScale Inc',
                roleInput?.value?.trim() || 'VP of Operations',
                websiteInput?.value?.trim() || 'cloudscale.io',
                valueProp,
                toneSelect?.value || 'professional',
                ctaSelect?.value || 'Book a 15-minute intro call'
            );
            state.currentSequence = fallbackSeq;
            state.currentSequenceId = 'seq_' + Date.now();
            updateSequenceStatusPill('Draft');
            switchStep(1);
            window.JEVEXA_RENDER_USED_CREDITS_FOOTER?.(outreachPreview, 0, {
                id: 'outreachCreditReceipt',
                allowZero: true,
                note: 'Local engine (no charge)'
            });
            setStatus('Cloud AI unavailable — outreach sequence drafted locally (no credits charged).', 'info');
            if (typeof window.showToast === 'function') {
                window.showToast('Sequence drafted locally (no credits charged).');
            }
        } finally {
            clearTimeout(outreachTimeoutId);
            state.requestInFlight = false;
            if (generateBtn) {
                generateBtn.disabled = false;
                generateBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> <span>Generate 3-Step Sequence</span>';
            }
        }
    }

    // 1-Click Open in Gmail
    function handleOpenInGmail() {
        const to = recipientEmailInput?.value?.trim() || '';
        const subject = emailSubjectInput?.value?.trim() || '';
        const body = emailBodyInput?.value || '';

        const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        const fallbackMailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

        const win = window.open(gmailUrl, '_blank', 'noopener,noreferrer');
        if (!win || win.closed || typeof win.closed === 'undefined') {
            window.location.href = fallbackMailto;
            if (typeof window.showToast === 'function') {
                window.showToast('Opened email client.');
            }
        } else {
            if (typeof window.showToast === 'function') {
                window.showToast('Opened Gmail compose in new tab!');
            }
        }

        updateSequenceStatus('Opened in Gmail');
    }

    // Copy to Clipboard
    async function handleCopyEmail() {
        const subject = emailSubjectInput?.value?.trim() || '';
        const body = emailBodyInput?.value || '';
        const fullText = `Subject: ${subject}\n\n${body}`;

        if (typeof window.JEVEXA_COPY_TO_CLIPBOARD === 'function') {
            await window.JEVEXA_COPY_TO_CLIPBOARD(fullText, {
                button: copyEmailBtn,
                copiedHtml: '<i class="fas fa-check"></i> Copied!',
                toastMessage: 'Subject and email body copied to clipboard'
            });
            return;
        }
        try {
            await navigator.clipboard.writeText(fullText);
            window.showToast?.('Subject and email body copied to clipboard');
        } catch {
            const ta = document.createElement('textarea');
            ta.value = fullText;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (_) {}
            ta.remove();
            window.showToast?.('Copied to clipboard');
        }
    }

    // Mark as Sent & Sync CRM
    async function handleSyncCrm() {
        const session = await getSession();
        if (!session?.user?.id) {
            if (typeof window.openAuthModal === 'function') window.openAuthModal('signup');
            return;
        }

        const subject = emailSubjectInput?.value?.trim() || 'Outreach Email';
        const stepName = state.activeStep === 1 ? 'Initial Cold Email' : state.activeStep === 2 ? 'Day 3 Follow-up' : 'Day 7 Breakup Email';
        const leadId = state.linkedLead?.id || leadSelect?.value || null;

        try {
            await updateSequenceStatus('Sent');

            if (leadId) {
                const followupDate = new Date(Date.now() + 3 * 86400000).toISOString();
                
                // Try backend API first (only send valid UUID sequence IDs to /api/outreach/sequences)
                const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
                let synced = false;
                if (state.currentSequenceId && uuidPattern.test(state.currentSequenceId)) {
                    try {
                        const res = await fetch(`/api/outreach/sequences`, {
                            method: 'PATCH',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${session.access_token}`
                            },
                            body: JSON.stringify({
                                id: state.currentSequenceId,
                                status: 'Sent',
                                sync_crm: true,
                                lead_id: leadId
                            })
                        });
                        if (res.ok) synced = true;
                    } catch (_) {}
                }

                if (!synced && uuidPattern.test(String(leadId))) {
                    try {
                        const crmPatchRes = await fetch('/api/crm/leads', {
                            method: 'PATCH',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${session.access_token}`
                            },
                            body: JSON.stringify({
                                id: leadId,
                                stage: 'Contacted',
                                next_followup_at: followupDate
                            })
                        });
                        if (crmPatchRes.ok) synced = true;
                    } catch (_) {}
                }

                if (!synced) {
                    await window.supabaseClient
                        .from('crm_leads')
                        .update({
                            stage: 'Contacted',
                            last_contacted_at: new Date().toISOString(),
                            next_followup_at: followupDate,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', leadId)
                        .eq('user_id', session.user.id);

                    await window.supabaseClient
                        .from('crm_activities')
                        .insert({
                            user_id: session.user.id,
                            lead_id: leadId,
                            type: 'email_sent',
                            description: `Sent ${stepName} (${subject}). CRM stage moved to Contacted; follow-up scheduled in 3 days.`
                        });
                }

                if (typeof window.JEVEXA_CRM?.fetchLeads === 'function') {
                    window.JEVEXA_CRM.fetchLeads();
                }
            }

            if (typeof window.showToast === 'function') {
                window.showToast(`Marked as Sent! CRM synchronized (Stage: Contacted, Next follow-up: +3 days).`);
            }
        } catch (err) {
            console.error('CRM sync failed:', err);
            if (typeof window.showToast === 'function') {
                window.showToast('Could not sync with CRM: ' + err.message);
            }
        }
    }

    async function updateSequenceStatus(newStatus) {
        updateSequenceStatusPill(newStatus);
        if (!state.currentSequenceId) return;
        const session = await getSession();
        if (!session?.user?.id) return;

        try {
            await window.supabaseClient
                .from('outreach_sequences')
                .update({ status: newStatus })
                .eq('id', state.currentSequenceId)
                .eq('user_id', session.user.id);

            const saved = state.savedSequences.find(s => s.id === state.currentSequenceId);
            if (saved) saved.status = newStatus;
            renderSavedSequencesList();
        } catch (err) {
            console.warn('Update sequence status warning:', err);
        }
    }

    function updateSequenceStatusPill(status) {
        if (!sequenceStatusPill) return;
        sequenceStatusPill.textContent = status;
        sequenceStatusPill.className = `crm-stage-pill stage-${status.toLowerCase().replace(/\s+/g, '-')}`;
    }

    // History Drawer - Strict open/close state handling
    function openHistoryDrawer() {
        loadSavedSequences();
        if (historyDrawer) {
            historyDrawer.hidden = false;
            historyDrawer.removeAttribute('hidden');
            historyDrawer.classList.add('open');
            historyDrawer.setAttribute('aria-hidden', 'false');
        }
        if (historyBackdrop) {
            historyBackdrop.hidden = false;
            historyBackdrop.removeAttribute('hidden');
            historyBackdrop.classList.add('open');
            historyBackdrop.setAttribute('aria-hidden', 'false');
        }
    }

    function closeHistoryDrawer() {
        if (historyDrawer) {
            historyDrawer.classList.remove('open');
            historyDrawer.setAttribute('aria-hidden', 'true');
            historyDrawer.setAttribute('hidden', '');
            historyDrawer.hidden = true;
        }
        if (historyBackdrop) {
            historyBackdrop.classList.remove('open');
            historyBackdrop.setAttribute('aria-hidden', 'true');
            historyBackdrop.setAttribute('hidden', '');
            historyBackdrop.hidden = true;
        }
    }

    // Event Bindings
    function initEvents() {
        // Ensure starting closed
        closeHistoryDrawer();

        // Workspace back / close buttons
        bindSafe(backBtn, 'click', () => {
            closeHistoryDrawer();
            if (typeof window.returnToStudio === 'function') {
                window.returnToStudio();
            }
        });
        bindSafe(closeBtn, 'click', () => {
            closeHistoryDrawer();
            if (typeof window.returnToStudio === 'function') {
                window.returnToStudio();
            }
        });

        bindSafe(form, 'submit', handleGenerateSubmit);

        // Lead selector change
        bindSafe(leadSelect, 'change', (e) => {
            handleLeadSelection(e.target.value);
        });

        // Step tabs
        bindSafe(tabStep1, 'click', () => switchStep(1));
        bindSafe(tabStep2, 'click', () => switchStep(2));
        bindSafe(tabStep3, 'click', () => switchStep(3));

        // A/B Subject toggle
        bindSafe(abSubjectToggleBtn, 'click', toggleAbSubject);

        // Actions
        bindSafe(openGmailBtn, 'click', handleOpenInGmail);
        bindSafe(copyEmailBtn, 'click', handleCopyEmail);
        bindSafe(syncCrmBtn, 'click', handleSyncCrm);
        if (exportSeqBtn) bindSafe(exportSeqBtn, 'click', exportSequenceMarkdown);

        // History Drawer
        bindSafe(historyBtn, 'click', openHistoryDrawer);
        bindSafe(historyCloseBtn, 'click', closeHistoryDrawer);
        bindSafe(historyBackdrop, 'click', closeHistoryDrawer);

        // Escape key to close drawer safely with event propagation stopped
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || e.key === 'Esc') {
                const isDrawerOpen = historyDrawer && (!historyDrawer.hidden || historyDrawer.classList.contains('open'));
                if (isDrawerOpen) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    closeHistoryDrawer();
                }
            }
        });

        // Update active sequence fields when user types in inputs
        if (emailSubjectInput) {
            emailSubjectInput.addEventListener('input', () => {
                if (!state.currentSequence) return;
                if (state.activeStep === 1) {
                    if (state.useAlternativeSubject) state.currentSequence.initial.alternative_subject = emailSubjectInput.value;
                    else state.currentSequence.initial.subject = emailSubjectInput.value;
                }
                else if (state.activeStep === 2) state.currentSequence.followup_1.subject = emailSubjectInput.value;
                else state.currentSequence.followup_2.subject = emailSubjectInput.value;
            });
        }
        if (emailBodyInput) {
            emailBodyInput.addEventListener('input', () => {
                if (!state.currentSequence) return;
                if (state.activeStep === 1) state.currentSequence.initial.body = emailBodyInput.value;
                else if (state.activeStep === 2) state.currentSequence.followup_1.body = emailBodyInput.value;
                else state.currentSequence.followup_2.body = emailBodyInput.value;
            });
        }
    }

    function exportSequenceMarkdown() {
        if (!state.currentSequence) {
            window.showToast?.('Please generate a sequence first.');
            return;
        }
        const pName = recipientNameInput?.value?.trim() || 'Prospect';
        const pComp = companyInput?.value?.trim() || 'Company';
        const seq = state.currentSequence;
        const md = `# JEVEXA OUTREACH SEQUENCE\nProspect: ${pName} (${pComp})\nExported: ${new Date().toISOString()}\n\n---\n\n## Step 1: Initial Cold Email\n**Subject:** ${seq.initial?.subject || ''}\n${seq.initial?.alternative_subject ? `**Alternative Subject (A/B Test):** ${seq.initial.alternative_subject}\n` : ''}\n${seq.initial?.body || ''}\n\n---\n\n## Step 2: Day 3 Follow-up\n**Subject:** ${seq.followup_1?.subject || `Re: ${seq.initial?.subject || ''}`}\n\n${seq.followup_1?.body || ''}\n\n---\n\n## Step 3: Day 7 Breakup Email\n**Subject:** ${seq.followup_2?.subject || 'Final Check-In'}\n\n${seq.followup_2?.body || ''}\n`;
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Jevexa_Outreach_Sequence_${pName.replace(/\s+/g, '_')}.md`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        window.showToast?.('3-step sequence exported as Markdown file!');
    }

    // Public API
    window.JEVEXA_OUTREACH = {
        init: () => {
            loadCrmLeads();
            loadSavedSequences();
        },
        loadCrmLeads,
        loadSavedSequences,
        prefillLead: prefillLead,
        openWithLead: prefillLead,
        switchStep,
        exportSequence: exportSequenceMarkdown,
        openHistoryDrawer,
        closeHistoryDrawer,
        getSequences: () => state.savedSequences,
        getCurrentSequence: () => state.currentSequence,
        resetOnLogout: () => {
            state.savedSequences = [];
            state.crmLeads = [];
            state.linkedLead = null;
            state.currentSequenceId = null;
            state.useAlternativeSubject = false;
            state.requestInFlight = false;
            state.currentSequence = JSON.parse(JSON.stringify(DEFAULT_SEQUENCE));
            try {
                sessionStorage.removeItem('jevexa_outreach_sequences_cache');
                localStorage.removeItem('jevexa_cached_outreach_sequences');
            } catch (_) {}
            window.JEVEXA_CLEAR_USED_CREDITS_FOOTER?.(document.querySelector('#outreachWorkspace .outreach-pane-preview'), 'outreachCreditReceipt');
            if (leadSelect) leadSelect.innerHTML = '<option value="">-- Manual Entry Mode --</option>';
            if (recipientNameInput) recipientNameInput.value = 'Alex Rivera';
            if (recipientEmailInput) recipientEmailInput.value = '';
            if (companyInput) companyInput.value = 'CloudScale Inc';
            if (roleInput) roleInput.value = 'VP of Operations';
            if (websiteInput) websiteInput.value = '';
            if (valuePropInput) valuePropInput.value = 'Scale operational productivity and qualification speed with AI automation.';
            closeHistoryDrawer();
            renderSavedSequencesList();
            switchStep(1);
        }
    };

    const DEFAULT_SEQUENCE = {
        initial: {
            subject: 'Scaling CloudScale Inc with AI workflows',
            alternative_subject: 'Quick question regarding CloudScale Inc operations',
            body: `Hi Alex,\n\nI noticed CloudScale Inc is scaling its infrastructure offerings. When rapidly growing B2B teams expand, outbound personalization and document workflows often create operational bottlenecks.\n\nAt JEVEXA, we built an integrated 10-tool AI studio that automates customer outreach, lead scoring, and document extraction with high reliability.\n\nWould you be open to a 10-minute chat this Thursday at 2 PM to explore how this fits into your current workflow?\n\nBest regards,\n[Your Name]`
        },
        followup_1: {
            day: 'Day 3',
            subject: 'Re: Scaling CloudScale Inc with AI workflows',
            body: `Hi Alex,\n\nFollowing up on my note from earlier this week. We recently helped a similar B2B team streamline routine lead qualification and follow-up sequences so reps spend more time closing.\n\nHappy to share a short workflow breakdown if you are interested.\n\nBest,\n[Your Name]`
        },
        followup_2: {
            day: 'Day 7',
            subject: 'Final note: CloudScale Inc & AI automation',
            body: `Hi Alex,\n\nI realize you are likely heads-down scaling the business, so I will pause my outreach here.\n\nIf you ever look to streamline customer data extraction and automated outreach without managing multiple disjointed tools, feel free to reach out anytime at jevexa.net.\n\nWishing you and CloudScale Inc continued growth!\n\nBest,\n[Your Name]`
        }
    };

    function checkAutoMount() {
        loadCachedSequences();
        initEvents();
        loadCrmLeads();
        if (!state.currentSequence) {
            state.currentSequence = JSON.parse(JSON.stringify(DEFAULT_SEQUENCE));
            if (recipientNameInput && !recipientNameInput.value) recipientNameInput.value = 'Alex Rivera';
            if (companyInput && !companyInput.value) companyInput.value = 'CloudScale Inc';
            if (roleInput && !roleInput.value) roleInput.value = 'VP of Operations';
            if (valuePropInput && !valuePropInput.value) valuePropInput.value = 'Scale operational productivity and qualification speed with AI automation.';
            switchStep(1);
        }
        if (workspace && (!workspace.hidden || workspace.classList.contains('open') || window.location.pathname === '/tools/outreach')) {
            loadSavedSequences();
        }
        window.dispatchEvent(new CustomEvent('outreach:ready'));
        document.dispatchEvent(new CustomEvent('outreach:ready'));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkAutoMount);
    } else {
        checkAutoMount();
    }
})();
