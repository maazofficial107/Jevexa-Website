/**
 * JEVEXA AI Studio - User & Admin Management Workspace Controller
 * Handles team member roster, role provisioning (Owner, Admin, Member, Viewer),
 * granular RBAC permission matrix display, and audit log tracking with CSV export.
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

    const DEFAULT_MEMBERS = [
        {
            id: 'mem_1',
            name: 'Sarah Jenkins',
            email: 'sarah.jenkins@jevexa-org.io',
            role: 'Owner',
            status: 'Active',
            last_active_at: new Date(Date.now() - 1000 * 60 * 12).toISOString()
        },
        {
            id: 'mem_2',
            name: 'David Zhao',
            email: 'david.zhao@jevexa-org.io',
            role: 'Admin',
            status: 'Active',
            last_active_at: new Date(Date.now() - 1000 * 60 * 65).toISOString()
        }
    ];

    const DEFAULT_AUDIT_LOGS = [
        {
            timestamp: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
            action: 'Role Changed',
            actor: 'Sarah Jenkins (Owner)',
            details: 'Assigned role Admin to david.zhao@jevexa-org.io',
            status: 'Success'
        },
        {
            timestamp: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
            action: 'Member Invited',
            actor: 'Sarah Jenkins (Owner)',
            details: 'Dispatched workspace invitation to elena.r@jevexa-org.io as Member',
            status: 'Success'
        },
        {
            timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
            action: 'Security Policy Updated',
            actor: 'System Automation',
            details: 'Enforced 2FA and RBAC matrix policy for enterprise workspace',
            status: 'Success'
        }
    ];

    const MEMBERS_STORAGE_KEY = 'jevexa_team_members_cache';
    const AUDIT_STORAGE_KEY = 'jevexa_team_audit_cache';

    function loadCachedTeamMembers() {
        try {
            const raw = localStorage.getItem(MEMBERS_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            }
        } catch (_) {}
        return null;
    }

    function loadCachedAuditLogs() {
        try {
            const raw = localStorage.getItem(AUDIT_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            }
        } catch (_) {}
        return null;
    }

    function saveCachedTeam() {
        try {
            localStorage.setItem(MEMBERS_STORAGE_KEY, JSON.stringify(state.members));
            localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(state.auditLogs));
        } catch (_) {}
    }

    const state = {
        members: loadCachedTeamMembers() || [...DEFAULT_MEMBERS],
        auditLogs: loadCachedAuditLogs() || [...DEFAULT_AUDIT_LOGS],
        maxSeats: 3,
        userTier: 'free',
        isLoading: false
    };

    // DOM Elements
    const workspace = document.getElementById('teamAdminWorkspace');
    const backBtn = document.getElementById('teamAdminBackToStudio');
    const closeBtn = document.getElementById('teamAdminWorkspaceClose');

    const seatCounterEl = document.getElementById('teamSeatCounter');
    const planBadgeEl = document.getElementById('teamPlanBadge');
    const roleSummaryEl = document.getElementById('teamRoleSummary');
    const statusEl = document.getElementById('teamAdminStatus');
    const inviteBtn = document.getElementById('teamInviteModalBtn');

    // Members Table
    const memberTableBody = document.getElementById('teamMemberTableBody');
    const memberCountEl = document.getElementById('teamMemberCount');

    // Invite Modal
    const inviteModal = document.getElementById('teamInviteModal');
    const inviteModalClose = document.getElementById('teamInviteClose');
    const inviteModalCancel = document.getElementById('teamInviteCancel');
    const inviteForm = document.getElementById('teamInviteForm');
    const inviteEmailInput = document.getElementById('teamInviteEmail');
    const inviteRoleSelect = document.getElementById('teamInviteRole');
    const inviteErrorEl = document.getElementById('teamInviteError');

    // Audit Log Section
    const auditTableBody = document.getElementById('teamAuditTableBody');
    const exportAuditCsvBtn = document.getElementById('teamExportAuditCsvBtn');
    const refreshAuditBtn = document.getElementById('teamRefreshAuditBtn');

    function setAdminStatus(message, type = 'info') {
        if (!statusEl) return;
        statusEl.textContent = message || '';
        statusEl.className = message ? `team-status-msg ${type}` : 'team-status-msg';
    }

    function setInviteError(message) {
        if (!inviteErrorEl) return;
        if (!message) {
            inviteErrorEl.textContent = '';
            inviteErrorEl.hidden = true;
            inviteErrorEl.setAttribute('hidden', '');
        } else {
            inviteErrorEl.textContent = message;
            inviteErrorEl.hidden = false;
            inviteErrorEl.removeAttribute('hidden');
        }
    }

    async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
    }

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

    async function fetchTeamMembers() {
        const session = await getSession();
        if (!session) return;

        try {
            const res = await fetchWithTimeout('/api/team/members', {
                headers: { 'Authorization': `Bearer ${session.access_token}` }
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && Array.isArray(data.members)) {
                state.members = data.members;
                state.maxSeats = data.maxSeats || 3;
                state.userTier = data.tier || 'free';
                saveCachedTeam();
                renderMembers();
                const usage = window.JEVEXA_EXTRACT_CREDIT_USAGE?.(data);
                window.JEVEXA_RENDER_USED_CREDITS_FOOTER?.(
                    document.querySelector('#teamAdminWorkspace .team-roster-card'),
                    0,
                    {
                        id: 'teamCreditReceipt',
                        allowZero: true,
                        tier: state.userTier,
                        remaining: usage?.remaining,
                        note: 'Included in plan'
                    }
                );
            } else if (!res.ok) {
                setAdminStatus(data.error || 'Could not load team members from server.', 'error');
            }
        } catch (err) {
            console.warn('Failed to load team members from API:', err);
        }
    }

    async function fetchAuditLogs() {
        const session = await getSession();
        if (!session) return;

        try {
            const res = await fetchWithTimeout('/api/team/audit', {
                headers: { 'Authorization': `Bearer ${session.access_token}` }
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && Array.isArray(data.logs) && data.logs.length > 0) {
                state.auditLogs = data.logs;
                saveCachedTeam();
                renderAuditLogs();
            }
        } catch (err) {
            console.warn('Failed to load audit logs from API:', err);
        }
    }

    // Helper to sync member changes when authenticated
    async function syncTeamMemberMutation(method, payload, query = '') {
        const session = await getSession();
        if (!session) return { localOnly: true };
        try {
            const res = await fetchWithTimeout(`/api/team/members${query}`, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: payload ? JSON.stringify(payload) : undefined
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                return { error: data.error || 'Could not update team member on server.', status: res.status };
            }
            return { ok: true, data };
        } catch (err) {
            return { offlineFallback: true, error: err?.message };
        }
    }

    function findMemberByButton(el) {
        const targetId = el?.dataset?.memberId || '';
        const targetEmail = (el?.dataset?.email || '').toLowerCase();
        return state.members.find(m =>
            (targetId && String(m.id) === String(targetId))
            || (targetEmail && String(m.email || '').toLowerCase() === targetEmail)
        );
    }

    function renderMembers() {
        if (seatCounterEl) {
            seatCounterEl.innerHTML = `<strong>${state.members.length} / ${state.maxSeats}</strong> Seats Used`;
        }
        if (planBadgeEl) {
            planBadgeEl.textContent = `${state.userTier.toUpperCase()} PLAN`;
        }
        if (memberCountEl) {
            memberCountEl.textContent = `${state.members.length} ${state.members.length === 1 ? 'Member' : 'Members'}`;
        }
        if (roleSummaryEl) {
            const counts = { Owner: 0, Admin: 0, Member: 0, Viewer: 0 };
            state.members.forEach(m => {
                if (counts[m.role] !== undefined) counts[m.role] += 1;
            });
            const openSeats = Math.max(0, state.maxSeats - state.members.length);
            roleSummaryEl.textContent = `${counts.Owner} Owner · ${counts.Admin} Admin · ${counts.Member} Member · ${counts.Viewer} Viewer · ${openSeats} open ${openSeats === 1 ? 'seat' : 'seats'} (${state.userTier.toUpperCase()})`;
        }
        if (inviteBtn) {
            inviteBtn.title = state.members.length >= state.maxSeats
                ? `Seat limit reached (${state.members.length}/${state.maxSeats})`
                : 'Invite a new team member';
        }

        if (!memberTableBody) return;
        memberTableBody.innerHTML = '';

        state.members.forEach(member => {
            const tr = document.createElement('tr');
            const isOwner = member.role === 'Owner';
            const statusText = member.status || 'Active';
            const isSuspended = statusText === 'Suspended';
            const isPending = statusText === 'Pending Invite';
            const statusClass = isSuspended ? 'suspended' : (isPending ? 'pending' : 'active');
            const statusBg = isSuspended
                ? 'rgba(239,68,68,0.15)'
                : (isPending ? 'rgba(250,204,21,0.15)' : 'rgba(34,197,94,0.15)');
            const statusColor = isSuspended ? '#f87171' : (isPending ? '#facc15' : '#4ade80');
            const statusBorder = isSuspended
                ? 'rgba(239,68,68,0.3)'
                : (isPending ? 'rgba(250,204,21,0.3)' : 'rgba(34,197,94,0.3)');
            const statusIcon = isSuspended ? 'ban' : (isPending ? 'clock' : 'check-circle');
            const lastActiveLabel = member.last_active_at && !Number.isNaN(Date.parse(member.last_active_at))
                ? new Date(member.last_active_at).toLocaleDateString()
                : (member.last_active_at || 'Active now');

            tr.innerHTML = `
                <td>
                    <div class="team-member-cell" style="display:flex; align-items:center; gap:10px;">
                        <div class="team-avatar" style="width:34px; height:34px; border-radius:50%; background:linear-gradient(135deg, #38bdf8, #818cf8); display:flex; align-items:center; justify-content:center; font-weight:700; color:#fff; font-size:13px;">${escapeHtml((member.name || 'U').charAt(0).toUpperCase())}</div>
                        <div>
                            <strong style="color:#f1f5f9; display:block; font-size:13px;">${escapeHtml(member.name || 'Team Member')}</strong>
                            <span class="team-email" style="font-size:11.5px; color:#94a3b8;">${escapeHtml(member.email || '')}</span>
                        </div>
                    </div>
                </td>
                <td>
                    ${isOwner ? '<span class="team-role-pill role-owner" style="padding:3px 8px; border-radius:6px; font-size:11.5px; font-weight:700; background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);">Owner</span>' : `
                        <select class="team-role-select crm-select" data-member-id="${escapeHtml(member.id || '')}" data-email="${escapeHtml(member.email)}" aria-label="Change role for ${escapeHtml(member.email)}" style="padding:4px 8px; font-size:12px;">
                            <option value="Admin"${member.role === 'Admin' ? ' selected' : ''}>Admin</option>
                            <option value="Member"${member.role === 'Member' ? ' selected' : ''}>Member</option>
                            <option value="Viewer"${member.role === 'Viewer' ? ' selected' : ''}>Viewer</option>
                        </select>
                    `}
                </td>
                <td>
                    ${isOwner ? '<span class="team-status-pill status-active" style="padding:3px 8px; border-radius:6px; font-size:11.5px; font-weight:700; background:rgba(34,197,94,0.15); color:#4ade80; border:1px solid rgba(34,197,94,0.3);">Active</span>' : `
                        <button type="button" class="team-status-toggle status-${statusClass}" data-member-id="${escapeHtml(member.id || '')}" data-email="${escapeHtml(member.email)}" title="Click to toggle status" style="cursor:pointer; padding:3px 8px; border-radius:6px; font-size:11.5px; font-weight:700; background:${statusBg}; color:${statusColor}; border:1px solid ${statusBorder};">
                            <i class="fas fa-${statusIcon}"></i> ${escapeHtml(statusText)}
                        </button>
                    `}
                </td>
                <td><span class="team-last-active" style="font-size:12px; color:#cbd5e1;">${escapeHtml(lastActiveLabel)}</span></td>
                <td>
                    ${isOwner ? '<span class="team-action-locked" style="font-size:11.5px; color:#64748b; font-style:italic;">Primary Owner</span>' : `
                        <button type="button" class="btn btn-xs btn-outline team-remove-btn" data-member-id="${escapeHtml(member.id || '')}" data-email="${escapeHtml(member.email)}" style="font-size:11px; padding:3px 8px;">Remove</button>
                    `}
                </td>
            `;
            memberTableBody.appendChild(tr);
        });

        // Event listeners for role change, status toggle, remove
        memberTableBody.querySelectorAll('.team-role-select').forEach(sel => {
            sel.addEventListener('change', async (e) => {
                const selectEl = e.currentTarget;
                const targetMember = findMemberByButton(selectEl);
                if (!targetMember) return;
                const newRole = selectEl.value;
                const prevRole = targetMember.role;
                if (newRole === prevRole) return;
                selectEl.disabled = true;
                const res = await syncTeamMemberMutation('PATCH', { id: targetMember.id, email: targetMember.email, role: newRole });
                selectEl.disabled = false;
                if (res.error && res.status && res.status >= 400) {
                    selectEl.value = prevRole;
                    setAdminStatus(res.error, 'error');
                    window.showToast?.(res.error);
                    return;
                }
                targetMember.role = newRole;
                state.auditLogs.unshift({
                    timestamp: new Date().toISOString(),
                    action: "Role Changed",
                    actor: "Workspace Admin",
                    details: `Assigned role ${newRole} to ${targetMember.email}`,
                    status: "Success"
                });
                renderMembers();
                renderAuditLogs();
                setAdminStatus(`Updated role of ${targetMember.email} to ${newRole}.`, 'success');
                window.showToast?.(`Updated role of ${targetMember.email} to ${newRole}.`);
            });
        });

        memberTableBody.querySelectorAll('.team-status-toggle').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const btnEl = e.currentTarget;
                const targetMember = findMemberByButton(btnEl);
                if (!targetMember) return;
                const nextStatus = targetMember.status === 'Active' ? 'Suspended' : 'Active';
                btnEl.disabled = true;
                const res = await syncTeamMemberMutation('PATCH', { id: targetMember.id, email: targetMember.email, status: nextStatus });
                btnEl.disabled = false;
                if (res.error && res.status && res.status >= 400) {
                    setAdminStatus(res.error, 'error');
                    window.showToast?.(res.error);
                    return;
                }
                targetMember.status = nextStatus;
                state.auditLogs.unshift({
                    timestamp: new Date().toISOString(),
                    action: "Status Changed",
                    actor: "Workspace Admin",
                    details: `Set ${targetMember.email} status to ${targetMember.status}`,
                    status: "Success"
                });
                renderMembers();
                renderAuditLogs();
                setAdminStatus(`Member ${targetMember.email} is now ${targetMember.status}.`, 'success');
                window.showToast?.(`Member ${targetMember.email} is now ${targetMember.status}.`);
            });
        });

        memberTableBody.querySelectorAll('.team-remove-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const btnEl = e.currentTarget;
                const targetMember = findMemberByButton(btnEl);
                if (!targetMember) return;
                const targetEmail = targetMember.email;
                const query = targetMember.id
                    ? `?id=${encodeURIComponent(targetMember.id)}&email=${encodeURIComponent(targetEmail)}`
                    : `?email=${encodeURIComponent(targetEmail)}`;
                btnEl.disabled = true;
                const res = await syncTeamMemberMutation('DELETE', null, query);
                btnEl.disabled = false;
                if (res.error && res.status && res.status >= 400) {
                    setAdminStatus(res.error, 'error');
                    window.showToast?.(res.error);
                    return;
                }
                state.members = state.members.filter(m =>
                    targetMember.id ? String(m.id) !== String(targetMember.id) : m.email.toLowerCase() !== targetEmail.toLowerCase()
                );
                state.auditLogs.unshift({
                    timestamp: new Date().toISOString(),
                    action: "Member Removed",
                    actor: "Workspace Admin",
                    details: `Revoked workspace access for ${targetEmail}`,
                    status: "Success"
                });
                renderMembers();
                renderAuditLogs();
                setAdminStatus(`Removed member ${targetEmail}. Seats used: ${state.members.length} / ${state.maxSeats}.`, 'info');
                window.showToast?.(`Removed member ${targetEmail}.`);
            });
        });
        saveCachedTeam();
    }

    function renderAuditLogs() {
        if (!auditTableBody) return;
        auditTableBody.innerHTML = '';

        state.auditLogs.forEach(log => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="audit-time" style="font-size:12px; color:#cbd5e1;">${new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></td>
                <td><strong style="font-size:12.5px; color:#f1f5f9;">${escapeHtml(log.action)}</strong></td>
                <td><span class="audit-actor" style="font-size:12px; color:#38bdf8;">${escapeHtml(log.actor)}</span></td>
                <td><span class="audit-details" style="font-size:12px; color:#cbd5e1;">${escapeHtml(log.details)}</span></td>
                <td><span class="audit-status-badge status-ok" style="padding:2px 6px; border-radius:4px; font-size:11px; background:rgba(34,197,94,0.15); color:#4ade80; border:1px solid rgba(34,197,94,0.3);">${escapeHtml(log.status)}</span></td>
            `;
            auditTableBody.appendChild(tr);
        });
        saveCachedTeam();
    }

    function openInviteModal() {
        setInviteError('');
        if (state.members.length >= state.maxSeats) {
            const msg = `Seat limit reached (${state.members.length}/${state.maxSeats}) for ${state.userTier.toUpperCase()} plan. Remove a member or upgrade your plan to invite more.`;
            setAdminStatus(msg, 'error');
            window.showToast?.(msg);
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'Additional workspace seats');
            }
            return;
        }
        if (inviteModal) {
            inviteModal.hidden = false;
            inviteModal.removeAttribute('hidden');
            inviteModal.classList.add('open');
            if (inviteEmailInput) {
                inviteEmailInput.value = '';
                inviteEmailInput.focus();
            }
        }
    }

    function closeInviteModal() {
        setInviteError('');
        if (inviteModal) {
            inviteModal.hidden = true;
            inviteModal.setAttribute('hidden', '');
            inviteModal.classList.remove('open');
        }
        if (inviteForm) inviteForm.reset();
    }

    async function handleInviteSubmit(e) {
        if (e) e.preventDefault();
        setInviteError('');
        const email = inviteEmailInput ? inviteEmailInput.value.trim().toLowerCase() : '';
        const rawRole = inviteRoleSelect ? inviteRoleSelect.value : 'Member';
        const role = ['Admin', 'Member', 'Viewer'].includes(rawRole) ? rawRole : 'Member';
        const submitBtn = document.getElementById('teamInviteSubmitBtn');

        if (!email) {
            setInviteError('Please enter a colleague email address.');
            window.showToast?.('Please enter an email address.');
            inviteEmailInput?.focus();
            return;
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
            setInviteError('Please enter a valid work email address (e.g. alex@company.com).');
            window.showToast?.('Please enter a valid email address.');
            inviteEmailInput?.focus();
            return;
        }

        if (state.members.some(m => (m.email || '').toLowerCase() === email)) {
            const dupMsg = `Member with email ${email} is already in the workspace.`;
            setInviteError(dupMsg);
            window.showToast?.(dupMsg);
            inviteEmailInput?.focus();
            return;
        }

        if (state.members.length >= state.maxSeats) {
            const capMsg = `Seat limit reached (${state.members.length}/${state.maxSeats}) for ${state.userTier.toUpperCase()} plan.`;
            setInviteError(capMsg);
            window.showToast?.(capMsg);
            return;
        }

        if (submitBtn) submitBtn.disabled = true;

        if (window.JEVEXA_CONNECTIVITY?.isOnline() === false || (typeof navigator !== 'undefined' && !navigator.onLine)) {
            setAdminStatus('You are currently offline. Please reconnect to sync team members.', 'error');
            window.showToast?.('⚠️ You are currently offline. Reconnect to manage workspace team.');
            return;
        }

        try {
            const session = await getSession();
            if (!session) {
                // Local client provisioning for guest / demo mode
                const newMember = {
                    id: 'mem_' + Date.now(),
                    name: email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                    email,
                    role,
                    status: 'Pending Invite',
                    last_active_at: new Date().toISOString()
                };
                state.members.push(newMember);
                state.auditLogs.unshift({
                    timestamp: new Date().toISOString(),
                    action: "Member Invited",
                    actor: "Workspace Admin",
                    details: `Dispatched workspace invitation to ${email} as ${role}`,
                    status: "Success"
                });
                renderMembers();
                renderAuditLogs();
                closeInviteModal();
                setAdminStatus(`Invitation dispatched to ${email} as ${role} (${state.members.length}/${state.maxSeats} seats used).`, 'success');
                window.showToast?.(`Invitation dispatched to ${email} as ${role}!`);
                return;
            }

            try {
                const res = await fetchWithTimeout('/api/team/invite', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${session.access_token}`
                    },
                    body: JSON.stringify({ email, role, currentMemberCount: state.members.length })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    if (res.status === 402 || res.status === 403) {
                        window.JEVEXA_SHOW_UPGRADE_MODAL?.('Pro', 'Team seat expansion');
                    }
                    const err = new Error(data.error || 'Failed to dispatch invitation.');
                    err.status = res.status;
                    throw err;
                }

                state.members.push(data.member || {
                    id: 'mem_' + Date.now(),
                    name: email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                    email,
                    role,
                    status: 'Pending Invite',
                    last_active_at: new Date().toISOString()
                });
                state.auditLogs.unshift({
                    timestamp: new Date().toISOString(),
                    action: "Member Invited",
                    actor: "Workspace Admin",
                    details: `Dispatched workspace invitation to ${email} as ${role}`,
                    status: "Success"
                });
                saveCachedTeam();
                renderMembers();
                renderAuditLogs();
                closeInviteModal();
                const inviteUsage = window.JEVEXA_EXTRACT_CREDIT_USAGE?.(data);
                window.JEVEXA_RENDER_USED_CREDITS_FOOTER?.(
                    document.querySelector('#teamAdminWorkspace .team-roster-card'),
                    0,
                    {
                        id: 'teamCreditReceipt',
                        allowZero: true,
                        tier: state.userTier,
                        remaining: inviteUsage?.remaining,
                        note: 'Included in plan'
                    }
                );
                setAdminStatus(`Invitation sent to ${email} as ${role} (${state.members.length}/${state.maxSeats} seats used).`, 'success');
                window.showToast?.(`Invitation sent to ${email} as ${role}!`);
            } catch (err) {
                if (err?.status && err.status >= 400) {
                    setInviteError(err.message || 'Could not invite team member.');
                    window.showToast?.(err.message || 'Could not invite team member.');
                    return;
                }
                console.warn('API invite failed, using local member addition:', err);
                const fallbackMember = {
                    id: 'mem_' + Date.now(),
                    name: email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                    email,
                    role,
                    status: 'Pending Invite',
                    last_active_at: new Date().toISOString()
                };
                state.members.push(fallbackMember);
                state.auditLogs.unshift({
                    timestamp: new Date().toISOString(),
                    action: "Member Invited",
                    actor: "Workspace Admin",
                    details: `Dispatched workspace invitation to ${email} as ${role}`,
                    status: "Success"
                });
                saveCachedTeam();
                renderMembers();
                renderAuditLogs();
                closeInviteModal();
                setAdminStatus(`Invitation saved locally for ${email} as ${role}.`, 'info');
                window.showToast?.(`Invitation sent to ${email} as ${role}!`);
            }
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]);
    }

    let initialized = false;
    function init() {
        if (initialized) return;
        initialized = true;
        bindSafe(backBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(closeBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());

        bindSafe(inviteBtn, 'click', openInviteModal);
        bindSafe(inviteModalClose, 'click', closeInviteModal);
        bindSafe(inviteModalCancel, 'click', closeInviteModal);
        bindSafe(inviteForm, 'submit', handleInviteSubmit);

        if (inviteModal) {
            bindSafe(inviteModal, 'click', (e) => {
                if (e.target === inviteModal) closeInviteModal();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !inviteModal.hidden) {
                    e.stopPropagation();
                    closeInviteModal();
                }
            });
        }

        // Refresh button with animation and timestamp feedback
        bindSafe(refreshAuditBtn, 'click', async () => {
            const icon = refreshAuditBtn.querySelector('i');
            if (icon) icon.classList.add('fa-spin');
            renderMembers();
            renderAuditLogs();
            await Promise.allSettled([fetchTeamMembers(), fetchAuditLogs()]);
            setTimeout(() => {
                if (icon) icon.classList.remove('fa-spin');
                const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                window.showToast?.(`Workspace team and audit log refreshed at ${nowTime}!`);
            }, 300);
        });

        // Export comprehensive Team & Audit CSV
        bindSafe(exportAuditCsvBtn, 'click', () => {
            const timestamp = new Date().toISOString().split('T')[0];
            const lines = [];

            const escCsv = val => `"${String(val ?? '').replace(/"/g, '""')}"`;

            // 1. Team Roster Header & Rows
            lines.push('"# WORKSPACE TEAM MEMBERS"');
            lines.push('"Name","Email","Role","Status","Last Active"');
            state.members.forEach(m => {
                lines.push([m.name || '', m.email || '', m.role || '', m.status || '', m.last_active_at || ''].map(escCsv).join(','));
            });

            lines.push(''); // Blank spacer

            // 2. Audit Trail Header & Rows
            lines.push('"# WORKSPACE AUDIT LOG"');
            lines.push('"Timestamp","Action","Actor","Details","Status"');
            state.auditLogs.forEach(l => {
                lines.push([l.timestamp || '', l.action || '', l.actor || '', l.details || '', l.status || ''].map(escCsv).join(','));
            });

            const csvContent = lines.join('\n');
            downloadFile(`Jevexa_Team_and_Audit_${timestamp}.csv`, '\uFEFF' + csvContent, 'text/csv;charset=utf-8;');
            window.showToast?.('Workspace team roster and audit logs exported to CSV!');
        });

        renderMembers();
        renderAuditLogs();

        fetchTeamMembers();
        fetchAuditLogs();
    }

    window.JEVEXA_TEAM = {
        init,
        fetchTeamMembers,
        fetchAuditLogs,
        openInvite: openInviteModal,
        closeInvite: closeInviteModal,
        renderMembers,
        renderAuditLogs,
        resetOnLogout: () => {
            state.members = [...DEFAULT_MEMBERS];
            state.auditLogs = [...DEFAULT_AUDIT_LOGS];
            state.maxSeats = 3;
            state.userTier = 'free';
            try {
                localStorage.removeItem(MEMBERS_STORAGE_KEY);
                localStorage.removeItem(AUDIT_STORAGE_KEY);
            } catch (_) {}
            window.JEVEXA_CLEAR_USED_CREDITS_FOOTER?.(
                document.querySelector('#teamAdminWorkspace .team-roster-card'),
                'teamCreditReceipt'
            );
            closeInviteModal();
            renderMembers();
            renderAuditLogs();
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
