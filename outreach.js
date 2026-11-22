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
                state.crmLeads = data;
                const options = [
                    '<option value="">-- Manual Entry / Custom Prospect --</option>',
                    ...data.map(lead => {
                        const label = lead.company ? `${lead.name} (${lead.company})` : lead.name;
                        return `<option value="${lead.id}">${escapeHtml(label)}</option>`;
                    })
                ];
                leadSelect.innerHTML = options.join('');
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

        if (valuePropInput && !valuePropInput.value.trim()) {
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
                    loadSequenceIntoWorkspace(seq);
                    closeHistoryDrawer();
                }
            });
        });

        historyList.querySelectorAll('.del-seq-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this outreach sequence?')) return;
                await deleteSavedSequence(btn.dataset.seqId);
            });
        });
    }

    async function deleteSavedSequence(seqId) {
        const session = await getSession();
        if (!session?.user?.id) return;
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
                await window.supabaseClient
                    .from('outreach_sequences')
                    .delete()
                    .eq('id', seqId)
                    .eq('user_id', session.user.id);
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
        state.currentSequence = {
            initial: {
                subject: seq.initial_subject || '',
                alternative_subject: seq.initial_subject ? `Alternative: ${seq.initial_subject}` : '',
                body: seq.initial_body || ''
            },
            followup_1: {
                day: 'Day 3',
                subject: seq.followup_1_subject || (seq.initial_subject ? `Re: ${seq.initial_subject}` : ''),
                body: seq.followup_1_body || ''
            },
            followup_2: {
                day: 'Day 7',
                subject: seq.followup_2_subject || (seq.initial_subject ? `Final note: ${seq.initial_subject}` : ''),
                body: seq.followup_2_body || ''
            }
        };

        if (recipientNameInput) recipientNameInput.value = seq.recipient_name || '';
        if (recipientEmailInput) recipientEmailInput.value = seq.recipient_email || '';
        if (companyInput) companyInput.value = seq.company || '';
        if (valuePropInput) valuePropInput.value = seq.goal || '';
        if (toneSelect && seq.tone) toneSelect.value = seq.tone;

        if (seq.lead_id && leadSelect) {
            leadSelect.value = seq.lead_id;
            state.linkedLead = state.crmLeads.find(l => l.id === seq.lead_id) || null;
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

    // Generate 3-Step Sequence Submit
    async function handleGenerateSubmit(e) {
        e.preventDefault();
        if (state.requestInFlight) return;

        const session = await getSession();
        if (!session?.user?.id) {
            if (typeof window.openAuthModal === 'function') window.openAuthModal('signup');
            else if (typeof window.openLogin === 'function') window.openLogin();
            return;
        }

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

        try {
            const res = await fetch('/api/outreach/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                    'Idempotency-Key': requestId
                },
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (!res.ok) {
                if (res.status === 402) {
                    if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                        window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'Email & Outreach AI credits');
                    }
                }
                throw new Error(data?.error || 'Sequence generation failed.');
            }

            state.currentSequence = data.sequence;
            state.currentSequenceId = data.sequence_id || null;
            state.useAlternativeSubject = false;

            // Immediately update credits in UI
            if (typeof data.remaining_credits === 'number') {
                if (typeof window.JEVEXA_UPDATE_CREDIT_BALANCE === 'function') {
                    window.JEVEXA_UPDATE_CREDIT_BALANCE(data.remaining_credits);
                }
                if (typeof window.JEVEXA_SYNC_WORKSPACE_CREDITS === 'function') {
                    window.JEVEXA_SYNC_WORKSPACE_CREDITS();
                }
            }

            updateSequenceStatusPill('Draft');
            switchStep(1);
            setStatus('3-step outreach sequence generated successfully!', 'success');
            await loadSavedSequences();

            if (typeof window.showToast === 'function') {
                window.showToast('Outreach sequence generated! Ready to review and send.');
            }
        } catch (err) {
            console.error('Sequence generation error:', err);
            setStatus(err.message || 'Could not generate sequence.', 'error');
            if (typeof window.showToast === 'function') {
                window.showToast(err.message || 'Generation failed.');
            }
        } finally {
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

        try {
            await navigator.clipboard.writeText(fullText);
            if (typeof window.showToast === 'function') {
                window.showToast('Subject and email body copied to clipboard!');
            }
        } catch {
            const ta = document.createElement('textarea');
            ta.value = fullText;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            if (typeof window.showToast === 'function') {
                window.showToast('Copied to clipboard!');
            }
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
                
                // Try backend API first
                let synced = false;
                if (state.currentSequenceId) {
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
                if (state.activeStep === 1) state.currentSequence.initial.subject = emailSubjectInput.value;
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
        openHistoryDrawer,
        closeHistoryDrawer,
        getSequences: () => state.savedSequences,
        getCurrentSequence: () => state.currentSequence
    };

    function checkAutoMount() {
        loadCachedSequences();
        initEvents();
        loadCrmLeads();
        if (workspace && (!workspace.hidden || workspace.classList.contains('open') || window.location.pathname === '/tools/outreach')) {
            loadSavedSequences();
        }
        window.dispatchEvent(new CustomEvent('outreach:ready'));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkAutoMount);
    } else {
        checkAutoMount();
    }
})();
