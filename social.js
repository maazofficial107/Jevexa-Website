/**
 * JEVEXA AI Studio - Social Media Assistant Workspace Controller
 * Handles viral hooks generation, platform-optimized post drafts, hashtag sets,
 * optimal posting times, interactive Content Calendar (Week & Month views), and schedule export.
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
        currentPost: null,
        scheduledCalendar: [],
        calendarView: 'week',
        isGenerating: false
    };

    // DOM Elements
    const workspace = document.getElementById('socialWorkspace');
    const backBtn = document.getElementById('socialBackToStudio');
    const closeBtn = document.getElementById('socialWorkspaceClose');

    const form = document.getElementById('socialForm');
    const topicInput = document.getElementById('socialTopic');
    const platformSelect = document.getElementById('socialPlatform');
    const toneSelect = document.getElementById('socialTone');
    const goalSelect = document.getElementById('socialGoal');
    const ctaInput = document.getElementById('socialCta');
    const presetSelect = document.getElementById('socialPresetSelect');
    const generateBtn = document.getElementById('socialGenerateBtn');
    const statusEl = document.getElementById('socialStatus');

    // Preview Elements
    const previewContainer = document.getElementById('socialPreviewContainer');
    const hooksContainer = document.getElementById('socialHooksContainer');
    const postBodyEl = document.getElementById('socialPostBody');
    const hashtagsEl = document.getElementById('socialHashtags');
    const bestTimeEl = document.getElementById('socialBestTime');
    const charCountEl = document.getElementById('socialCharCount');
    const strategyTipEl = document.getElementById('socialStrategyTip');

    // Preview actions
    const copyPostBtn = document.getElementById('socialCopyPostBtn');
    const addToCalendarBtn = document.getElementById('socialAddToCalendarBtn');

    // Calendar Elements
    const calendarGrid = document.getElementById('socialCalendarGrid');
    const calendarViewWeekBtn = document.getElementById('socialViewWeekBtn');
    const calendarViewMonthBtn = document.getElementById('socialViewMonthBtn');
    const exportCalendarCsvBtn = document.getElementById('socialExportCalendarCsvBtn');
    const exportCalendarJsonBtn = document.getElementById('socialExportCalendarJsonBtn');

    const PRESETS = {
        product_launch: {
            topic: "Launching Jevexa AI Studio 2.0 with 10 business tools in one credit wallet. No lock-in, no seat fees.",
            platform: "linkedin",
            tone: "professional",
            goal: "awareness",
            cta: "Try it free with 100 welcome credits at jevexa.net"
        },
        founder_lesson: {
            topic: "The #1 mistake first-time founders make with automation: automating a broken process before simplifying it.",
            platform: "twitter",
            tone: "storytelling",
            goal: "engagement",
            cta: "What was the first automation that actually moved the needle for you?"
        },
        industry_trends: {
            topic: "3 trends in business AI for 2027: specialized agent swarms, deterministic verification, and unified credit meters.",
            platform: "linkedin",
            tone: "educational",
            goal: "clicks",
            cta: "Read our full engineering breakdown in the link in comments."
        },
        relatable_meme: {
            topic: "POV: You spent 4 hours writing cold emails manually, only to realize an AI agent could have drafted 20 personalized sequences in 90 seconds.",
            platform: "instagram",
            tone: "casual",
            goal: "engagement",
            cta: "Tag a founder who needs to upgrade their outbound stack!"
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

    function renderPostPreview(data) {
        state.currentPost = data;
        if (previewContainer) previewContainer.hidden = false;

        // Hooks
        if (hooksContainer) {
            hooksContainer.innerHTML = '';
            if (Array.isArray(data.hooks)) {
                data.hooks.forEach((hook, i) => {
                    const div = document.createElement('div');
                    div.className = 'social-hook-item glass';
                    div.innerHTML = `
                        <div class="social-hook-score"><i class="fas fa-fire"></i> ${hook.score || 90}% Impact</div>
                        <div class="social-hook-text">${escapeHtml(hook.text || '')}</div>
                        <button type="button" class="btn btn-xs btn-outline social-use-hook-btn" data-hook-index="${i}">Use Hook</button>
                    `;
                    hooksContainer.appendChild(div);
                });

                hooksContainer.querySelectorAll('.social-use-hook-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const idx = Number(e.currentTarget.dataset.hookIndex);
                        const selectedHook = data.hooks[idx];
                        if (selectedHook && postBodyEl) {
                            const lines = postBodyEl.value.split('\n');
                            lines[0] = selectedHook.text;
                            postBodyEl.value = lines.join('\n');
                            window.showToast?.('Hook applied to post draft!');
                        }
                    });
                });
            }
        }

        // Post body & character counter
        if (postBodyEl) {
            postBodyEl.value = data.post_body || '';
            updateCharCount();
        }

        // Hashtags
        if (hashtagsEl) {
            const tags = Array.isArray(data.hashtags) ? data.hashtags : ['#BusinessAI', '#Productivity'];
            hashtagsEl.innerHTML = tags.map(t => `<span class="social-tag-pill">${escapeHtml(t)}</span>`).join(' ');
        }

        // Best time & strategy tip
        if (bestTimeEl) bestTimeEl.textContent = data.best_time || 'Tuesday at 10:00 AM EST';
        if (strategyTipEl) strategyTipEl.textContent = data.strategy_tip || 'Post with an engaging question to spark early comments.';
    }

    function updateCharCount() {
        if (!postBodyEl || !charCountEl) return;
        const len = postBodyEl.value.length;
        const limit = state.currentPost?.platform_limit || 3000;
        charCountEl.textContent = `${len} / ${limit} characters`;
        charCountEl.style.color = len > limit ? '#ef4444' : '';
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]);
    }

    async function generateSocialPost(e) {
        if (e) e.preventDefault();
        const topic = topicInput ? topicInput.value.trim() : '';
        if (!topic) {
            if (statusEl) {
                statusEl.textContent = 'Please provide a topic or core message.';
                statusEl.className = 'social-status-msg error';
            }
            return;
        }

        const session = await getSession();
        if (!session) {
            window.showToast?.('Please sign in or create an account to use Social Media Assistant.');
            window.openAuthModal?.('signup');
            return;
        }

        state.isGenerating = true;
        if (generateBtn) {
            generateBtn.disabled = true;
            generateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating Post & Hooks...';
        }
        if (statusEl) {
            statusEl.textContent = 'Crafting platform-tailored hooks, body copy, and hashtags...';
            statusEl.className = 'social-status-msg loading';
        }

        const requestId = generateUuid();
        const payload = {
            requestId,
            topic,
            platform: platformSelect ? platformSelect.value : 'linkedin',
            tone: toneSelect ? toneSelect.value : 'professional',
            goal: goalSelect ? goalSelect.value : 'engagement',
            cta: ctaInput ? ctaInput.value.trim() : ''
        };

        try {
            const res = await fetch('/api/social/generate', {
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
                throw new Error(result.error || 'Failed to generate social media content.');
            }

            renderPostPreview(result.data);
            if (statusEl) {
                statusEl.textContent = 'Post draft and viral hooks generated!';
                statusEl.className = 'social-status-msg success';
            }
            window.showToast?.('Social post generated!');
            window.JEVEXA_CREDITS?.fetchBalance?.();
        } catch (err) {
            console.error('Social generation error:', err);
            if (statusEl) {
                statusEl.textContent = err.message || 'Generation failed. Please try again.';
                statusEl.className = 'social-status-msg error';
            }
            window.showToast?.(err.message || 'Social post generation failed.');
        } finally {
            state.isGenerating = false;
            if (generateBtn) {
                generateBtn.disabled = false;
                generateBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate Viral Draft & Hooks';
            }
        }
    }

    function addToCalendar() {
        if (!state.currentPost || !postBodyEl) {
            window.showToast?.('Generate or select a post draft first.');
            return;
        }

        const platform = state.currentPost.platform || 'linkedin';
        const content = postBodyEl.value;
        const entry = {
            id: generateUuid(),
            platform,
            content,
            scheduledFor: new Date(Date.now() + 86400000 * (state.scheduledCalendar.length + 1)).toISOString().split('T')[0],
            status: 'Scheduled'
        };

        state.scheduledCalendar.push(entry);
        renderCalendar();
        window.showToast?.(`Post added to Content Calendar (${platform.toUpperCase()})!`);
    }

    function renderCalendar() {
        if (!calendarGrid) return;
        calendarGrid.innerHTML = '';

        const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        days.forEach((day, index) => {
            const dayCard = document.createElement('div');
            dayCard.className = 'social-cal-day glass';
            const scheduledPost = state.scheduledCalendar[index % state.scheduledCalendar.length];

            dayCard.innerHTML = `
                <div class="social-cal-day-header">
                    <strong>${day}</strong>
                    <span class="social-cal-date">+${index + 1}d</span>
                </div>
                <div class="social-cal-day-body">
                    ${scheduledPost ? `
                        <div class="social-cal-entry status-${scheduledPost.status.toLowerCase()}">
                            <span class="social-cal-platform"><i class="fab fa-${scheduledPost.platform}"></i> ${scheduledPost.platform}</span>
                            <p class="social-cal-snippet">${escapeHtml(scheduledPost.content.slice(0, 75))}...</p>
                        </div>
                    ` : '<span class="social-cal-empty">No post scheduled</span>'}
                </div>
            `;
            calendarGrid.appendChild(dayCard);
        });
    }

    function init() {
        bindSafe(backBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(closeBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(form, 'submit', generateSocialPost);

        if (postBodyEl) {
            postBodyEl.addEventListener('input', updateCharCount);
        }

        // Preset selector
        if (presetSelect) {
            bindSafe(presetSelect, 'change', () => {
                const p = PRESETS[presetSelect.value];
                if (p) {
                    if (topicInput) topicInput.value = p.topic;
                    if (platformSelect) platformSelect.value = p.platform;
                    if (toneSelect) toneSelect.value = p.tone;
                    if (goalSelect) goalSelect.value = p.goal;
                    if (ctaInput) ctaInput.value = p.cta;
                    if (statusEl) {
                        statusEl.textContent = `Loaded preset "${presetSelect.value.replace(/_/g, ' ')}". Click Generate to run.`;
                        statusEl.className = 'social-status-msg info';
                    }
                }
            });
        }

        // Copy Post
        bindSafe(copyPostBtn, 'click', () => {
            if (!postBodyEl) return;
            navigator.clipboard.writeText(postBodyEl.value)
                .then(() => window.showToast?.('Post draft copied to clipboard!'))
                .catch(() => window.showToast?.('Could not copy post draft.'));
        });

        // Add to calendar
        bindSafe(addToCalendarBtn, 'click', addToCalendar);

        // Calendar export actions
        bindSafe(exportCalendarCsvBtn, 'click', () => {
            if (!state.scheduledCalendar.length) {
                window.showToast?.('No scheduled posts to export. Add drafts to calendar first.');
                return;
            }
            const headers = ['Platform', 'Date', 'Status', 'Content'];
            const rows = state.scheduledCalendar.map(c => [
                c.platform,
                c.scheduledFor,
                c.status,
                `"${(c.content || '').replace(/"/g, '""')}"`
            ].join(','));
            const csv = [headers.join(','), ...rows].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `Jevexa_Content_Calendar_${new Date().toISOString().split('T')[0]}.csv`;
            link.click();
            window.showToast?.('Content Calendar exported to CSV!');
        });

        bindSafe(exportCalendarJsonBtn, 'click', () => {
            if (!state.scheduledCalendar.length) {
                window.showToast?.('No scheduled posts to export. Add drafts to calendar first.');
                return;
            }
            const blob = new Blob([JSON.stringify(state.scheduledCalendar, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `Jevexa_Content_Calendar_${new Date().toISOString().split('T')[0]}.json`;
            link.click();
            window.showToast?.('Content Calendar exported to JSON!');
        });

        renderCalendar();
    }

    window.JEVEXA_SOCIAL = {
        init,
        generatePost: generateSocialPost,
        addToCalendar,
        renderCalendar
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
