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

    const CALENDAR_STORAGE_KEY = 'jevexa_social_calendar_cache';

    function loadCachedCalendar() {
        try {
            const raw = localStorage.getItem(CALENDAR_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            }
        } catch (_) {}
        return null;
    }

    function saveCachedCalendar() {
        try {
            localStorage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify(state.scheduledCalendar));
        } catch (_) {}
    }

    const state = {
        currentPost: null,
        scheduledCalendar: loadCachedCalendar() || [
            {
                id: 'cal_1',
                platform: 'linkedin',
                content: 'Launching an AI tool stack should accelerate your team, not create more friction. Here is how we solved unified credit wallet metering across 10 business tools...',
                scheduledFor: new Date(Date.now() + 86400000).toISOString().split('T')[0],
                status: 'Scheduled'
            },
            {
                id: 'cal_2',
                platform: 'twitter',
                content: 'Stop paying 6 different AI subscriptions. Unified credit wallet metering is the future of enterprise software efficiency.',
                scheduledFor: new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0],
                status: 'Draft'
            }
        ],
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
    const exportDraftBtn = document.getElementById('socialExportDraftBtn');
    const addToCalendarBtn = document.getElementById('socialAddToCalendarBtn');

    // Calendar Elements
    const calendarGrid = document.getElementById('socialCalendarGrid');
    const calendarViewWeekBtn = document.getElementById('socialViewWeekBtn');
    const calendarViewMonthBtn = document.getElementById('socialViewMonthBtn');
    const exportCalendarCsvBtn = document.getElementById('socialExportCalendarCsvBtn');
    const exportCalendarJsonBtn = document.getElementById('socialExportCalendarJsonBtn');

    const DEFAULT_POST = {
        platform: 'linkedin',
        platform_limit: 3000,
        post_body: `Launching an AI tool stack should accelerate your team, not create more friction.\n\nMost businesses make the mistake of stitching together 6 different subscriptions with fragmented billing.\n\nHere is how we solved it with JEVEXA:\n1. 10 specialized tools in 1 studio\n2. Unified credit wallet with zero per-seat fees\n3. Deterministic fallbacks that guarantee 99.9% uptime\n\nWhat is the #1 tool in your stack that still requires too much manual work?`,
        hooks: [
            { text: "Stop paying 6 different AI subscriptions when 1 unified studio does the job.", score: 96 },
            { text: "The biggest bottleneck in business AI isn't the model. It's the workflow glue.", score: 92 },
            { text: "POV: You cut your AI software expenses by 60% without losing quality.", score: 88 }
        ],
        hashtags: ['#BusinessAI', '#Productivity', '#Automation', '#TechLeadership', '#SaaS'],
        best_time: 'Tuesday at 10:00 AM EST',
        strategy_tip: 'Ask an open-ended question in the final line to drive high-value comments in the first 60 minutes.'
    };

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

    function deterministicClientSocial(topic, platform, tone, goal, cta) {
        const normPlatform = (platform || 'linkedin').toLowerCase();
        const normTone = tone || 'professional';
        const normCta = cta || 'Drop your thoughts below!';
        const cleanTopic = topic.trim();

        const hookList = [
            { text: `Most operators get ${cleanTopic.slice(0, 42)} wrong. Here is the framework that changed our trajectory:`, score: 96 },
            { text: `If you are building around ${cleanTopic.slice(0, 38)}, stop scrolling. 3 core takeaways:`, score: 92 },
            { text: `The single biggest shift we made in ${cleanTopic.slice(0, 36)} this quarter (and why it worked):`, score: 88 }
        ];

        let postBody = '';
        let platformLimit = 3000;
        let hashtags = ['#BusinessAI', '#Automation', '#Productivity', '#TechLeadership', '#GrowthStrategy'];
        let bestTime = 'Tuesday & Thursday at 8:45 AM EST';

        if (normPlatform === 'twitter' || normPlatform === 'x') {
            platformLimit = 280;
            postBody = `Most teams overcomplicate ${cleanTopic.slice(0, 45)}.\n\nThe real secret? Automate the repetitive steps, personalize where it matters, and measure weekly.\n\n${normCta}`;
            hashtags = ['#AI', '#BuildInPublic', '#Productivity'];
            bestTime = 'Monday-Friday at 12:15 PM EST';
        } else if (normPlatform === 'threads') {
            platformLimit = 500;
            postBody = `Hot take on ${cleanTopic}:\n\nSpeed doesn't come from longer prompts — it comes from cleaner inputs and repeatable workflows.\n\nWhat's one step you're automating this week? ${normCta}`;
            hashtags = ['#Threads', '#Automation', '#Creators'];
            bestTime = 'Tuesday & Thursday at 11:30 AM EST';
        } else if (normPlatform === 'facebook') {
            platformLimit = 2500;
            postBody = `Practical playbook for ${cleanTopic}:\n\nWe broke our process into 3 simple stages: standardize the brief, draft with focused AI tools, and review real metrics every Friday.\n\n${normCta}`;
            hashtags = ['#SmallBusiness', '#Workflows', '#DigitalGrowth'];
            bestTime = 'Wednesday at 1:00 PM EST';
        } else if (normPlatform === 'instagram') {
            platformLimit = 2200;
            postBody = `✨ Here is what nobody tells you about ${cleanTopic}.\n\nWhen we first started scaling operations, we focused on doing more. What actually drove 3x output was simplifying.\n\n📌 3 Rules to Remember:\n1. Eliminate manual friction before adding tools\n2. Prioritize repeatable pipelines\n3. Protect high-leverage focus hours\n\n💬 ${normCta}`;
            hashtags = ['#BusinessGrowth', '#EntrepreneurMindset', '#AutomationTools', '#SmartWork', '#StartupLife'];
            bestTime = 'Wednesday at 6:00 PM EST';
        } else {
            // LinkedIn / Professional
            postBody = `Most operators struggle with ${cleanTopic}.\n\nNot because they lack ambition, but because their systems are fragmented across too many manual steps.\n\nHere are 3 actionable principles we follow to streamline execution:\n\n1. Standardize Inputs: Build consistent data formats before executing workflows.\n2. Leverage Modular AI: Use focused tools for specific steps rather than monolithic prompts.\n3. Measure Lead Time: The true metric of efficiency is how fast an idea turns into a deliverable.\n\n${normCta}`;
            hashtags = ['#BusinessAI', '#Productivity', '#Automation', '#TechLeadership', '#SaaS'];
            bestTime = 'Tuesday at 10:00 AM EST';
        }

        return {
            platform: normPlatform,
            hooks: hookList,
            post_body: postBody,
            hashtags: hashtags,
            best_time: bestTime,
            char_count: postBody.length,
            platform_limit: platformLimit,
            call_to_action: normCta,
            strategy_tip: `Post during peak work breaks with an open-ended question to maximize comment velocity in the first 60 minutes.`
        };
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

    function renderPostPreview(data) {
        state.currentPost = data;
        if (previewContainer) previewContainer.hidden = false;

        // Render Hooks
        if (hooksContainer) {
            hooksContainer.innerHTML = '';
            const hooks = Array.isArray(data.hooks) ? data.hooks : [];
            hooks.forEach((hook, i) => {
                const div = document.createElement('div');
                div.className = 'social-hook-item glass';
                div.innerHTML = `
                    <div class="social-hook-header" style="display:flex; justify-content:space-between; align-items:center; width:100%;">
                        <span class="social-hook-score"><i class="fas fa-fire"></i> ${hook.score || 90}% Impact</span>
                        <button type="button" class="btn btn-xs btn-outline social-use-hook-btn" data-hook-index="${i}">
                            <i class="fas fa-arrow-down-long"></i> Use Hook
                        </button>
                    </div>
                    <div class="social-hook-text">${escapeHtml(hook.text || '')}</div>
                `;
                hooksContainer.appendChild(div);
            });

            // Wire "Use Hook" buttons
            hooksContainer.querySelectorAll('.social-use-hook-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const idx = Number(e.currentTarget.dataset.hookIndex);
                    const selectedHook = data.hooks[idx];
                    if (selectedHook && postBodyEl) {
                        const hookText = selectedHook.text.trim();
                        const currentVal = postBodyEl.value.trim();
                        if (!currentVal) {
                            postBodyEl.value = `${hookText}\n\nHere is how we solved it...\n\nWhat is your biggest bottleneck?`;
                        } else {
                            const lines = postBodyEl.value.split('\n');
                            lines[0] = hookText;
                            postBodyEl.value = lines.join('\n');
                        }
                        if (state.currentPost) {
                            state.currentPost.post_body = postBodyEl.value;
                        }
                        updateCharCount();
                        postBodyEl.focus();
                        window.showToast?.(`Hook #${idx + 1} applied to post draft!`);
                    }
                });
            });
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
        if (state.currentPost) {
            state.currentPost.post_body = postBodyEl.value;
        }
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
        if (state.isGenerating) return;
        const topic = topicInput ? topicInput.value.trim() : '';
        if (!topic) {
            if (statusEl) {
                statusEl.textContent = 'Please provide a topic or core message.';
                statusEl.className = 'social-status-msg error';
            }
            return;
        }

        const platform = platformSelect ? platformSelect.value : 'linkedin';
        const tone = toneSelect ? toneSelect.value : 'professional';
        const goal = goalSelect ? goalSelect.value : 'engagement';
        const cta = ctaInput ? ctaInput.value.trim() : 'Drop your thoughts below!';

        state.isGenerating = true;
        if (generateBtn) {
            generateBtn.disabled = true;
            generateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating Post & Hooks...';
        }
        if (statusEl) {
            statusEl.textContent = 'Crafting platform-tailored hooks, body copy, and hashtags...';
            statusEl.className = 'social-status-msg loading';
        }

        const session = await getSession();
        if (!session) {
            // Instant local generator for guests & offline demo
            setTimeout(() => {
                const localPost = deterministicClientSocial(topic, platform, tone, goal, cta);
                renderPostPreview(localPost);
                state.isGenerating = false;
                if (generateBtn) {
                    generateBtn.disabled = false;
                    generateBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate Viral Draft & Hooks';
                }
                if (statusEl) {
                    statusEl.textContent = 'Post draft and viral hooks generated! (Sign in to sync with cloud wallet)';
                    statusEl.className = 'social-status-msg success';
                }
                window.showToast?.('Social post generated!');
            }, 300);
            return;
        }

        const requestId = generateUuid();
        const payload = {
            requestId,
            topic,
            platform,
            tone,
            goal,
            cta
        };

        const socialController = new AbortController();
        const socialTimeoutId = setTimeout(() => socialController.abort(), 35000);
        try {
            const res = await fetch('/api/social/generate', {
                method: 'POST',
                signal: socialController.signal,
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
                    window.JEVEXA_SHOW_UPGRADE_MODAL?.('Pro', 'Social Media Assistant credits');
                }
                const err = new Error(result.error || 'Failed to generate social media content.');
                err.status = res.status;
                throw err;
            }

            renderPostPreview(result.data);
            const usage = window.JEVEXA_EXTRACT_CREDIT_USAGE?.(result);
            const socialCharged = usage?.used ?? (Number.isInteger(result.charged_credits) ? result.charged_credits : (Number.isInteger(result.credits_used) ? result.credits_used : null));
            const socialRemaining = usage?.remaining ?? result.remaining_credits;
            window.JEVEXA_RENDER_USED_CREDITS_FOOTER?.(previewContainer, socialCharged, {
                id: 'socialCreditReceipt',
                remaining: socialRemaining,
                tier: usage?.tier || result.tier
            });
            if (typeof socialRemaining === 'number') {
                window.JEVEXA_UPDATE_CREDIT_BALANCE?.(socialRemaining);
            }
            window.JEVEXA_CREDITS?.fetchBalance?.();
            window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();

            if (statusEl) {
                const costText = socialCharged ? ` (${socialCharged} credits used)` : '';
                statusEl.textContent = `Post draft and viral hooks generated!${costText}`;
                statusEl.className = 'social-status-msg success';
            }
            window.showToast?.('Social post generated!');
        } catch (err) {
            if (err?.status && err.status >= 400 && err.status < 500) {
                window.JEVEXA_CLEAR_USED_CREDITS_FOOTER?.(previewContainer, 'socialCreditReceipt');
                if (statusEl) {
                    statusEl.textContent = err.message || 'Could not generate social post.';
                    statusEl.className = 'social-status-msg error';
                }
                window.showToast?.(err.message || 'Could not generate social post.');
                return;
            }
            console.warn('Social Cloud API notice, activating deterministic fallback:', err);
            const fallbackPost = deterministicClientSocial(topic, platform, tone, goal, cta);
            renderPostPreview(fallbackPost);
            window.JEVEXA_RENDER_USED_CREDITS_FOOTER?.(previewContainer, 0, {
                id: 'socialCreditReceipt',
                allowZero: true,
                note: 'Local engine (no charge)'
            });
            if (statusEl) {
                statusEl.textContent = 'Cloud AI unavailable — generated locally via deterministic engine (no credits charged).';
                statusEl.className = 'social-status-msg info';
            }
            window.showToast?.('Social post drafted locally (no credits charged).');
        } finally {
            clearTimeout(socialTimeoutId);
            state.isGenerating = false;
            if (generateBtn) {
                generateBtn.disabled = false;
                generateBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate Viral Draft & Hooks';
            }
        }
    }

    function addToCalendar() {
        const content = postBodyEl ? postBodyEl.value.trim() : '';
        if (!state.currentPost || !content) {
            window.showToast?.('Generate or enter post copy before scheduling.');
            if (statusEl) {
                statusEl.textContent = 'Enter or generate post copy before adding to the calendar.';
                statusEl.className = 'social-status-msg error';
            }
            return;
        }

        const platform = state.currentPost.platform || 'linkedin';
        const entry = {
            id: generateUuid(),
            platform,
            content,
            scheduledFor: new Date(Date.now() + 86400000 * (state.scheduledCalendar.length + 1)).toISOString().split('T')[0],
            status: 'Scheduled'
        };

        state.scheduledCalendar.push(entry);
        saveCachedCalendar();
        renderCalendar();
        window.showToast?.(`Post added to Content Calendar (${platform.toUpperCase()})!`);
        if (statusEl) {
            statusEl.textContent = `Added draft to calendar for ${entry.scheduledFor}.`;
            statusEl.className = 'social-status-msg success';
        }
    }

    function renderCalendar() {
        if (!calendarGrid) return;
        calendarGrid.innerHTML = '';

        const isMonth = state.calendarView === 'month';
        const count = isMonth ? 28 : 7;
        const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

        calendarGrid.classList.toggle('is-month-grid', isMonth);

        for (let index = 0; index < count; index++) {
            const dayCard = document.createElement('div');
            dayCard.className = `social-cal-day glass${isMonth ? ' is-month-cell' : ''}`;
            const scheduledPost = state.scheduledCalendar[index] || null;
            const hasPost = Boolean(scheduledPost);
            const dayLabel = isMonth ? `Day ${index + 1}` : dayNames[index % 7];

            dayCard.innerHTML = `
                <div class="social-cal-day-header" style="display:flex; justify-content:space-between; margin-bottom:6px;">
                    <strong>${dayLabel}</strong>
                    <span class="social-cal-date" style="font-size:11px; color:#94a3b8;">+${index + 1}d</span>
                </div>
                <div class="social-cal-day-body">
                    ${hasPost && scheduledPost ? `
                        <div class="social-cal-entry status-${escapeHtml(scheduledPost.status.toLowerCase())}" style="padding:6px 8px; border-radius:6px; background:rgba(168,85,247,0.15); border:1px solid rgba(168,85,247,0.3);">
                            <span class="social-cal-platform" style="font-size:11px; font-weight:700; color:#c084fc;"><i class="fab fa-${escapeHtml(scheduledPost.platform)}"></i> ${escapeHtml(scheduledPost.platform)}</span>
                            <p class="social-cal-snippet" style="font-size:11.5px; margin:4px 0 0; line-height:1.3; color:#f1f5f9;">${escapeHtml(scheduledPost.content.slice(0, isMonth ? 45 : 75))}...</p>
                        </div>
                    ` : '<span class="social-cal-empty" style="font-size:11px; color:#64748b;">No post scheduled</span>'}
                </div>
            `;
            calendarGrid.appendChild(dayCard);
        }
    }

    let initialized = false;
    function init() {
        if (initialized) return;
        initialized = true;
        bindSafe(backBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(closeBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(form, 'submit', generateSocialPost);

        if (postBodyEl) {
            postBodyEl.addEventListener('input', updateCharCount);
        }

        // View toggle (Week vs Month)
        if (calendarViewWeekBtn) {
            bindSafe(calendarViewWeekBtn, 'click', () => {
                state.calendarView = 'week';
                calendarViewWeekBtn.classList.add('active');
                calendarViewWeekBtn.setAttribute('aria-selected', 'true');
                calendarViewMonthBtn?.classList.remove('active');
                calendarViewMonthBtn?.setAttribute('aria-selected', 'false');
                renderCalendar();
            });
        }
        if (calendarViewMonthBtn) {
            bindSafe(calendarViewMonthBtn, 'click', () => {
                state.calendarView = 'month';
                calendarViewMonthBtn.classList.add('active');
                calendarViewMonthBtn.setAttribute('aria-selected', 'true');
                calendarViewWeekBtn?.classList.remove('active');
                calendarViewWeekBtn?.setAttribute('aria-selected', 'false');
                renderCalendar();
            });
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
                    const preview = deterministicClientSocial(p.topic, p.platform, p.tone, p.goal, p.cta);
                    renderPostPreview(preview);
                    if (statusEl) {
                        statusEl.textContent = `Loaded preset "${presetSelect.value.replace(/_/g, ' ')}". Ready to generate or edit.`;
                        statusEl.className = 'social-status-msg info';
                    }
                }
            });
            if (presetSelect.value && PRESETS[presetSelect.value]) {
                const initP = PRESETS[presetSelect.value];
                if (topicInput && !topicInput.value.trim()) topicInput.value = initP.topic;
                if (platformSelect) platformSelect.value = initP.platform;
                if (toneSelect) toneSelect.value = initP.tone;
                if (goalSelect) goalSelect.value = initP.goal;
                if (ctaInput && !ctaInput.value.trim()) ctaInput.value = initP.cta;
            }
        }

        // Copy Post
        bindSafe(copyPostBtn, 'click', async () => {
            if (!postBodyEl) return;
            const tags = (state.currentPost?.hashtags || []).join(' ').trim();
            const fullContent = [postBodyEl.value.trim(), tags].filter(Boolean).join('\n\n');
            if (!fullContent) {
                window.showToast?.('Generate or enter post copy first.');
                return;
            }
            const ok = typeof window.JEVEXA_COPY_TO_CLIPBOARD === 'function'
                ? await window.JEVEXA_COPY_TO_CLIPBOARD(fullContent, {
                    button: copyPostBtn,
                    copiedHtml: '<i class="fas fa-check"></i> Copied!',
                    toastMessage: 'Post draft copied to clipboard'
                })
                : await (async () => {
                    try {
                        await navigator.clipboard.writeText(fullContent);
                        window.showToast?.('Post draft copied to clipboard');
                        return true;
                    } catch {
                        return false;
                    }
                })();
            if (ok && statusEl) {
                statusEl.textContent = 'Post copied to clipboard.';
                statusEl.className = 'social-status-msg success';
            }
        });

        // Export Draft directly
        if (exportDraftBtn) {
            bindSafe(exportDraftBtn, 'click', () => {
                if (!postBodyEl) return;
                const fullContent = `${postBodyEl.value}\n\nHashtags: ${(state.currentPost?.hashtags || []).join(' ')}\n\nOptimal Posting Time: ${bestTimeEl?.textContent || 'Peak engagement window'}\nViral Impact Score: ${state.currentPost?.hooks?.[0]?.score || 95}%`;
                const filename = `Social_Draft_${platformSelect?.value || 'post'}_${new Date().toISOString().split('T')[0]}.txt`;
                downloadFile(filename, fullContent, 'text/plain;charset=utf-8;');
                window.showToast?.('Draft exported as text file!');
                if (statusEl) {
                    statusEl.textContent = `Draft exported to ${filename}.`;
                    statusEl.className = 'social-status-msg success';
                }
            });
        }

        // Reactive Platform change
        if (platformSelect) {
            bindSafe(platformSelect, 'change', () => {
                const limits = { twitter: 280, threads: 500, linkedin: 3000, instagram: 2200, facebook: 63206 };
                const plat = platformSelect.value;
                if (state.currentPost) {
                    state.currentPost.platform = plat;
                    state.currentPost.platform_limit = limits[plat] || 2200;
                }
                updateCharCount();
                if (statusEl) {
                    statusEl.textContent = `Target platform switched to ${plat.toUpperCase()} (limit: ${limits[plat] || 2200} chars).`;
                    statusEl.className = 'social-status-msg info';
                }
            });
        }

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
            downloadFile(`Jevexa_Content_Calendar_${new Date().toISOString().split('T')[0]}.csv`, '\uFEFF' + csv, 'text/csv;charset=utf-8;');
            window.showToast?.('Content Calendar exported to CSV!');
        });

        bindSafe(exportCalendarJsonBtn, 'click', () => {
            if (!state.scheduledCalendar.length) {
                window.showToast?.('No scheduled posts to export. Add drafts to calendar first.');
                return;
            }
            downloadFile(`Jevexa_Content_Calendar_${new Date().toISOString().split('T')[0]}.json`, JSON.stringify(state.scheduledCalendar, null, 2), 'application/json');
            window.showToast?.('Content Calendar exported to JSON!');
        });

        // Initial default render
        if (!state.currentPost) {
            renderPostPreview(DEFAULT_POST);
        }
        renderCalendar();
    }

    window.JEVEXA_SOCIAL = {
        init,
        generatePost: generateSocialPost,
        addToCalendar,
        renderCalendar,
        renderPostPreview,
        resetOnLogout: () => {
            state.isGenerating = false;
            state.scheduledCalendar = [];
            try { localStorage.removeItem('jevexa_social_calendar_cache'); } catch (_) {}
            window.JEVEXA_CLEAR_USED_CREDITS_FOOTER?.(previewContainer, 'socialCreditReceipt');
            if (statusEl) { statusEl.textContent = ''; statusEl.className = 'social-status-msg'; }
            renderPostPreview(DEFAULT_POST);
            renderCalendar();
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
