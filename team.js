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

    const state = {
        members: [],
        auditLogs: [],
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

    // Audit Log Section
    const auditTableBody = document.getElementById('teamAuditTableBody');
    const exportAuditCsvBtn = document.getElementById('teamExportAuditCsvBtn');
    const refreshAuditBtn = document.getElementById('teamRefreshAuditBtn');

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
            const res = await fetch('/api/team/members', {
                headers: { 'Authorization': `Bearer ${session.access_token}` }
            });
            const data = await res.json();
            if (res.ok && Array.isArray(data.members)) {
                state.members = data.members;
                state.maxSeats = data.maxSeats || 3;
                state.userTier = data.tier || 'free';
                renderMembers();
            }
        } catch (err) {
            console.error('Failed to load team members:', err);
        }
    }

    async function fetchAuditLogs() {
        const session = await getSession();
        if (!session) return;

        try {
            const res = await fetch('/api/team/audit', {
                headers: { 'Authorization': `Bearer ${session.access_token}` }
            });
            const data = await res.json();
            if (res.ok && Array.isArray(data.logs)) {
                state.auditLogs = data.logs;
                renderAuditLogs();
            }
        } catch (err) {
            console.error('Failed to load audit logs:', err);
        }
    }

    function renderMembers() {
        if (seatCounterEl) {
            seatCounterEl.textContent = `${state.members.length} / ${state.maxSeats} Seats Used`;
        }
        if (planBadgeEl) {
            planBadgeEl.textContent = `${state.userTier.toUpperCase()} PLAN`;
        }
        if (memberCountEl) {
            memberCountEl.textContent = `${state.members.length} Members`;
        }

        if (!memberTableBody) return;
        memberTableBody.innerHTML = '';

        state.members.forEach(member => {
            const tr = document.createElement('tr');
            const isOwner = member.role === 'Owner';
            tr.innerHTML = `
                <td>
                    <div class="team-member-cell">
                        <div class="team-avatar">${escapeHtml((member.name || 'U').charAt(0).toUpperCase())}</div>
                        <div>
                            <strong>${escapeHtml(member.name || 'Team Member')}</strong>
                            <span class="team-email">${escapeHtml(member.email || '')}</span>
                        </div>
                    </div>
                </td>
                <td>
                    ${isOwner ? '<span class="team-role-pill role-owner">Owner</span>' : `
                        <select class="team-role-select" data-email="${escapeHtml(member.email)}" aria-label="Change role">
                            <option value="Admin"${member.role === 'Admin' ? ' selected' : ''}>Admin</option>
                            <option value="Member"${member.role === 'Member' ? ' selected' : ''}>Member</option>
                            <option value="Viewer"${member.role === 'Viewer' ? ' selected' : ''}>Viewer</option>
                        </select>
                    `}
                </td>
                <td>
                    ${isOwner ? '<span class="team-status-pill status-active">Active</span>' : `
                        <button type="button" class="team-status-toggle status-${(member.status || 'Active').toLowerCase()}" data-email="${escapeHtml(member.email)}" title="Click to toggle status">
                            <i class="fas fa-${member.status === 'Suspended' ? 'ban' : 'check-circle'}"></i> ${escapeHtml(member.status || 'Active')}
                        </button>
                    `}
                </td>
                <td><span class="team-last-active">${member.last_active_at ? new Date(member.last_active_at).toLocaleDateString() : 'Active now'}</span></td>
                <td>
                    ${isOwner ? '<span class="team-action-locked">Primary Owner</span>' : `
                        <button type="button" class="btn btn-xs btn-outline team-remove-btn" data-email="${escapeHtml(member.email)}">Remove</button>
                    `}
                </td>
            `;
            memberTableBody.appendChild(tr);
        });

        // Event listeners for role change, status toggle, remove
        memberTableBody.querySelectorAll('.team-role-select').forEach(sel => {
            sel.addEventListener('change', (e) => {
                const targetEmail = e.currentTarget.dataset.email;
                const newRole = e.currentTarget.value;
                const targetMember = state.members.find(m => m.email === targetEmail);
                if (targetMember) {
                    targetMember.role = newRole;
                    state.auditLogs.unshift({
                        timestamp: new Date().toISOString(),
                        action: "Role Changed",
                        actor: "Workspace Admin",
                        details: `Assigned role ${newRole} to ${targetEmail}`,
                        status: "Success"
                    });
                    renderAuditLogs();
                    window.showToast?.(`Updated role of ${targetEmail} to ${newRole}.`);
                }
            });
        });

        memberTableBody.querySelectorAll('.team-status-toggle').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetEmail = e.currentTarget.dataset.email;
                const targetMember = state.members.find(m => m.email === targetEmail);
                if (targetMember) {
                    targetMember.status = targetMember.status === 'Suspended' ? 'Active' : 'Suspended';
                    state.auditLogs.unshift({
                        timestamp: new Date().toISOString(),
                        action: "Status Changed",
                        actor: "Workspace Admin",
                        details: `Set ${targetEmail} status to ${targetMember.status}`,
                        status: "Success"
                    });
                    renderMembers();
                    renderAuditLogs();
                    window.showToast?.(`Member ${targetEmail} is now ${targetMember.status}.`);
                }
            });
        });

        memberTableBody.querySelectorAll('.team-remove-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetEmail = e.currentTarget.dataset.email;
                state.members = state.members.filter(m => m.email !== targetEmail);
                state.auditLogs.unshift({
                    timestamp: new Date().toISOString(),
                    action: "Member Removed",
                    actor: "Workspace Admin",
                    details: `Revoked access for ${targetEmail}`,
                    status: "Success"
                });
                renderMembers();
                renderAuditLogs();
                window.showToast?.(`Removed member ${targetEmail}.`);
            });
        });
    }

    function renderAuditLogs() {
        if (!auditTableBody) return;
        auditTableBody.innerHTML = '';

        state.auditLogs.forEach(log => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="audit-time">${new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></td>
                <td><strong>${escapeHtml(log.action)}</strong></td>
                <td><span class="audit-actor">${escapeHtml(log.actor)}</span></td>
                <td><span class="audit-details">${escapeHtml(log.details)}</span></td>
                <td><span class="audit-status-badge status-ok">${escapeHtml(log.status)}</span></td>
            `;
            auditTableBody.appendChild(tr);
        });
    }

    function openInviteModal() {
        if (state.members.length >= state.maxSeats) {
            window.showToast?.(`Seat limit reached (${state.maxSeats}/${state.maxSeats}) for ${state.userTier.toUpperCase()} plan. Upgrade plan to invite more members.`);
            return;
        }
        if (inviteModal) {
            inviteModal.hidden = false;
            inviteModal.classList.add('open');
            if (inviteEmailInput) inviteEmailInput.focus();
        }
    }

    function closeInviteModal() {
        if (inviteModal) {
            inviteModal.hidden = true;
            inviteModal.classList.remove('open');
        }
        if (inviteForm) inviteForm.reset();
    }

    async function handleInviteSubmit(e) {
        if (e) e.preventDefault();
        const email = inviteEmailInput ? inviteEmailInput.value.trim() : '';
        const role = inviteRoleSelect ? inviteRoleSelect.value : 'Member';

        if (!email) return;

        const session = await getSession();
        if (!session) {
            window.showToast?.('Please sign in to invite members.');
            return;
        }

        try {
            const res = await fetch('/api/team/invite', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ email, role, currentMemberCount: state.members.length })
            });
            const data = await res.json();
            if (!res.ok) {
                if (res.status === 402 || res.status === 403) {
                    window.JEVEXA_SHOW_UPGRADE_MODAL?.('Pro', 'Team seat expansion');
                }
                throw new Error(data.error || 'Failed to dispatch invitation.');
            }

            state.members.push(data.member);
            state.auditLogs.unshift({
                timestamp: new Date().toISOString(),
                action: "Member Invited",
                actor: "Workspace Admin",
                details: `Dispatched invite to ${email} as ${role}`,
                status: "Success"
            });
            renderMembers();
            renderAuditLogs();
            closeInviteModal();
            window.showToast?.(`Invitation sent to ${email} as ${role}!`);
        } catch (err) {
            window.showToast?.(err.message || 'Invitation failed.');
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]);
    }

    function init() {
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
                if (e.key === 'Escape' && !inviteModal.hidden) closeInviteModal();
            });
        }

        bindSafe(refreshAuditBtn, 'click', fetchAuditLogs);

        // Export audit logs CSV
        bindSafe(exportAuditCsvBtn, 'click', () => {
            if (!state.auditLogs.length) {
                window.showToast?.('No audit logs available to export.');
                return;
            }
            const headers = ['Timestamp', 'Action', 'Actor', 'Details', 'Status'];
            const rows = state.auditLogs.map(l => [
                l.timestamp,
                `"${l.action}"`,
                `"${l.actor}"`,
                `"${(l.details || '').replace(/"/g, '""')}"`,
                l.status
            ].join(','));
            const csv = [headers.join(','), ...rows].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `Jevexa_Audit_Logs_${new Date().toISOString().split('T')[0]}.csv`;
            link.click();
            window.showToast?.('Audit log exported to CSV!');
        });

        fetchTeamMembers();
        fetchAuditLogs();
    }

    window.JEVEXA_TEAM = {
        init,
        fetchTeamMembers,
        fetchAuditLogs,
        openInvite: openInviteModal
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
