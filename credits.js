/* Authenticated credit controls for the existing JEVEXA account and chatbot UI. */
(function () {
    const bindSafe = (target, type, handler, options) => {
        if (window.JEVEXA_SAFE_INTERACTION?.bind) {
            window.JEVEXA_SAFE_INTERACTION.bind(target, type, handler, options);
        } else {
            target?.addEventListener(type, handler, options?.listenerOptions);
        }
    };
    const input = document.getElementById('chatInput');
    const sendButton = document.getElementById('chatSend');
    const messages = document.getElementById('chatMessages');
    const status = document.getElementById('chatCreditStatus');
    const upgradeLink = document.getElementById('chatCreditUpgrade');
    const tierSelect = document.getElementById('chatTier');
    const thinkingSelect = document.getElementById('chatThinking');
    const selectorControls = {
        tier: {
            input: tierSelect,
            trigger: document.getElementById('chatTierTrigger'),
            menu: document.getElementById('chatTierOptions'),
            label: 'Engine'
        },
        thinking: {
            input: thinkingSelect,
            trigger: document.getElementById('chatThinkingTrigger'),
            menu: document.getElementById('chatThinkingOptions'),
            label: 'Thinking'
        },
        theme: {
            input: document.getElementById('chatTheme'),
            trigger: document.getElementById('chatThemeTrigger'),
            menu: document.getElementById('chatThemeOptions'),
            label: 'Theme'
        },
        density: {
            input: document.getElementById('chatDensity'),
            trigger: document.getElementById('chatDensityTrigger'),
            menu: document.getElementById('chatDensityOptions'),
            label: 'Density'
        }
    };
    const fileInput = document.getElementById('chatFileInput');
    const attachButton = document.getElementById('chatAttachButton');
    const attachmentList = document.getElementById('chatAttachmentList');
    const warmingMessage = 'AI assistant is warming up — please try again shortly.';
    const maxRenderedMessages = 32;
    let sending = false;
    let ambiguousRequestId = null;
    const conversation = [];
    let chatSessions = [];
    let activeChatId = null;
    const pendingAttachments = [];
    let currentUserPlan = 'free';
    let historyUserId = null;
    let activeAuthUserId = null;
    let maximumChatTier = 'lite';
    let currentTier = 'lite';
    let maximumThinkingLevel = 'off';
    let currentThinkingLevel = 'off';
    let webSearchEnabled = false;
    let lastTurnCreditUsage = null;
    const accountTiers = { free: 'lite', starter: 'pro', lite: 'pro', pro: 'pro', business: 'max', max: 'max', ultra: 'ultra' };
    const tierOrder = ['lite', 'pro', 'max', 'ultra'];
    const thinkingOrder = ['off', 'low', 'standard', 'max'];

    function webSearchKey(userId) {
        return userId ? `jevexa_${userId}_web_search` : null;
    }

    function getStoredWebSearchPref(userId) {
        const key = webSearchKey(userId);
        if (!key) return false;
        try {
            return localStorage.getItem(key) === 'true';
        } catch (_) {
            return false;
        }
    }

    function saveWebSearchPref(userId, enabled) {
        const key = webSearchKey(userId);
        if (!key) return;
        try {
            localStorage.setItem(key, String(Boolean(enabled)));
        } catch (_) {}
    }

    function getActiveEngineLabel(tier = currentTier) {
        const labels = {
            lite: 'Core Engine',
            pro: 'Pro Engine',
            max: 'Deep Reasoning',
            ultra: 'Ultra Reasoning'
        };
        return labels[(tier || 'lite').toLowerCase()] || 'Core Engine';
    }

    function getCachedRemainingCredits() {
        const countEl = document.getElementById('creditsCount');
        const raw = countEl ? countEl.textContent.replace(/,/g, '').trim() : '';
        if (raw && /^\d+$/.test(raw)) return parseInt(raw, 10);
        try {
            const persisted = localStorage.getItem('jevexa_persisted_credits');
            if (persisted && /^\d+$/.test(persisted.trim())) return parseInt(persisted.trim(), 10);
        } catch (_) {}
        return null;
    }

    function formatMinimalStatus({ tier = currentTier, webSearch = webSearchEnabled, used = null, remaining = undefined } = {}) {
        const engine = getActiveEngineLabel(tier);
        const rem = Number.isInteger(remaining) ? remaining : getCachedRemainingCredits();
        const effectiveUsed = Number.isInteger(used) && used >= 0
            ? used
            : (lastTurnCreditUsage && Number.isInteger(lastTurnCreditUsage.used) && Number.isInteger(rem) && lastTurnCreditUsage.remaining === rem
                ? lastTurnCreditUsage.used
                : null);
        const enginePrefix = (webSearch && isWebSearchAllowed()) ? `${engine} (Web Search +5 cr)` : engine;
        if (Number.isInteger(effectiveUsed) && effectiveUsed >= 0 && Number.isInteger(rem)) {
            return `${enginePrefix}   Used credit: ${effectiveUsed}   Remaining credit: ${rem.toLocaleString()}`;
        }
        if (Number.isInteger(rem)) {
            return `${enginePrefix}   Remaining credit: ${rem.toLocaleString()}`;
        }
        if (!activeAuthUserId) {
            return `${enginePrefix}   Sign in for 100 free credits`;
        }
        return `${enginePrefix}   Ready`;
    }

    function updateChatHeaderTitle(overrideTitle = null) {
        const titleEl = document.getElementById('chatbotTitle');
        if (!titleEl) return;
        const badgeEl = document.getElementById('chatHeaderEmblemBadge');
        if (typeof overrideTitle === 'string' && overrideTitle.trim()) {
            const cleanOverride = overrideTitle.trim();
            titleEl.textContent = /^new\s+chat$/i.test(cleanOverride) ? 'Jevexa AI' : cleanOverride;
            badgeEl?.classList.toggle('is-active-thread', !/^new\s+chat$/i.test(cleanOverride));
            return;
        }
        const activeSess = activeChatId ? chatSessions.find(item => item.id === activeChatId) : null;
        if (activeSess?.title && activeSess.title.trim() && !/^new\s+chat$/i.test(activeSess.title.trim())) {
            titleEl.textContent = activeSess.title.trim();
            badgeEl?.classList.add('is-active-thread');
        } else {
            const firstUserMsg = conversation.find(m => m?.role === 'user' && typeof m.text === 'string' && m.text.trim());
            if (firstUserMsg) {
                titleEl.textContent = firstUserMsg.text.trim().slice(0, 42);
                badgeEl?.classList.add('is-active-thread');
            } else {
                titleEl.textContent = 'Jevexa AI';
                badgeEl?.classList.remove('is-active-thread');
            }
        }
    }

    function isWebSearchAllowed() {
        return Boolean(activeAuthUserId)
            && !['free', 'lite', 'starter'].includes(currentUserPlan)
            && ['pro', 'max', 'ultra'].includes(maximumChatTier);
    }

    function syncWebSearchUI() {
        const btn = document.getElementById('chatWebSearchBtn');
        const badge = document.getElementById('chatComposerWebBadge');
        const allowed = isWebSearchAllowed();
        if (!allowed && webSearchEnabled) {
            webSearchEnabled = false;
        }
        if (btn) {
            btn.dataset.locked = String(!allowed);
            btn.setAttribute('aria-disabled', 'false');
            btn.classList.toggle('is-locked', !allowed);
            btn.setAttribute('aria-pressed', String(webSearchEnabled));
            btn.classList.toggle('active', webSearchEnabled);
            const labelEl = btn.querySelector('.chat-web-search-label') || btn.querySelector('span:not(.chat-web-search-pill)');
            if (labelEl) {
                labelEl.textContent = 'Web Search';
            }
            const pillEl = btn.querySelector('.chat-web-search-pill');
            if (pillEl) {
                if (!allowed) {
                    pillEl.innerHTML = '<i class="fas fa-lock" aria-hidden="true"></i>';
                    pillEl.className = 'chat-web-search-pill is-lock';
                    pillEl.hidden = false;
                } else if (webSearchEnabled) {
                    pillEl.textContent = 'Live';
                    pillEl.className = 'chat-web-search-pill is-live';
                    pillEl.hidden = false;
                } else {
                    pillEl.textContent = '';
                    pillEl.className = 'chat-web-search-pill';
                    pillEl.hidden = true;
                }
            }
            btn.title = !allowed
                ? 'Web Search · Requires Pro (15/day), Max (50/day), or Ultra (150/day)'
                : (webSearchEnabled
                    ? 'Web Search ON (+5 credits/request) · Click to turn off'
                    : 'Web Search (+5 credits/request) · Click to enable');
            btn.setAttribute(
                'aria-label',
                !allowed
                    ? 'Web Search, locked. Requires Pro, Max, or Ultra plan. Click to view upgrade options.'
                    : `Web Search (+5 credits per request): ${webSearchEnabled ? 'Active' : 'Off'}`
            );
        }
        if (badge) {
            badge.hidden = !webSearchEnabled;
            badge.textContent = webSearchEnabled ? 'Live Web Search active (+5 credits/request)' : '';
        }
    }

    const PLAN_MEMORY_CONFIG = {
        free: { maxMemories: 5, maxMemoryChars: 200, maxHistoryMessages: 6, label: 'Free Plan' },
        lite: { maxMemories: 15, maxMemoryChars: 350, maxHistoryMessages: 12, label: 'Lite Plan' },
        starter: { maxMemories: 15, maxMemoryChars: 350, maxHistoryMessages: 12, label: 'Lite Plan' },
        pro: { maxMemories: 35, maxMemoryChars: 500, maxHistoryMessages: 20, label: 'Pro Plan' },
        max: { maxMemories: 75, maxMemoryChars: 800, maxHistoryMessages: 32, label: 'Max Plan' },
        business: { maxMemories: 75, maxMemoryChars: 800, maxHistoryMessages: 32, label: 'Max Plan' },
        ultra: { maxMemories: 150, maxMemoryChars: 1200, maxHistoryMessages: 50, label: 'Ultra Plan' }
    };

    function getUserPlanMemoryLimits() {
        const planKey = (currentUserPlan || 'free').toLowerCase();
        return PLAN_MEMORY_CONFIG[planKey] || PLAN_MEMORY_CONFIG.free;
    }

    let chatCustomSettings = {
        aboutUser: '',
        responseStyle: '',
        language: 'auto',
        tone: 'default',
        behavior: 'standard',
        codeDepth: 'full',
        density: 'comfortable',
        theme: 'dark',
        reducedMotion: false
    };

    let userMemories = [];
    let renamingSessionId = null;
    let openMenuSessionId = null;

    function selectorOptions(name) {
        return Array.from(selectorControls[name]?.menu?.querySelectorAll('[role="option"]') || []);
    }

    function updateSelectorDisplay(name) {
        const control = selectorControls[name];
        if (!control?.input || !control.trigger || !control.menu) return;
        const options = selectorOptions(name);
        const selected = options.find(option => option.dataset.value === control.input.value);
        options.forEach(option => {
            const isSelected = option === selected;
            const locked = option.dataset.locked === 'true';
            option.setAttribute('aria-selected', String(isSelected));
            option.removeAttribute('aria-disabled');
            option.setAttribute('aria-label', locked
                ? `${option.dataset.label || option.textContent.trim()}, locked. Select to learn about upgrades.`
                : option.dataset.label || option.textContent.trim());
            option.classList.toggle('is-locked', locked);
            const state = option.querySelector('.chat-option-state');
            if (state) state.textContent = locked ? '🔒' : isSelected ? '✓' : '';
        });
        const value = control.trigger.querySelector('.chat-select-value');
        if (value) value.textContent = selected?.dataset.label || control.label;
        control.trigger.setAttribute('aria-label', `${control.label}: ${selected?.dataset.label || 'Choose'}`);
    }

    function positionChatSelectMenu(name) {
        const control = selectorControls[name];
        if (!control?.menu || !control.trigger || control.menu.hidden) return;
        const triggerRect = control.trigger.getBoundingClientRect();
        const vw = (window.visualViewport ? window.visualViewport.width : window.innerWidth) || 360;
        const vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight) || 640;
        const vTop = (window.visualViewport ? window.visualViewport.offsetTop : 0) || 0;
        const vLeft = (window.visualViewport ? window.visualViewport.offsetLeft : 0) || 0;
        const margin = 8;

        const portalTarget = document.getElementById('chatbotWindow') || document.body;
        if (control.menu.parentElement !== portalTarget) {
            portalTarget.appendChild(control.menu);
        }

        control.menu.style.position = 'fixed';
        control.menu.style.zIndex = '100005';
        control.menu.style.maxWidth = `calc(${Math.round(vw)}px - 16px)`;
        control.menu.style.maxHeight = `calc(${Math.round(Math.min(vh * 0.65, 320))}px)`;
        control.menu.style.overflowY = 'auto';
        control.menu.style.overscrollBehavior = 'contain';
        control.menu.style.webkitOverflowScrolling = 'touch';

        const menuWidth = Math.min(290, Math.max(220, control.menu.offsetWidth || 235));
        const menuHeight = Math.max(120, control.menu.offsetHeight || 180);

        const spaceAbove = triggerRect.top - vTop - margin;
        const spaceBelow = (vTop + vh) - triggerRect.bottom - margin;

        let top;
        if (spaceAbove >= menuHeight || spaceAbove >= spaceBelow) {
            top = triggerRect.top - menuHeight - 6;
            if (top < vTop + margin) top = vTop + margin;
        } else {
            top = triggerRect.bottom + 6;
            if (top + menuHeight > vTop + vh - margin) {
                top = Math.max(vTop + margin, vTop + vh - menuHeight - margin);
            }
        }

        let left;
        if (name === 'thinking') {
            left = triggerRect.right - menuWidth;
        } else {
            left = triggerRect.left;
        }

        if (left + menuWidth > vLeft + vw - margin) {
            left = vLeft + vw - menuWidth - margin;
        }
        if (left < vLeft + margin) {
            left = vLeft + margin;
        }

        control.menu.style.top = `${Math.round(top)}px`;
        control.menu.style.left = `${Math.round(left)}px`;
        control.menu.style.right = 'auto';
        control.menu.style.bottom = 'auto';
    }

    function closeSelector(name, returnFocus = false) {
        const control = selectorControls[name];
        if (!control?.menu || !control.trigger) return;
        control.menu.hidden = true;
        control.trigger.setAttribute('aria-expanded', 'false');
        if (returnFocus) control.trigger.focus({ preventScroll: true });
    }

    function closeOtherSelectors(exceptName) {
        Object.keys(selectorControls).forEach(name => {
            if (name !== exceptName) closeSelector(name);
        });
    }

    function openSelector(name, focusSelected = true) {
        const control = selectorControls[name];
        if (!control?.menu || !control.trigger) return;
        closeOtherSelectors(name);
        control.menu.hidden = false;
        control.trigger.setAttribute('aria-expanded', 'true');
        positionChatSelectMenu(name);
        requestAnimationFrame(() => {
            positionChatSelectMenu(name);
        });
        if (focusSelected) {
            const isTouch = Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
            if (!isTouch) {
                const selected = selectorOptions(name).find(option => option.dataset.value === control.input?.value);
                (selected || selectorOptions(name)[0])?.focus({ preventScroll: true });
            }
        }
    }

    function setSelectorValue(name, value, dispatchChange = false) {
        const control = selectorControls[name];
        if (!control?.input || !selectorOptions(name).some(option => option.dataset.value === value)) return false;
        control.input.value = value;
        updateSelectorDisplay(name);
        if (dispatchChange) control.input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    function selectOption(name, option) {
        const control = selectorControls[name];
        if (!control?.input || !option) return;
        const value = option.dataset.value;
        
        // Defensive: Ensure maximum values are valid before comparison
        const currentMaximumChatTier = typeof maximumChatTier === 'string' && maximumChatTier.length > 0 ? maximumChatTier : 'lite';
        const currentMaximumThinkingLevel = typeof maximumThinkingLevel === 'string' && maximumThinkingLevel.length > 0 ? maximumThinkingLevel : 'low';
        
        const isLocked = option.dataset.locked === 'true'
            || (name === 'tier' && tierOrder.indexOf(value) > tierOrder.indexOf(currentMaximumChatTier))
            || (name === 'thinking' && ['low', 'standard', 'max'].indexOf(value) > ['low', 'standard', 'max'].indexOf(currentMaximumThinkingLevel));
        if (isLocked) {
            const requiredPlan = name === 'thinking'
                ? value === 'max' ? 'Max' : 'Pro'
                : ({ pro: 'Lite', max: 'Max', ultra: 'Ultra' })[value] || 'Lite';
            closeSelector(name);
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL(requiredPlan, option.dataset.label || control.label, control.trigger);
            } else if (typeof window.showToast === 'function') {
                window.showToast(`Upgrade to ${requiredPlan} Plan to unlock this feature.`);
            } else {
                setStatus(`Upgrade to ${requiredPlan} Plan to unlock this feature.`);
            }
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL !== 'function') control.trigger.focus({ preventScroll: true });
            return;
        }
        control.input.value = value;
        control.input.dispatchEvent(new Event('change', { bubbles: true }));
        updateSelectorDisplay(name);
        closeSelector(name, true);
    }

    function wireCustomSelector(name) {
        const control = selectorControls[name];
        if (!control?.trigger || !control.menu) return;
        bindSafe(control.trigger, 'click', (event) => {
            event?.stopPropagation?.();
            if (control.menu.hidden) openSelector(name);
            else closeSelector(name);
        }, {
            getKey: () => control.trigger,
            preventDefaultOnDebounce: false,
            debounceMs: 100
        });
        control.trigger.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            openSelector(name);
        });
        bindSafe(control.menu, 'click', event => {
            const target = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
            if (target && control.menu.contains(target)) {
                event?.stopPropagation?.();
                selectOption(name, target);
            }
        }, {
            getKey: event => event.target instanceof Element ? event.target.closest('[role="option"]') || control.menu : control.menu,
            preventDefaultOnDebounce: false,
            debounceMs: 80
        });
        control.menu.addEventListener('keydown', event => {
            const options = selectorOptions(name);
            const currentIndex = options.indexOf(event.target);
            let nextIndex = currentIndex;
            if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1 + options.length) % options.length;
            else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = options.length - 1;
            else if (event.key === 'Escape') {
                event.preventDefault();
                closeSelector(name, true);
                return;
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectOption(name, options[currentIndex]);
                return;
            } else return;
            event.preventDefault();
            options[nextIndex]?.focus({ preventScroll: true });
        });
        updateSelectorDisplay(name);
    }

    Object.keys(selectorControls).forEach(wireCustomSelector);
    function handleOutsideSelectClick(event) {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.chat-select, .chat-select-menu')) return;
        Object.keys(selectorControls).forEach(name => closeSelector(name));
    }
    bindSafe(document, 'click', handleOutsideSelectClick, {
        getKey: event => event.target instanceof Element ? event.target.closest('.chat-select, .chat-select-menu') || event.target : document,
        preventDefaultOnDebounce: false
    });
    document.addEventListener('pointerdown', event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest('.chat-select, .chat-select-menu')) {
            Object.keys(selectorControls).forEach(name => closeSelector(name));
        }
    }, { passive: true });

    const repositionOpenSelectors = () => {
        Object.keys(selectorControls).forEach(name => {
            if (!selectorControls[name]?.menu?.hidden) {
                positionChatSelectMenu(name);
            }
        });
    };
    window.addEventListener('resize', repositionOpenSelectors, { passive: true });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', repositionOpenSelectors, { passive: true });
        window.visualViewport.addEventListener('scroll', repositionOpenSelectors, { passive: true });
    }
    messages?.addEventListener('scroll', () => {
        Object.keys(selectorControls).forEach(name => closeSelector(name));
    }, { passive: true });

    window.JEVEXA_CLOSE_SELECTORS = () => {
        Object.keys(selectorControls).forEach(name => closeSelector(name));
    };
    window.JEVEXA_POSITION_SELECTORS = repositionOpenSelectors;

    function appendSearchHighlight(element, text, query) {
        const lowerText = text.toLowerCase();
        const matchIndex = query ? lowerText.indexOf(query) : -1;
        if (matchIndex < 0) {
            element.textContent = text;
            return;
        }
        element.append(document.createTextNode(text.slice(0, matchIndex)));
        const match = document.createElement('mark');
        match.textContent = text.slice(matchIndex, matchIndex + query.length);
        element.append(match, document.createTextNode(text.slice(matchIndex + query.length)));
    }

    function updateChatWelcome(user = (typeof currentUser !== 'undefined' ? currentUser : null)) {
        const title = document.getElementById('chatWelcomeTitle');
        if (!title || conversation.length) return;
        const fullName = typeof user?.user_metadata?.full_name === 'string'
            ? user.user_metadata.full_name.trim()
            : '';
        const emailPrefix = typeof user?.email === 'string' ? user.email.split('@')[0].trim() : '';
        const name = fullName.split(/\s+/)[0] || emailPrefix || 'there';
        title.textContent = `👋 Welcome, ${name}! Ready to automate?`;
    }

    function lockChatTiers() {
        if (!tierSelect) return;
        maximumChatTier = 'lite';
        currentTier = 'lite';
        tierSelect.value = 'lite';
        selectorOptions('tier').forEach(option => {
            option.dataset.locked = String(option.dataset.value !== 'lite');
        });
        updateSelectorDisplay('tier');
        tierSelect.setAttribute('aria-label', 'AI chat tier. Sign in to confirm your maximum tier.');
        if (thinkingSelect) {
            maximumThinkingLevel = 'off';
            currentThinkingLevel = 'off';
            thinkingSelect.value = 'off';
            selectorOptions('thinking').forEach(option => {
                option.dataset.locked = String(option.dataset.value !== 'off');
            });
            updateSelectorDisplay('thinking');
        }
        webSearchEnabled = false;
        syncWebSearchUI();
    }

    function clearAccountChatState() {
        abortInFlightChatRequest();
        conversation.length = 0;
        chatSessions = [];
        activeChatId = null;
        historyUserId = null;
        ambiguousRequestId = null;
        lastTurnCreditUsage = null;
        currentUserPlan = 'free';
        renamingSessionId = null;
        openMenuSessionId = null;
        userMemories = [];
        chatCustomSettings = {
            aboutUser: '',
            responseStyle: '',
            language: 'auto',
            tone: 'default',
            behavior: 'standard',
            codeDepth: 'full',
            density: 'comfortable',
            theme: 'dark',
            reducedMotion: false
        };
        document.querySelectorAll('.chat-history-dropdown-menu').forEach(el => el.remove());
        const confirmModal = document.getElementById('chatConfirmModal');
        if (confirmModal) {
            confirmModal.classList.remove('open');
            confirmModal.hidden = true;
            confirmModal.setAttribute('aria-hidden', 'true');
        }
        messages?.querySelectorAll('.message:not([data-chat-welcome])').forEach(message => message.remove());
        const welcome = messages?.querySelector('[data-chat-welcome]');
        if (welcome) welcome.hidden = false;
        const emptyState = document.getElementById('chatEmptyState');
        if (emptyState) emptyState.hidden = false;
        pendingAttachments.length = 0;
        renderAttachments();
        lockChatTiers();
        applyCustomSettingsToUI();
        renderMemoriesUI();
        renderChatHistory();
        updateChatWelcome(null);
        updateChatHeaderTitle('Jevexa AI');
        setStatus('Please sign in to use the AI chatbot.');
    }

    function conversationKey(userId) {
        return `jevexa_${userId}_chat_sessions`;
    }

    function activeChatKey(userId) {
        return `jevexa_${userId}_active_chat_id`;
    }

    function getPersistedUserId() {
        try {
            const cached = localStorage.getItem('jevexa_persisted_session');
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed?.user?.id) return parsed.user.id;
            }
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
                    const val = localStorage.getItem(key);
                    if (val) {
                        const parsed = JSON.parse(val);
                        const user = parsed?.user || parsed?.currentSession?.user;
                        if (user?.id) return user.id;
                    }
                }
            }
        } catch (_) {}
        return null;
    }

    function positionChatDropdownMenu(menu, triggerBtn) {
        if (!menu || !triggerBtn) return;
        const triggerRect = triggerBtn.getBoundingClientRect();
        const menuWidth = Math.max(154, menu.offsetWidth || 154);
        const menuHeight = Math.max(168, menu.offsetHeight || 168);
        const vw = window.innerWidth || document.documentElement.clientWidth || 360;
        const vh = window.innerHeight || document.documentElement.clientHeight || 640;
        const margin = 8;

        const spaceBelow = vh - triggerRect.bottom - margin;
        const spaceAbove = triggerRect.top - margin;

        let top;
        if (spaceBelow < menuHeight && spaceAbove >= spaceBelow) {
            menu.classList.add('menu-dropup');
            top = triggerRect.top - menuHeight - 4;
        } else {
            menu.classList.remove('menu-dropup');
            top = triggerRect.bottom + 4;
        }

        let left = triggerRect.right - menuWidth;

        // Viewport collision bounds enforcement
        if (left + menuWidth > vw - margin) {
            left = vw - menuWidth - margin;
        }
        if (left < margin) {
            left = margin;
        }
        top = Math.max(margin, Math.min(vh - menuHeight - margin, top));

        menu.style.position = 'fixed';
        menu.style.top = `${Math.round(top)}px`;
        menu.style.left = `${Math.round(left)}px`;
        menu.style.zIndex = '99999';
    }

    function openChatConfirmModal(options = {}) {
        const {
            title = 'Delete chat?',
            message = 'This will permanently delete this conversation and its history.',
            confirmText = 'Delete',
            cancelText = 'Cancel',
            danger = true,
            iconClass = 'fa-trash-can',
            onConfirm,
            onCancel
        } = options;

        const modal = document.getElementById('chatConfirmModal');
        if (!modal) {
            if (typeof onConfirm === 'function') onConfirm();
            return;
        }

        const titleEl = document.getElementById('chatConfirmTitle');
        const msgEl = document.getElementById('chatConfirmMessage');
        const okBtn = document.getElementById('chatConfirmOkBtn');
        const cancelBtn = document.getElementById('chatConfirmCancelBtn');
        const iconEl = document.getElementById('chatConfirmIcon');
        const iconWrap = document.getElementById('chatConfirmIconWrap');
        const dialog = modal.querySelector('.chat-confirm-dialog');

        if (titleEl) titleEl.textContent = title;
        if (msgEl) msgEl.textContent = message;
        if (okBtn) {
            okBtn.textContent = confirmText;
            okBtn.className = danger ? 'chat-confirm-btn chat-confirm-danger' : 'chat-confirm-btn chat-confirm-primary';
        }
        if (cancelBtn) cancelBtn.textContent = cancelText;
        if (iconEl && iconClass) iconEl.className = `fas ${iconClass}`;
        if (iconWrap) {
            iconWrap.className = danger ? 'chat-confirm-icon-wrap' : 'chat-confirm-icon-wrap is-primary';
        }

        const originalParent = modal.parentElement;
        const originalNextSibling = modal.nextSibling;
        if (originalParent && originalParent !== document.body) {
            document.body.appendChild(modal);
        }

        const prevFocus = document.activeElement;

        const closeModal = () => {
            modal.classList.remove('open');
            modal.hidden = true;
            modal.setAttribute('aria-hidden', 'true');
            document.removeEventListener('keydown', handleKey);
            if (originalParent && originalParent.isConnected && modal.parentElement !== originalParent) {
                if (originalNextSibling && originalNextSibling.parentElement === originalParent) {
                    originalParent.insertBefore(modal, originalNextSibling);
                } else {
                    originalParent.appendChild(modal);
                }
            }
            if (prevFocus && typeof prevFocus.focus === 'function') {
                try { prevFocus.focus(); } catch (_) {}
            }
        };

        const handleConfirm = () => {
            closeModal();
            if (typeof onConfirm === 'function') onConfirm();
        };

        const handleCancel = () => {
            closeModal();
            if (typeof onCancel === 'function') onCancel();
        };

        const handleKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                handleCancel();
            } else if (e.key === 'Enter') {
                if (document.activeElement === cancelBtn) {
                    e.preventDefault();
                    handleCancel();
                } else {
                    e.preventDefault();
                    handleConfirm();
                }
            } else if (e.key === 'Tab') {
                const focusables = [cancelBtn, okBtn].filter(Boolean);
                if (!focusables.length) return;
                const first = focusables[0];
                const last = focusables[focusables.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };

        if (okBtn) {
            okBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                handleConfirm();
            };
        }
        if (cancelBtn) {
            cancelBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                handleCancel();
            };
        }
        const backdrop = document.getElementById('chatConfirmBackdrop');
        if (backdrop) {
            backdrop.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                handleCancel();
            };
        }

        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        void modal.offsetWidth;
        modal.classList.add('open');
        document.addEventListener('keydown', handleKey);

        setTimeout(() => {
            (cancelBtn || okBtn || dialog)?.focus();
        }, 20);
    }
    window.openChatConfirmModal = openChatConfirmModal;
    window.closeChatConfirmModal = () => {
        const modal = document.getElementById('chatConfirmModal');
        if (modal) {
            modal.classList.remove('open');
            modal.hidden = true;
            modal.setAttribute('aria-hidden', 'true');
        }
    };
    window.closeChatMenu = closeChatMenu;

    function closeChatMenu() {
        if (openMenuSessionId) {
            openMenuSessionId = null;
            document.querySelectorAll('.chat-history-dropdown-menu').forEach(el => el.remove());
            document.querySelectorAll('.chat-history-row.menu-open, .chat-history-actions.menu-open').forEach(el => el.classList.remove('menu-open'));
            document.querySelectorAll('.chat-history-menu-btn[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
        }
    }

    function renderDropdownMenu(session, triggerBtn) {
        document.querySelectorAll('.chat-history-dropdown-menu').forEach(el => el.remove());
        const menu = document.createElement('div');
        menu.className = 'chat-history-dropdown-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Chat actions');

        // 1. Pin / Unpin
        const pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'chat-menu-item chat-menu-pin';
        pinBtn.setAttribute('role', 'menuitem');
        pinBtn.innerHTML = `<i class="fas ${session.pinned ? 'fa-thumbtack-slash' : 'fa-thumbtack'}"></i><span>${session.pinned ? 'Unpin' : 'Pin'}</span>`;
        bindSafe(pinBtn, 'click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            session.pinned = !session.pinned;
            session.updatedAt = Date.now();
            closeChatMenu();
            saveChatSessions();
            if (typeof window.showToast === 'function') {
                window.showToast(session.pinned ? 'Chat pinned to top' : 'Chat unpinned');
            }
        }, { debounceMs: 0 });

        // 2. Rename
        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'chat-menu-item chat-menu-rename chat-history-rename';
        renameBtn.setAttribute('role', 'menuitem');
        renameBtn.innerHTML = '<i class="fas fa-pencil"></i><span>Rename</span>';
        bindSafe(renameBtn, 'click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeChatMenu();
            renamingSessionId = session.id;
            renderChatHistory();
        }, { debounceMs: 0 });

        // 3. Share
        const shareBtn = document.createElement('button');
        shareBtn.type = 'button';
        shareBtn.className = 'chat-menu-item chat-menu-share';
        shareBtn.setAttribute('role', 'menuitem');
        shareBtn.innerHTML = '<i class="fas fa-arrow-up-from-bracket"></i><span>Share</span>';
        bindSafe(shareBtn, 'click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeChatMenu();
            const shareUrl = `${window.location.origin}/tools/chatbot`;
            const shareTitle = session.title || 'Jevexa AI Chat';
            const userPrompt = session.messages?.find(m => m.role === 'user')?.text || '';
            const shareText = userPrompt
                ? `Jevexa AI Chat: "${shareTitle}"\n"${userPrompt.slice(0, 150)}..."\n${shareUrl}`
                : `${shareTitle} — Jevexa AI Studio\n${shareUrl}`;

            if (navigator.share && typeof navigator.share === 'function') {
                try {
                    await navigator.share({
                        title: shareTitle,
                        text: shareText,
                        url: shareUrl
                    });
                    if (typeof window.showToast === 'function') window.showToast('✓ Chat shared successfully');
                    return;
                } catch (shareErr) {
                    if (shareErr?.name === 'AbortError') return;
                }
            }

            try {
                let copied = false;
                if (typeof window.JEVEXA_COPY_TO_CLIPBOARD === 'function') {
                    copied = await window.JEVEXA_COPY_TO_CLIPBOARD(shareText, {
                        toastMessage: '✓ Chat link copied to clipboard'
                    });
                } else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                    await navigator.clipboard.writeText(shareText);
                    copied = true;
                    window.showToast?.('✓ Chat link copied to clipboard');
                }
                if (!copied) {
                    const ta = document.createElement('textarea');
                    ta.value = shareText;
                    ta.setAttribute('readonly', '');
                    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;';
                    document.body.appendChild(ta);
                    ta.select();
                    copied = Boolean(document.execCommand('copy'));
                    ta.remove();
                    if (copied) window.showToast?.('✓ Chat link copied to clipboard');
                }
                if (!copied) setStatus('Could not copy link to clipboard.');
            } catch (_) {
                if (typeof window.showToast === 'function') window.showToast('Could not copy link to clipboard');
            }
        }, { debounceMs: 0 });

        // 4. Delete (Custom themed In-App confirmation modal, zero native window.confirm)
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'chat-menu-item chat-menu-delete chat-history-delete-btn chat-history-delete';
        deleteBtn.setAttribute('role', 'menuitem');
        deleteBtn.innerHTML = '<i class="fas fa-trash-can"></i><span>Delete</span>';
        bindSafe(deleteBtn, 'click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeChatMenu();
            const chatTitle = session.title || 'New chat';
            openChatConfirmModal({
                title: 'Delete chat?',
                message: `Are you sure you want to delete "${chatTitle}"? This action cannot be undone.`,
                confirmText: 'Delete',
                danger: true,
                onConfirm: () => {
                    chatSessions = chatSessions.filter(item => item.id !== session.id);
                    if (session.id === activeChatId) {
                        activeChatId = null;
                        conversation.length = 0;
                        messages?.querySelectorAll('.message:not([data-chat-welcome])').forEach(message => message.remove());
                        const welcome = messages?.querySelector('[data-chat-welcome]');
                        if (welcome) welcome.hidden = false;
                        const emptyState = document.getElementById('chatEmptyState');
                        if (emptyState) emptyState.hidden = false;
                        updateChatWelcome();
                    }
                    saveChatSessions();
                    void syncChatSessionToServer('DELETE', { id: session.id });
                    if (typeof window.showToast === 'function') window.showToast('Chat deleted');
                }
            });
        }, { debounceMs: 0 });

        menu.append(pinBtn, renameBtn, shareBtn, deleteBtn);

        // Mount as floating portal to body to guarantee zero parent clipping/overflow cutoffs
        const portalTarget = document.body || actions;
        portalTarget.appendChild(menu);

        // Viewport-aware collision positioning with auto flip above / below
        positionChatDropdownMenu(menu, triggerBtn);
        requestAnimationFrame(() => {
            positionChatDropdownMenu(menu, triggerBtn);
        });
    }

    function renderChatHistory() {
        // Clean up any stale floating portal menus
        document.querySelectorAll('.chat-history-dropdown-menu').forEach(el => el.remove());

        const list = document.getElementById('chatHistoryList');
        if (!list) return;
        if (!list.dataset.menuScrollBound) {
            list.dataset.menuScrollBound = 'true';
            list.addEventListener('scroll', closeChatMenu, { passive: true });
        }
        const sidebar = document.getElementById('chatSidebar');
        if (sidebar && !sidebar.dataset.menuScrollBound) {
            sidebar.dataset.menuScrollBound = 'true';
            sidebar.addEventListener('scroll', closeChatMenu, { passive: true });
        }
        const searchInput = document.getElementById('chatHistorySearch');
        const query = searchInput?.value.trim().toLowerCase() || '';
        const emptyState = document.getElementById('chatHistoryEmpty');
        const countBadge = document.getElementById('chatHistoryCount');
        const clearBtn = document.getElementById('chatHistorySearchClear');
        if (clearBtn) clearBtn.hidden = !query;

        const savedScrollTop = list.scrollTop;
        list.replaceChildren();
        const matchingSessions = chatSessions
            .map(session => ({
                session,
                preview: [...session.messages].reverse().find(item => item.role === 'user')?.text || ''
            }))
            .filter(({ session, preview }) => !query
                || `${session.title} ${preview}`.toLowerCase().includes(query))
            .sort((a, b) => {
                const aPinned = Boolean(a.session.pinned);
                const bPinned = Boolean(b.session.pinned);
                if (aPinned !== bPinned) return bPinned ? 1 : -1;
                return b.session.updatedAt - a.session.updatedAt;
            });

        if (countBadge) {
            if (query) {
                countBadge.hidden = false;
                countBadge.textContent = matchingSessions.length === 1 ? '1 chat found' : `${matchingSessions.length} chats found`;
            } else {
                countBadge.hidden = true;
            }
        }

        matchingSessions.forEach(({ session, preview }) => {
            const row = document.createElement('div');
            row.className = `chat-history-row${session.id === activeChatId ? ' active' : ''}${session.pinned ? ' is-pinned' : ''}${openMenuSessionId === session.id ? ' menu-open' : ''}`;
            row.setAttribute('role', 'listitem');

            if (renamingSessionId === session.id) {
                // Inline rename editing mode
                const renameBox = document.createElement('div');
                renameBox.className = 'chat-history-rename-box';
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'chat-history-rename-input';
                input.value = session.title || 'New chat';
                input.maxLength = 60;
                input.setAttribute('aria-label', 'Edit chat title');

                const saveBtn = document.createElement('button');
                saveBtn.type = 'button';
                saveBtn.className = 'chat-history-rename-btn chat-history-rename-save';
                saveBtn.setAttribute('aria-label', 'Save title');
                saveBtn.title = 'Save title';
                saveBtn.innerHTML = '<i class="fas fa-check"></i>';

                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'chat-history-rename-btn chat-history-rename-cancel';
                cancelBtn.setAttribute('aria-label', 'Cancel rename');
                cancelBtn.title = 'Cancel';
                cancelBtn.innerHTML = '<i class="fas fa-xmark"></i>';

                const doSave = () => {
                    const newTitle = input.value.trim() || 'New chat';
                    session.title = newTitle;
                    session.updatedAt = Date.now();
                    renamingSessionId = null;
                    saveChatSessions();
                };

                const doCancel = () => {
                    renamingSessionId = null;
                    renderChatHistory();
                };

                bindSafe(saveBtn, 'click', doSave);
                bindSafe(cancelBtn, 'click', doCancel);
                input.addEventListener('keydown', e => {
                    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
                    else if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
                });

                renameBox.append(input, saveBtn, cancelBtn);
                row.appendChild(renameBox);
                list.appendChild(row);

                setTimeout(() => {
                    input.focus();
                    input.select();
                }, 20);
                return;
            }

            // Normal mode - Single-line clean title only (no preview/snippet line below)
            const select = document.createElement('button');
            select.type = 'button';
            select.className = 'chat-history-select';
            select.setAttribute('aria-label', `${session.pinned ? '[Pinned] ' : ''}${session.title || 'New chat'}`);
            select.setAttribute('aria-current', session.id === activeChatId ? 'true' : 'false');
            select.title = session.title || 'New chat';

            const title = document.createElement('span');
            title.className = 'chat-history-title';

            if (session.pinned) {
                const pinIcon = document.createElement('i');
                pinIcon.className = 'fas fa-thumbtack chat-pinned-indicator';
                pinIcon.setAttribute('aria-hidden', 'true');
                pinIcon.title = 'Pinned chat';
                title.appendChild(pinIcon);
            }

            const titleText = document.createElement('span');
            titleText.className = 'chat-history-title-text';
            appendSearchHighlight(titleText, session.title || 'New chat', query);
            title.appendChild(titleText);

            select.appendChild(title);
            bindSafe(select, 'click', () => selectChatSession(session.id));

            // Three-dots menu actions container
            const actions = document.createElement('div');
            actions.className = `chat-history-actions chat-history-menu-wrap${openMenuSessionId === session.id ? ' menu-open' : ''}`;

            const menuBtn = document.createElement('button');
            menuBtn.type = 'button';
            menuBtn.className = 'chat-history-action-btn chat-history-menu-btn';
            menuBtn.setAttribute('aria-label', `Chat actions for ${session.title || 'chat'}`);
            menuBtn.setAttribute('aria-haspopup', 'menu');
            menuBtn.setAttribute('aria-expanded', String(openMenuSessionId === session.id));
            menuBtn.title = 'More options';
            menuBtn.innerHTML = '<i class="fas fa-ellipsis"></i>';

            bindSafe(menuBtn, 'click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (openMenuSessionId === session.id) {
                    closeChatMenu();
                } else {
                    closeChatMenu();
                    openMenuSessionId = session.id;
                    row.classList.add('menu-open');
                    actions.classList.add('menu-open');
                    menuBtn.setAttribute('aria-expanded', 'true');
                    renderDropdownMenu(session, menuBtn);
                }
            }, { debounceMs: 0 });

            if (openMenuSessionId === session.id) {
                renderDropdownMenu(session, menuBtn);
            }

            actions.appendChild(menuBtn);
            row.append(select, actions);
            list.appendChild(row);
        });

        if (emptyState) {
            emptyState.hidden = matchingSessions.length > 0;
            emptyState.textContent = query ? `No chats match “${query}”.` : 'No saved chats yet.';
        }
        list.scrollTop = savedScrollTop;
    }

    bindSafe(document, 'click', (e) => {
        if (openMenuSessionId && !e.target.closest('.chat-history-menu-wrap') && !e.target.closest('.chat-history-dropdown-menu')) {
            closeChatMenu();
        }
    }, { getKey: () => document, debounceMs: 0, preventDefaultOnDebounce: false });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && openMenuSessionId) {
            e.preventDefault();
            e.stopPropagation();
            closeChatMenu();
        }
    });
    window.addEventListener('resize', closeChatMenu, { passive: true });
    window.addEventListener('scroll', closeChatMenu, { passive: true });

    function saveChatSessions() {
        if (!historyUserId) return true;
        try {
            localStorage.setItem(conversationKey(historyUserId), JSON.stringify(chatSessions.slice(0, 30)));
            renderChatHistory();
            return true;
        } catch (error) {
            if (error?.name === 'QuotaExceededError' || (error?.code === 22) || (error?.code === 1014) || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
                const pruneCount = Math.max(1, Math.ceil(chatSessions.length / 3));
                chatSessions.splice(-pruneCount, pruneCount);
                try {
                    localStorage.setItem(conversationKey(historyUserId), JSON.stringify(chatSessions.slice(0, 30)));
                    renderChatHistory();
                    console.warn('Chat storage was full; pruned', pruneCount, 'oldest sessions.');
                    return true;
                } catch {
                    console.warn('Could not persist chat sessions after pruning; keeping session active in memory.');
                }
            } else {
                console.warn('Chat storage unavailable; keeping session active in memory:', error?.message || error);
            }
            renderChatHistory();
            return true;
        }
    }

    function createChatSession() {
        abortInFlightChatRequest();
        activeChatId = null;
        lastTurnCreditUsage = null;
        conversation.length = 0;
        messages?.querySelectorAll('.message:not([data-chat-welcome])').forEach(message => message.remove());
        const welcome = messages?.querySelector('[data-chat-welcome]');
        if (welcome) welcome.hidden = false;
        const emptyState = document.getElementById('chatEmptyState');
        if (emptyState) emptyState.hidden = false;
        updateChatWelcome();
        pendingAttachments.length = 0;
        renderAttachments();
        webSearchEnabled = isWebSearchAllowed() ? getStoredWebSearchPref(historyUserId || activeAuthUserId) : false;
        syncWebSearchUI();
        renderChatHistory();
        updateChatHeaderTitle('Jevexa AI');
        setStatus(formatMinimalStatus());
        document.getElementById('chatInput')?.focus();
    }

    function selectChatSession(sessionId) {
        abortInFlightChatRequest();
        const session = chatSessions.find(item => item.id === sessionId);
        if (!session) return;
        if (activeChatId && activeChatId !== sessionId && conversation.length > 0) {
            const currentSession = chatSessions.find(item => item.id === activeChatId);
            if (currentSession) {
                currentSession.messages = conversation.slice(-100);
                currentSession.updatedAt = Date.now();
            }
        }
        activeChatId = sessionId;
        webSearchEnabled = isWebSearchAllowed()
            ? (typeof session.webSearch === 'boolean' ? session.webSearch : getStoredWebSearchPref(historyUserId || activeAuthUserId))
            : false;
        syncWebSearchUI();
        updateChatHeaderTitle(session.title || 'Jevexa AI');
        setStatus(formatMinimalStatus());
        if (historyUserId) {
            try {
                localStorage.setItem(activeChatKey(historyUserId), sessionId);
            } catch (_) {}
        }
        conversation.splice(0, conversation.length, ...session.messages);
        messages?.querySelectorAll('.message:not([data-chat-welcome])').forEach(message => message.remove());
        const welcome = messages?.querySelector('[data-chat-welcome]');
        if (welcome) welcome.hidden = conversation.length > 0;
        conversation.forEach((item, index) => {
            const histMeta = item.meta ? { ...item.meta, _fromHistory: true } : null;
            appendMessage(item.text, item.role === 'user', index, histMeta);
        });
        const emptyState = document.getElementById('chatEmptyState');
        if (emptyState) emptyState.hidden = conversation.length > 0;
        updateChatWelcome();
        renderChatHistory();

        if (window.innerWidth <= 767) {
            document.getElementById('chatSidebar')?.classList.remove('open');
            document.getElementById('chatbotWindow')?.classList.remove('chat-history-open');
        }
    }

    // Serialized per-session Supabase sync queue to prevent out-of-order race conditions
    const sessionSyncQueue = new Map();
    async function syncChatSessionToServer(method, payload) {
        if (!historyUserId || typeof window.supabaseClient?.auth?.getSession !== 'function') return;
        const queueKey = payload?.id || '__all__';
        const prev = sessionSyncQueue.get(queueKey) || Promise.resolve();
        const next = prev.then(async () => {
            try {
                const session = await getSession().catch(() => null);
                if (!session?.access_token) return;
                const url = method === 'DELETE'
                    ? (payload?.all ? '/api/chat/sessions?all=true' : `/api/chat/sessions?id=${encodeURIComponent(payload.id)}`)
                    : '/api/chat/sessions';
                await fetch(url, {
                    method,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${session.access_token}`
                    },
                    body: method === 'DELETE' ? undefined : JSON.stringify({ session: payload })
                }).catch(() => {});
            } catch (_) {}
        });
        sessionSyncQueue.set(queueKey, next.catch(() => {}));
        return next;
    }

    async function fetchRemoteChatSessions(userId) {
        if (!userId) return;
        try {
            const session = await getSession().catch(() => null);
            if (!session?.access_token || historyUserId !== userId) return;
            const res = await fetch('/api/chat/sessions', {
                headers: { 'Authorization': `Bearer ${session.access_token}` }
            });
            if (!res.ok) return;
            const data = await res.json().catch(() => null);
            if (!data?.ok || !Array.isArray(data.sessions) || data.sessions.length === 0) return;
            if (historyUserId !== userId) return;

            const byId = new Map(chatSessions.map(s => [s.id, s]));
            let changed = false;
            for (const remote of data.sessions) {
                if (!remote?.id || !Array.isArray(remote.messages)) continue;
                const local = byId.get(remote.id);
                if (!local || (Number(remote.updatedAt) > Number(local.updatedAt || 0))) {
                    byId.set(remote.id, {
                        id: remote.id,
                        title: typeof remote.title === 'string' ? remote.title.slice(0, 48) : 'New chat',
                        updatedAt: Number(remote.updatedAt) || Date.now(),
                        pinned: Boolean(remote.pinned),
                        languageOverride: remote.languageOverride || null,
                        ...(typeof local?.webSearch === 'boolean' ? { webSearch: local.webSearch } : {}),
                        messages: remote.messages.slice(-100).filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string')
                    });
                    changed = true;
                }
            }
            if (changed) {
                chatSessions = Array.from(byId.values()).slice(0, 30);
                saveChatSessions();
            }
        } catch (_) {}
    }

    function persistConversation(userId) {
        try {
            if (!activeChatId) {
                activeChatId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
                chatSessions.unshift({ id: activeChatId, title: 'New chat', updatedAt: Date.now(), pinned: false, webSearch: webSearchEnabled, messages: [] });
            }
            const session = chatSessions.find(item => item.id === activeChatId);
            if (!session) return false;
            session.messages = conversation.slice(-100);
            session.updatedAt = Date.now();
            session.webSearch = webSearchEnabled;
            const firstUserText = session.messages.find(item => item.role === 'user')?.text;
            if (firstUserText && (!session.title || session.title === 'New chat')) {
                session.title = firstUserText.slice(0, 48);
            }
            if (userId) {
                try {
                    localStorage.setItem(activeChatKey(userId), activeChatId);
                } catch (_) {}
            }
            const saved = saveChatSessions();
            if (userId) void syncChatSessionToServer('PUT', session);
            return saved;
        } catch (error) {
            console.error('Could not save chat history:', error);
            return false;
        }
    }

    function loadConversation(userId, force = false) {
        if (!userId) return;
        if (historyUserId === userId && !force && chatSessions.length > 0) {
            return;
        }
        historyUserId = userId;
        activeAuthUserId = userId;
        conversation.length = 0;
        activeChatId = null;
        chatSessions = [];
        messages?.querySelectorAll('.message:not([data-chat-welcome])').forEach(message => message.remove());
        try {
            const saved = JSON.parse(localStorage.getItem(conversationKey(userId)) || '[]');
            if (!Array.isArray(saved)) throw new Error('Saved chat sessions are invalid');
            chatSessions = saved.filter(item => item && typeof item.id === 'string'
                && Array.isArray(item.messages) && typeof item.updatedAt === 'number')
                .slice(-30)
                .map(item => ({
                    id: item.id,
                    title: typeof item.title === 'string' ? item.title.slice(0, 48) : 'New chat',
                    updatedAt: item.updatedAt,
                    pinned: Boolean(item.pinned),
                    languageOverride: item.languageOverride || null,
                    ...(typeof item.webSearch === 'boolean' ? { webSearch: item.webSearch } : {}),
                    messages: item.messages.slice(-100).filter(message =>
                        message && ['user', 'assistant'].includes(message.role)
                        && typeof message.text === 'string' && message.text.length <= 16000
                    )
                }));
            const legacy = JSON.parse(localStorage.getItem(`jevexa_${userId}_chat_history`) || '[]');
            if (!chatSessions.length && Array.isArray(legacy) && legacy.length) {
                chatSessions = [{
                    id: crypto.randomUUID?.() || `${Date.now()}-legacy`,
                    title: legacy.find(item => item?.role === 'user')?.text?.slice(0, 48) || 'Previous chat',
                    updatedAt: Date.now(),
                    pinned: false,
                    messages: legacy.filter(item => item && ['user', 'assistant'].includes(item.role)
                        && typeof item.text === 'string' && item.text.length <= 16000).slice(-100)
                }];
            }
            // FRESH CHAT ON REOPEN:
            // Past conversations remain intact and accessible in the sidebar history list,
            // but the main chat canvas always starts as a fresh clean chat session on launch/reopen.
            // Past chats only load when the user explicitly clicks a chat in the sidebar history.
            activeChatId = null;
            conversation.length = 0;
            messages?.querySelectorAll('.message:not([data-chat-welcome])').forEach(message => message.remove());
            const welcome = messages?.querySelector('[data-chat-welcome]');
            if (welcome) welcome.hidden = false;
            const emptyState = document.getElementById('chatEmptyState');
            if (emptyState) emptyState.hidden = false;
            updateChatWelcome();
            updateChatHeaderTitle('New Chat');
            loadCustomSettings(userId);
            loadMemories(userId);
            renderChatHistory();
        } catch (error) {
            console.warn('Chat history restore notice:', error?.message || error);
            chatSessions = [];
            activeChatId = null;
            conversation.length = 0;
            loadCustomSettings(userId);
            loadMemories(userId);
            renderChatHistory();
        }
    }

    async function refreshTierAccess(session) {
        if (!tierSelect) return;
        try {
            const { data, error } = await supabaseClient.from('user_credits')
                .select('plan,balance').eq('user_id', session.user.id).maybeSingle();
            let maximumTier = 'lite';
            let planKey = (data?.plan || '').trim().toLowerCase();

            // Reconcile with profiles table if user_credits has no plan or is free
            if (!planKey || planKey === 'free') {
                try {
                    const profRes = await supabaseClient.from('profiles')
                        .select('plan').eq('id', session.user.id).maybeSingle();
                    const profPlan = (profRes?.data?.plan || '').trim().toLowerCase();
                    if (profPlan) {
                        const paidPlans = ['lite', 'starter', 'pro', 'max', 'business', 'ultra'];
                        if (!planKey || paidPlans.includes(profPlan)) {
                            planKey = profPlan;
                        }
                    }
                } catch (_) {}
            }

            currentUserPlan = planKey || 'free';
            renderMemoriesUI();
            if (accountTiers[currentUserPlan]) {
                maximumTier = accountTiers[currentUserPlan];
            } else if (!planKey && data && Number.isInteger(data.balance)) {
                // Only use balance fallback if plan is completely unknown/empty (never override explicit free)
                if (data.balance >= 22000) maximumTier = 'max';
                else if (data.balance >= 2500) maximumTier = 'pro';
                else maximumTier = 'lite';
            } else {
                maximumTier = 'lite';
            }
            const maximumIndex = Math.max(0, tierOrder.indexOf(maximumTier));
            maximumChatTier = maximumTier;
            selectorOptions('tier').forEach(option => {
                const optionIndex = tierOrder.indexOf(option.dataset.value);
                const locked = optionIndex > maximumIndex;
                option.dataset.locked = String(locked);
            });
            if (tierOrder.indexOf(tierSelect.value) > maximumIndex) tierSelect.value = maximumTier;
            currentTier = tierSelect.value;
            updateSelectorDisplay('tier');
            tierSelect.setAttribute('aria-label', `AI chat tier. Your maximum tier is ${maximumTier}.`);
            if (thinkingSelect) {
                const isFreeOrLite = ['free', 'lite', 'starter'].includes(currentUserPlan);
                maximumThinkingLevel = isFreeOrLite
                    ? 'off'
                    : (maximumIndex >= 2 ? 'max' : (maximumIndex >= 1 ? 'standard' : 'off'));
                const thinkingMaximumIndex = thinkingOrder.indexOf(maximumThinkingLevel);
                selectorOptions('thinking').forEach(option => {
                    const optionIndex = thinkingOrder.indexOf(option.dataset.value);
                    const locked = optionIndex > thinkingMaximumIndex;
                    option.dataset.locked = String(locked);
                });
                if (thinkingOrder.indexOf(thinkingSelect.value) > thinkingMaximumIndex || thinkingOrder.indexOf(thinkingSelect.value) < 0) {
                    thinkingSelect.value = 'off';
                }
                currentThinkingLevel = thinkingSelect.value;
                updateSelectorDisplay('thinking');
            }
            const activeSess = activeChatId ? chatSessions.find(item => item.id === activeChatId) : null;
            if (isWebSearchAllowed()) {
                webSearchEnabled = typeof activeSess?.webSearch === 'boolean'
                    ? activeSess.webSearch
                    : getStoredWebSearchPref(session.user.id);
            } else {
                webSearchEnabled = false;
            }
            syncWebSearchUI();
            setStatus(formatMinimalStatus());
        } catch (tierErr) {
            console.warn('Chat tier lookup notice, defaulting to lite:', tierErr?.message || tierErr);
            maximumChatTier = 'lite';
            currentTier = 'lite';
            if (tierSelect) tierSelect.value = 'lite';
            updateSelectorDisplay('tier');
            syncWebSearchUI();
            setStatus(formatMinimalStatus());
        }
    }

    function customSettingsKey(userId) {
        return userId ? `jevexa_${userId}_chat_settings` : 'jevexa_chat_settings_global';
    }

    function memoriesKey(userId) {
        return userId ? `jevexa_${userId}_memories` : 'jevexa_memories_global';
    }

    function loadCustomSettings(userId) {
        chatCustomSettings = {
            aboutUser: '',
            responseStyle: '',
            language: 'auto',
            tone: 'default',
            behavior: 'standard',
            codeDepth: 'full',
            density: 'comfortable',
            theme: 'dark',
            reducedMotion: false
        };
        if (userId) {
            try {
                const raw = localStorage.getItem(customSettingsKey(userId));
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') {
                        chatCustomSettings = { ...chatCustomSettings, ...parsed };
                    }
                }
            } catch (_) {}
        }
        applyCustomSettingsToUI();
    }

    function saveCustomSettings(userId) {
        if (!userId) return;
        try {
            const key = customSettingsKey(userId);
            localStorage.setItem(key, JSON.stringify(chatCustomSettings));
        } catch (_) {}
    }

    function applyCustomSettingsToUI() {
        const chatbotWin = document.getElementById('chatbotWindow');
        if (chatbotWin) {
            chatbotWin.setAttribute('data-chat-density', chatCustomSettings.density || 'comfortable');
            chatbotWin.setAttribute('data-chat-theme', chatCustomSettings.theme || 'dark');
        }
        const densityInput = document.getElementById('chatDensity');
        if (densityInput) {
            densityInput.value = chatCustomSettings.density || 'comfortable';
            updateSelectorDisplay('density');
        }
        const themeInput = document.getElementById('chatTheme');
        if (themeInput) {
            themeInput.value = chatCustomSettings.theme || 'dark';
            updateSelectorDisplay('theme');
        }
        const aboutEl = document.getElementById('chatCustomAbout');
        if (aboutEl) aboutEl.value = chatCustomSettings.aboutUser || '';
        const respEl = document.getElementById('chatCustomResponse');
        if (respEl) respEl.value = chatCustomSettings.responseStyle || '';
        const langEl = document.getElementById('chatLanguageSelect');
        if (langEl) langEl.value = chatCustomSettings.language || 'auto';
        const toneEl = document.getElementById('chatToneSelect');
        if (toneEl) toneEl.value = chatCustomSettings.tone || 'default';
        const behEl = document.getElementById('chatBehaviorSelect');
        if (behEl) behEl.value = chatCustomSettings.behavior || 'standard';
        const codeEl = document.getElementById('chatCodeDepthSelect');
        if (codeEl) codeEl.value = chatCustomSettings.codeDepth || 'full';
        const modalTheme = document.getElementById('chatModalThemeSelect');
        if (modalTheme) modalTheme.value = chatCustomSettings.theme || 'dark';
        const modalDensity = document.getElementById('chatModalDensitySelect');
        if (modalDensity) modalDensity.value = chatCustomSettings.density || 'comfortable';
        const modalMotion = document.getElementById('chatModalReducedMotion');
        if (modalMotion) modalMotion.checked = Boolean(chatCustomSettings.reducedMotion);
        const reducedCheck = document.getElementById('chatReducedMotion');
        if (reducedCheck) reducedCheck.checked = Boolean(chatCustomSettings.reducedMotion);
        document.documentElement.classList.toggle('jevexa-reduce-motion', Boolean(chatCustomSettings.reducedMotion));
    }

    function loadMemories(userId) {
        userMemories = [];
        if (userId) {
            try {
                const raw = localStorage.getItem(memoriesKey(userId));
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        userMemories = parsed.filter(m => m && typeof m.content === 'string' && m.content.trim().length > 0);
                    }
                }
            } catch (_) {}
        }
        renderMemoriesUI();

        if (userId && typeof window.supabaseClient?.auth?.getSession === 'function') {
            window.supabaseClient.auth.getSession().then(({ data: { session } }) => {
                if (session?.access_token) {
                    fetch('/api/memories', {
                        headers: { 'Authorization': `Bearer ${session.access_token}` }
                    }).then(res => res.json()).then(data => {
                        if (data?.ok && Array.isArray(data.memories) && data.memories.length > 0) {
                            const existingIds = new Set(userMemories.map(m => m.id));
                            let updated = false;
                            data.memories.forEach(serverMem => {
                                if (!existingIds.has(serverMem.id)) {
                                    userMemories.push(serverMem);
                                    updated = true;
                                }
                            });
                            if (updated) {
                                saveMemories(userId);
                            }
                        }
                    }).catch(() => {});
                }
            }).catch(() => {});
        }
    }

    function saveMemories(userId) {
        if (userId) {
            try {
                const key = memoriesKey(userId);
                localStorage.setItem(key, JSON.stringify(userMemories));
            } catch (_) {}
        }
        renderMemoriesUI();
    }

    function renderMemoriesUI() {
        const limits = getUserPlanMemoryLimits();
        const badge = document.getElementById('chatMemoryBadge');
        if (badge) badge.remove();
        const modalCount = document.getElementById('chatModalMemoryCount');
        const planPill = document.getElementById('chatMemoryPlanPill');
        const usageText = document.getElementById('chatMemoryUsageText');
        const progressBar = document.getElementById('chatMemoryProgressBar');
        const planHint = document.getElementById('chatMemoryPlanHint');
        const list = document.getElementById('chatMemoryList');

        const totalCount = userMemories.length;

        if (modalCount) modalCount.textContent = String(totalCount);
        if (planPill) planPill.textContent = limits.label;
        if (usageText) usageText.textContent = `${totalCount} / ${limits.maxMemories} memories used`;
        if (progressBar) {
            const pct = Math.min(100, Math.round((totalCount / limits.maxMemories) * 100));
            progressBar.style.width = `${pct}%`;
        }
        if (planHint) {
            if (totalCount >= limits.maxMemories) {
                planHint.textContent = `Memory capacity reached (${limits.maxMemories}/${limits.maxMemories}). Upgrade to unlock more slots & deeper context.`;
                planHint.style.color = '#fca5a5';
            } else {
                planHint.textContent = `Max ${limits.maxMemoryChars} chars per memory. Higher plans unlock up to 150 memory slots & deeper chat context.`;
                planHint.style.color = '';
            }
        }

        if (!list) return;
        list.replaceChildren();

        if (userMemories.length === 0) {
            const emptyP = document.createElement('p');
            emptyP.className = 'chat-memory-empty';
            emptyP.textContent = 'No memories saved yet. Add details you want Jevexa AI to remember across chats.';
            list.appendChild(emptyP);
            return;
        }

        userMemories.forEach(mem => {
            const item = document.createElement('div');
            item.className = `chat-memory-item${mem.enabled === false ? ' disabled' : ''}`;

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.checked = mem.enabled !== false;
            toggle.setAttribute('aria-label', `Toggle memory: ${mem.content}`);
            toggle.title = mem.enabled === false ? 'Click to enable' : 'Click to disable';
            bindSafe(toggle, 'change', () => {
                mem.enabled = toggle.checked;
                saveMemories(historyUserId);
                syncMemoryToServer('PUT', { id: mem.id, enabled: mem.enabled });
            });

            const textSpan = document.createElement('span');
            textSpan.className = 'chat-memory-text';
            textSpan.textContent = mem.content;

            const actions = document.createElement('div');
            actions.className = 'chat-memory-actions';

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'chat-memory-btn';
            editBtn.setAttribute('aria-label', 'Edit memory');
            editBtn.title = 'Edit memory';
            editBtn.innerHTML = '<i class="fas fa-pencil"></i>';
            bindSafe(editBtn, 'click', () => {
                if (item.querySelector('.chat-memory-edit-input')) return;
                const editor = document.createElement('input');
                editor.type = 'text';
                editor.className = 'chat-memory-edit-input';
                editor.value = mem.content;
                editor.maxLength = limits.maxMemoryChars;
                editor.setAttribute('aria-label', 'Edit saved memory');
                editor.style.cssText = 'flex:1;min-width:0;padding:6px 10px;border-radius:8px;border:1px solid rgba(139,92,246,0.5);background:rgba(15,23,42,0.85);color:#fff;font-size:12px;';

                let finished = false;
                const commit = saveChanges => {
                    if (finished) return;
                    finished = true;
                    const trimmed = editor.value.trim();
                    if (saveChanges && trimmed && trimmed !== mem.content) {
                        mem.content = trimmed.slice(0, limits.maxMemoryChars);
                        mem.updatedAt = Date.now();
                        saveMemories(historyUserId);
                        syncMemoryToServer('PUT', { id: mem.id, content: mem.content });
                    } else {
                        renderMemoriesUI();
                    }
                };

                editor.addEventListener('keydown', ev => {
                    if (ev.key === 'Enter') {
                        ev.preventDefault();
                        ev.stopPropagation();
                        commit(true);
                    } else if (ev.key === 'Escape') {
                        ev.preventDefault();
                        ev.stopPropagation();
                        commit(false);
                    }
                });
                editor.addEventListener('blur', () => commit(true));

                textSpan.replaceWith(editor);
                editor.focus();
                editor.select();
            });

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'chat-memory-btn chat-memory-del';
            delBtn.setAttribute('aria-label', 'Delete memory');
            delBtn.title = 'Delete memory';
            delBtn.innerHTML = '<i class="fas fa-trash-can"></i>';
            bindSafe(delBtn, 'click', () => {
                userMemories = userMemories.filter(m => m.id !== mem.id);
                saveMemories(historyUserId);
                syncMemoryToServer('DELETE', { id: mem.id });
            });

            actions.append(editBtn, delBtn);
            item.append(toggle, textSpan, actions);
            list.appendChild(item);
        });
    }

    async function syncMemoryToServer(method, body) {
        if (!historyUserId || typeof window.supabaseClient?.auth?.getSession !== 'function') return;
        try {
            const { data: { session } } = await window.supabaseClient.auth.getSession();
            if (!session?.access_token) return;
            fetch('/api/memories', {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify(body)
            }).catch(() => {});
        } catch (_) {}
    }

    function getActiveMemoriesList() {
        const limits = getUserPlanMemoryLimits();
        return userMemories
            .filter(m => m && m.enabled !== false && typeof m.content === 'string' && m.content.trim())
            .slice(0, limits.maxMemories)
            .map(m => m.content.trim());
    }

    function getActiveCustomSettings() {
        const activeSess = chatSessions.find(item => item.id === activeChatId);
        const settings = {
            aboutUser: chatCustomSettings.aboutUser || '',
            responseStyle: chatCustomSettings.responseStyle || '',
            language: chatCustomSettings.language || 'auto',
            tone: chatCustomSettings.tone || 'default',
            behavior: chatCustomSettings.behavior || 'standard',
            codeDepth: chatCustomSettings.codeDepth || 'full'
        };
        if (activeSess && activeSess.languageOverride) {
            settings.language = activeSess.languageOverride;
        }
        return settings;
    }

    function initChatSidebarResizer() {
        const resizer = document.getElementById('chatSidebarResizer');
        const chatbotWin = document.getElementById('chatbotWindow');
        if (!resizer || !chatbotWin) return;

        const MIN_WIDTH = 220;
        const DEFAULT_WIDTH = 290;
        const getMaxWidth = () => Math.min(480, Math.floor(window.innerWidth * 0.45));

        try {
            const savedWidth = parseInt(localStorage.getItem('jevexa_chat_sidebar_width'), 10);
            if (savedWidth && savedWidth >= MIN_WIDTH && savedWidth <= getMaxWidth()) {
                chatbotWin.style.setProperty('--chat-sidebar-width', `${savedWidth}px`);
            }
        } catch (_) {}

        let isDragging = false;
        let startX = 0;
        let startWidth = DEFAULT_WIDTH;

        const onPointerDown = event => {
            if (window.innerWidth <= 767) return;
            isDragging = true;
            startX = event.clientX;
            const currentComputed = parseInt(getComputedStyle(chatbotWin).getPropertyValue('--chat-sidebar-width'), 10) || DEFAULT_WIDTH;
            startWidth = currentComputed;
            resizer.classList.add('is-resizing');
            document.body.classList.add('chat-is-resizing');
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('pointercancel', onPointerUp);
        };

        const onPointerMove = event => {
            if (!isDragging) return;
            const deltaX = event.clientX - startX;
            const maxWidth = getMaxWidth();
            const newWidth = Math.max(MIN_WIDTH, Math.min(maxWidth, startWidth + deltaX));
            chatbotWin.style.setProperty('--chat-sidebar-width', `${newWidth}px`);
        };

        const onPointerUp = () => {
            if (!isDragging) return;
            isDragging = false;
            resizer.classList.remove('is-resizing');
            document.body.classList.remove('chat-is-resizing');
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
            try {
                const finalWidth = parseInt(getComputedStyle(chatbotWin).getPropertyValue('--chat-sidebar-width'), 10) || DEFAULT_WIDTH;
                localStorage.setItem('jevexa_chat_sidebar_width', String(finalWidth));
            } catch (_) {}
        };

        const onDoubleClick = () => {
            if (window.innerWidth <= 767) return;
            chatbotWin.style.setProperty('--chat-sidebar-width', `${DEFAULT_WIDTH}px`);
            try {
                localStorage.setItem('jevexa_chat_sidebar_width', String(DEFAULT_WIDTH));
            } catch (_) {}
        };

        resizer.addEventListener('pointerdown', onPointerDown);
        resizer.addEventListener('dblclick', onDoubleClick);
    }

    function initVirtualViewportTracking() {
        const chatbotWin = document.getElementById('chatbotWindow');
        const chatInput = document.getElementById('chatInput');
        const chatMessages = document.getElementById('chatMessages');

        function scrollToBottom(smooth = true) {
            if (chatMessages) {
                const target = chatMessages.scrollHeight - chatMessages.clientHeight;
                if (target > 0) {
                    if (smooth && typeof chatMessages.scrollTo === 'function') {
                        chatMessages.scrollTo({ top: target, behavior: 'smooth' });
                    } else {
                        chatMessages.scrollTop = target;
                    }
                }
            }
            if (chatInput && typeof chatInput.scrollIntoView === 'function') {
                try {
                    chatInput.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
                } catch (_) {}
            }
        }
        if (typeof window !== 'undefined') {
            window.JEVEXA_SCROLL_TO_BOTTOM = scrollToBottom;
        }

        function updateViewport() {
            if (!chatbotWin) return;
            if (typeof window !== 'undefined' && window.visualViewport) {
                const vv = window.visualViewport;
                const height = Math.round(vv.height);
                const offsetTop = Math.round(vv.offsetTop || 0);
                const winH = window.innerHeight;
                const keyboardInset = Math.max(0, winH - height - offsetTop);

                document.documentElement.style.setProperty('--vvh', `${height}px`);
                document.documentElement.style.setProperty('--vvh-top', `${offsetTop}px`);
                document.documentElement.style.setProperty('--keyboard-inset-bottom', `${keyboardInset}px`);

                if (chatbotWin.classList.contains('open')) {
                    chatbotWin.style.setProperty('--vvh', `${height}px`);
                    chatbotWin.style.setProperty('--vvh-top', `${offsetTop}px`);
                    chatbotWin.style.setProperty('--keyboard-inset-bottom', `${keyboardInset}px`);
                    chatbotWin.style.height = `${height}px`;
                    chatbotWin.style.top = `${offsetTop}px`;
                }
            } else if (typeof window !== 'undefined') {
                const h = window.innerHeight;
                document.documentElement.style.setProperty('--vvh', `${h}px`);
                document.documentElement.style.setProperty('--vvh-top', '0px');
                document.documentElement.style.setProperty('--keyboard-inset-bottom', '0px');
                if (chatbotWin && chatbotWin.classList.contains('open')) {
                    chatbotWin.style.height = `${h}px`;
                    chatbotWin.style.top = '0px';
                }
            }
            repositionOpenSelectors();
        }

        if (typeof window !== 'undefined') {
            window.JEVEXA_UPDATE_VIEWPORT = updateViewport;

            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', () => {
                    updateViewport();
                    if (document.activeElement === chatInput) {
                        scrollToBottom(false);
                    }
                });
                window.visualViewport.addEventListener('scroll', updateViewport);
            }

            window.addEventListener('resize', updateViewport);
            window.addEventListener('orientationchange', () => {
                setTimeout(updateViewport, 120);
            });
        }

        if (chatInput) {
            chatInput.addEventListener('focus', () => {
                updateViewport();
                setTimeout(() => {
                    updateViewport();
                    scrollToBottom(true);
                }, 100);
                setTimeout(() => {
                    updateViewport();
                    scrollToBottom(true);
                }, 300);
            });

            chatInput.addEventListener('blur', () => {
                setTimeout(updateViewport, 150);
            });

            chatInput.addEventListener('input', () => {
                chatInput.style.height = 'auto';
                const newH = Math.min(150, Math.max(44, chatInput.scrollHeight));
                chatInput.style.height = `${newH}px`;
                if (chatMessages && (chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 120)) {
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
            });
        }

        updateViewport();
    }

    function initChatSidebarDrawer() {
        const toggleBtn = document.getElementById('chatSidebarDrawerBtn');
        const closeBtn = document.getElementById('chatSidebarClose');
        const sidebar = document.getElementById('chatSidebar');
        const chatbotWin = document.getElementById('chatbotWindow');

        const toggleSidebar = () => {
            if (window.innerWidth <= 767) {
                const isOpen = sidebar?.classList.toggle('open') || false;
                chatbotWin?.classList.toggle('chat-history-open', isOpen);
            }
        };

        const closeSidebar = () => {
            if (window.innerWidth <= 767) {
                sidebar?.classList.remove('open');
                chatbotWin?.classList.remove('chat-history-open');
            }
        };

        bindSafe(toggleBtn, 'click', toggleSidebar);
        bindSafe(closeBtn, 'click', closeSidebar);
        window.addEventListener('resize', () => {
            if (window.innerWidth > 767) {
                sidebar?.classList.remove('open');
                chatbotWin?.classList.remove('chat-history-open');
            }
        });

        bindSafe(chatbotWin, 'click', (e) => {
            if (window.innerWidth <= 767 && chatbotWin?.classList.contains('chat-history-open')) {
                if (e.target === chatbotWin || (!sidebar?.contains(e.target) && !toggleBtn?.contains(e.target))) {
                    closeSidebar();
                }
            }
        });

        document.addEventListener('keydown', (e) => {
            if ((e.key === 'Escape' || e.key === 'Esc') && chatbotWin?.classList.contains('chat-history-open')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                closeSidebar();
            }
        });
    }

    function clearAllConversations() {
        if (!conversation.length && (!chatSessions || chatSessions.length === 0)) {
            setStatus('Chat history is already empty.');
            return;
        }
        openChatConfirmModal({
            title: 'Clear all conversations?',
            message: 'Clear all saved conversations from this browser? This cannot be undone.',
            confirmText: 'Clear All',
            danger: true,
            onConfirm: () => {
                conversation.splice(0, conversation.length);
                chatSessions = [];
                activeChatId = null;
                if (historyUserId) {
                    try {
                        localStorage.removeItem(conversationKey(historyUserId));
                        localStorage.removeItem(`jevexa_${historyUserId}_chat_history`);
                        localStorage.removeItem(activeChatKey(historyUserId));
                    } catch (error) {
                        console.warn('Could not clear chat sessions from storage:', error);
                    }
                } else {
                    try {
                        localStorage.removeItem('jevexa_chat_history');
                        localStorage.removeItem('jevexa_chat_sessions');
                    } catch (error) {
                        console.warn('Could not clear chat sessions from storage:', error);
                    }
                }
                createChatSession();
                renderChatHistory();
                void syncChatSessionToServer('DELETE', { all: true });
                if (typeof window.showToast === 'function') window.showToast('All conversations cleared');
            }
        });
    }

    function initChatCustomizationSuite() {
        const modal = document.getElementById('chatCustomizationModal');
        const openBtn = document.getElementById('chatOpenCustomizationBtn');
        const headerSettingsBtn = document.getElementById('chatHeaderSettingsBtn');
        const closeBtn = document.getElementById('chatCustomClose');
        const saveBtn = document.getElementById('chatCustomSaveBtn');
        const saveStatus = document.getElementById('chatCustomSaveStatus');

        if (!modal) return;

        let closeTimer = null;

        const openModal = () => {
            if (closeTimer) {
                clearTimeout(closeTimer);
                closeTimer = null;
            }
            applyCustomSettingsToUI();
            renderMemoriesUI();
            modal.hidden = false;
            modal.style.display = 'flex';
            requestAnimationFrame(() => modal.classList.add('open'));
        };

        const closeModal = () => {
            if (closeTimer) {
                clearTimeout(closeTimer);
                closeTimer = null;
            }
            modal.classList.remove('open');
            closeTimer = setTimeout(() => {
                if (!modal.classList.contains('open')) {
                    modal.hidden = true;
                    modal.style.display = 'none';
                }
                closeTimer = null;
            }, 220);
        };
        window.closeChatCustomizationModal = closeModal;

        bindSafe(openBtn, 'click', openModal);
        if (headerSettingsBtn) bindSafe(headerSettingsBtn, 'click', openModal);
        bindSafe(closeBtn, 'click', closeModal);
        bindSafe(modal, 'click', (e) => {
            if (e.target === modal) closeModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !modal.hidden && modal.classList.contains('open')) {
                e.preventDefault();
                e.stopPropagation();
                closeModal();
            }
        });

        const modalTheme = document.getElementById('chatModalThemeSelect');
        if (modalTheme) {
            bindSafe(modalTheme, 'change', () => {
                chatCustomSettings.theme = modalTheme.value || 'dark';
                applyCustomSettingsToUI();
                if (historyUserId) {
                    try {
                        localStorage.setItem(`jevexa_${historyUserId}_chat_theme`, modalTheme.value || 'dark');
                    } catch (_) {}
                }
            });
        }
        const modalDensity = document.getElementById('chatModalDensitySelect');
        if (modalDensity) {
            bindSafe(modalDensity, 'change', () => {
                chatCustomSettings.density = modalDensity.value || 'comfortable';
                applyCustomSettingsToUI();
            });
        }
        const modalMotion = document.getElementById('chatModalReducedMotion');
        if (modalMotion) {
            bindSafe(modalMotion, 'change', () => {
                chatCustomSettings.reducedMotion = Boolean(modalMotion.checked);
                applyCustomSettingsToUI();
                if (historyUserId) {
                    try {
                        localStorage.setItem(`jevexa_${historyUserId}_chat_reduced_motion`, String(modalMotion.checked));
                    } catch (_) {}
                }
            });
        }

        const syncSettingsFromInputs = () => {
            const prevLang = chatCustomSettings.language;
            chatCustomSettings.aboutUser = document.getElementById('chatCustomAbout')?.value.trim() || '';
            chatCustomSettings.responseStyle = document.getElementById('chatCustomResponse')?.value.trim() || '';
            chatCustomSettings.language = document.getElementById('chatLanguageSelect')?.value || 'auto';
            if (chatCustomSettings.language !== prevLang) {
                const activeSess = chatSessions.find(item => item.id === activeChatId);
                if (activeSess) delete activeSess.languageOverride;
            }
            chatCustomSettings.tone = document.getElementById('chatToneSelect')?.value || 'default';
            chatCustomSettings.behavior = document.getElementById('chatBehaviorSelect')?.value || 'standard';
            chatCustomSettings.codeDepth = document.getElementById('chatCodeDepthSelect')?.value || 'full';
            chatCustomSettings.theme = document.getElementById('chatModalThemeSelect')?.value || chatCustomSettings.theme || 'dark';
            chatCustomSettings.density = document.getElementById('chatModalDensitySelect')?.value || 'comfortable';
            chatCustomSettings.reducedMotion = Boolean(document.getElementById('chatModalReducedMotion')?.checked);

            saveCustomSettings(historyUserId);
            applyCustomSettingsToUI();
        };

        const liveControls = [
            'chatLanguageSelect',
            'chatToneSelect',
            'chatBehaviorSelect',
            'chatCodeDepthSelect',
            'chatModalThemeSelect',
            'chatModalDensitySelect',
            'chatModalReducedMotion',
            'chatCustomAbout',
            'chatCustomResponse'
        ];
        liveControls.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const evtName = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
            bindSafe(el, evtName, syncSettingsFromInputs);
        });

        bindSafe(saveBtn, 'click', () => {
            syncSettingsFromInputs();

            if (saveStatus) {
                saveStatus.textContent = '✓ Saved';
                setTimeout(() => { if (saveStatus) saveStatus.textContent = ''; }, 2000);
            }
            if (typeof window.showToast === 'function') {
                window.showToast('✓ Settings saved successfully');
            }
            closeModal();
        });

        const clearHistoryBtn = document.getElementById('chatSettingsClearAllBtn');
        if (clearHistoryBtn) {
            bindSafe(clearHistoryBtn, 'click', () => {
                closeModal();
                clearAllConversations();
            });
        }

        const tabs = modal.querySelectorAll('.chat-custom-tab');
        const panes = modal.querySelectorAll('.chat-custom-pane');
        tabs.forEach(tab => {
            bindSafe(tab, 'click', () => {
                const targetTab = tab.dataset.tab;
                tabs.forEach(t => {
                    t.classList.toggle('active', t === tab);
                    t.setAttribute('aria-selected', String(t === tab));
                });
                panes.forEach(p => {
                    const match = p.id === `pane-${targetTab}`;
                    p.classList.toggle('active', match);
                    p.hidden = !match;
                });
            });
        });

        const addMemoryBtn = document.getElementById('chatAddMemoryBtn');
        const newMemoryInput = document.getElementById('chatNewMemoryInput');
        const handleAddMemory = () => {
            const limits = getUserPlanMemoryLimits();
            const text = newMemoryInput?.value.trim();
            if (!text) return;
            if (userMemories.length >= limits.maxMemories) {
                if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                    window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'expanded AI memory slots');
                } else if (typeof window.showToast === 'function') {
                    window.showToast(`Memory limit reached (${limits.maxMemories}). Upgrade plan for more slots.`);
                } else {
                    const statusText = document.getElementById('chatCustomSaveStatus');
                    if (statusText) statusText.textContent = `Memory limit reached (${limits.maxMemories}). Upgrade to store more.`;
                }
                return;
            }
            const newMem = {
                id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                content: text.slice(0, limits.maxMemoryChars),
                enabled: true,
                createdAt: Date.now()
            };
            userMemories.unshift(newMem);
            if (newMemoryInput) newMemoryInput.value = '';
            saveMemories(historyUserId);
            syncMemoryToServer('POST', { content: newMem.content });
        };
        bindSafe(addMemoryBtn, 'click', handleAddMemory);
        newMemoryInput?.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleAddMemory();
            }
        });
    }

    function getChatbotOnlineState() {
        if (window.JEVEXA_CONNECTIVITY && typeof window.JEVEXA_CONNECTIVITY.isOnline === 'function') {
            return window.JEVEXA_CONNECTIVITY.isOnline();
        }
        return typeof navigator === 'undefined' || navigator.onLine !== false;
    }

    function setChatHeaderConnLabel(statusText, onlineLabel) {
        if (!statusText) return;
        const onlineNow = getChatbotOnlineState();
        statusText.dataset.connState = onlineNow ? 'online' : 'offline';
        statusText.textContent = onlineNow ? onlineLabel : 'Offline';
    }

    async function initializeChatSession() {
        try {
            const session = await getSession();
            const statusText = document.getElementById('chatbotStatusText') || document.querySelector('.chatbot-info .status');
            if (!session) {
                setChatHeaderConnLabel(statusText, 'AI chat • Sign-in required');
                lockChatTiers();
                updateChatWelcome(null);
                return;
            }
            setChatHeaderConnLabel(statusText, 'AI chat • Online');
            loadConversation(session.user.id);
            updateChatWelcome(session.user);
            await refreshTierAccess(session);
            void reconcilePendingRequest(session);
            void fetchRemoteChatSessions(session.user.id);
            try {
                const savedTheme = localStorage.getItem(`jevexa_${session.user.id}_chat_theme`);
                const theme = ['dark', 'light', 'system'].includes(savedTheme)
                    ? savedTheme
                    : (['dark', 'light', 'system'].includes(chatCustomSettings.theme) ? chatCustomSettings.theme : 'dark');
                chatCustomSettings.theme = theme;
                setSelectorValue('theme', theme);
                const modalThemeEl = document.getElementById('chatModalThemeSelect');
                if (modalThemeEl) modalThemeEl.value = theme;
                document.getElementById('chatbotWindow')?.setAttribute('data-chat-theme', theme);
                const reducedMotionEl = document.getElementById('chatReducedMotion') || document.getElementById('chatModalReducedMotion');
                if (reducedMotionEl) {
                    reducedMotionEl.checked =
                        localStorage.getItem(`jevexa_${session.user.id}_chat_reduced_motion`) === 'true';
                    document.documentElement.classList.toggle(
                        'jevexa-reduce-motion',
                        reducedMotionEl.checked
                    );
                }
            } catch (error) {
                console.warn('Could not restore chat settings:', error);
            }
        } catch (error) {
            console.warn('Chat session init:', error?.message || error);
        }
    }

    function formatFileSize(bytes) {
        if (!bytes || bytes < 1024) return `${bytes || 0} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function getFileIcon(type, name) {
        const ext = (name || '').split('.').pop().toLowerCase();
        if ((type && type.startsWith('image/')) || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) {
            return 'fa-image';
        }
        if (type === 'application/pdf' || ext === 'pdf') {
            return 'fa-file-pdf';
        }
        if ((type && type.includes('zip')) || ext === 'zip') {
            return 'fa-file-zipper';
        }
        return 'fa-file';
    }

    function renderAttachments() {
        if (!attachmentList) return;
        attachmentList.replaceChildren();
        pendingAttachments.forEach((attachment, index) => {
            const chip = document.createElement('span');
            chip.className = 'chat-attachment-chip';
            const icon = document.createElement('i');
            icon.className = `fas ${getFileIcon(attachment.type, attachment.name)}`;
            const label = document.createElement('span');
            label.className = 'chip-name';
            label.textContent = attachment.name;
            const size = document.createElement('span');
            size.className = 'chip-size';
            size.textContent = `(${formatFileSize(attachment.size || 0)})`;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.setAttribute('aria-label', `Remove ${attachment.name}`);
            remove.textContent = '×';
            bindSafe(remove, 'click', () => {
                pendingAttachments.splice(index, 1);
                renderAttachments();
            });
            chip.append(icon, label, size, remove);
            attachmentList.appendChild(chip);
        });
        attachmentList.hidden = pendingAttachments.length === 0;
    }

    const PLAN_UPLOAD_CONFIG = {
        free: { name: 'Free', isPaid: false, maxFiles: 5, maxFileSize: 5 * 1024 * 1024, maxBatchSize: 25 * 1024 * 1024 },
        lite: { name: 'Lite', isPaid: true, maxFiles: 5, maxFileSize: 10 * 1024 * 1024, maxBatchSize: 35 * 1024 * 1024 },
        starter: { name: 'Lite', isPaid: true, maxFiles: 5, maxFileSize: 10 * 1024 * 1024, maxBatchSize: 35 * 1024 * 1024 },
        pro: { name: 'Pro', isPaid: true, maxFiles: 8, maxFileSize: 25 * 1024 * 1024, maxBatchSize: 75 * 1024 * 1024 },
        max: { name: 'Max', isPaid: true, maxFiles: 12, maxFileSize: 50 * 1024 * 1024, maxBatchSize: 150 * 1024 * 1024 },
        business: { name: 'Max', isPaid: true, maxFiles: 12, maxFileSize: 50 * 1024 * 1024, maxBatchSize: 150 * 1024 * 1024 },
        ultra: { name: 'Ultra', isPaid: true, maxFiles: 20, maxFileSize: 100 * 1024 * 1024, maxBatchSize: 300 * 1024 * 1024 }
    };

    function isPaidPlanActive() {
        const plan = (currentUserPlan || 'free').toLowerCase();
        return plan !== 'free' && plan !== '' && plan !== 'starter_free';
    }

    function getCurrentPlanConfig() {
        const plan = (currentUserPlan || 'free').toLowerCase();
        return PLAN_UPLOAD_CONFIG[plan] || PLAN_UPLOAD_CONFIG.free;
    }

    async function addAttachments(files) {
        const isPaid = isPaidPlanActive();
        const planConfig = getCurrentPlanConfig();
        const maxFiles = isPaid ? planConfig.maxFiles : 5; // Free plan allows up to 5 images

        if (pendingAttachments.length + files.length > maxFiles) {
            setStatus(isPaid
                ? `Your ${planConfig.name} plan allows up to ${maxFiles} files per message.`
                : 'Free plan allows up to 5 images per message. Upgrade to attach more.');
            return;
        }
        const prepared = [];
        let runningBatchBytes = pendingAttachments.reduce((sum, item) => sum + (item.size || 0), 0);
        const maxTransportRawBytes = Math.min(planConfig.maxBatchSize || (25 * 1024 * 1024), 75 * 1024 * 1024);
        const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        const paidFileTypes = ['application/pdf', 'application/zip', 'application/x-zip-compressed'];
        const extensionTypes = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
            pdf: 'application/pdf', zip: 'application/zip'
        };

        for (const file of files) {
            if (!file.size) {
                setStatus(`${file.name || 'Selected file'} is empty (0 bytes) and was skipped.`);
                continue;
            }
            const extension = (file.name || '').split('.').pop().toLowerCase();
            const type = (file.type || extensionTypes[extension] || '').toLowerCase();
            const isImage = imageTypes.includes(type) || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(extension);

            // Free Plan: Images only (max 5, max 5 MB each). Block PDFs, ZIPs, and other doc types with upgrade modal.
            if (!isPaid) {
                if (!isImage) {
                    setStatus('PDF and ZIP uploads require a Paid plan. Upgrade to unlock document and archive files.', true);
                    if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                        window.JEVEXA_SHOW_UPGRADE_MODAL('Lite', 'PDF, ZIP & file uploads', attachButton);
                    }
                    if (typeof window.showToast === 'function') {
                        window.showToast('Upgrade to a Paid plan (Lite, Pro, Max, or Ultra) to upload PDF and ZIP files.');
                    }
                    return;
                }
                if (file.size > 5 * 1024 * 1024) {
                    setStatus(`${file.name} is too large. Free plan images must be under 5 MB.`);
                    return;
                }
            } else {
                // Paid Plans: Images + PDF + ZIP + files with progressive tier limits
                const isPaidFileType = isImage || paidFileTypes.includes(type) || ['pdf', 'zip'].includes(extension);
                if (!isPaidFileType) {
                    setStatus('Supported files are JPEG, PNG, WebP, GIF, PDF, and ZIP.');
                    return;
                }
                if (file.size > planConfig.maxFileSize) {
                    const mbLimit = Math.round(planConfig.maxFileSize / (1024 * 1024));
                    setStatus(`${file.name} (${formatFileSize(file.size)}) exceeds your ${planConfig.name} plan limit of ${mbLimit} MB per file.`);
                    return;
                }
            }
            if (runningBatchBytes + file.size > maxTransportRawBytes) {
                const batchMb = Math.round(maxTransportRawBytes / (1024 * 1024));
                setStatus(`Total attachment batch size exceeds the ${batchMb} MB per-message upload limit. Remove a file or split into multiple messages.`);
                return;
            }
            runningBatchBytes += file.size;

            if (isImage || (isPaid && (paidFileTypes.includes(type) || ['pdf', 'zip'].includes(extension)))) {
                const normalizedType = (type === 'application/x-zip-compressed' || extension === 'zip')
                    ? 'application/zip'
                    : (type || (extension === 'pdf' ? 'application/pdf' : 'application/octet-stream'));
                prepared.push({
                    name: file.name,
                    size: file.size,
                    type: normalizedType,
                    data: await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => {
                            const result = String(reader.result || '');
                            const base64 = result.slice(result.indexOf(',') + 1);
                            resolve(`data:${normalizedType};base64,${base64}`);
                        };
                        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
                        reader.readAsDataURL(file);
                    })
                });
            }
        }
        pendingAttachments.push(...prepared);
        renderAttachments();
        if (pendingAttachments.length) setStatus(`${pendingAttachments.length} attachment${pendingAttachments.length === 1 ? '' : 's'} ready.`);
    }

    function setStatus(message, showUpgrade = false) {
        if (!status) return;
        const turnMatch = typeof message === 'string' && message.match(/^(.+?)\s+(?:•\s*)?Used credit:\s*([\d,]+)\s+(?:·\s*)?Remaining credit:\s*([\d,]+)$/i);
        const remOnlyMatch = !turnMatch && typeof message === 'string' && message.match(/^(.+?)\s+(?:•\s*)?Remaining credit:\s*([\d,]+)$/i);
        if (turnMatch) {
            const [, prefixPart, usedVal, remainingVal] = turnMatch;
            status.innerHTML = `<span class="chat-status-tier">${escapeMarkdownHtml(prefixPart.trim())}</span> <span class="chat-status-stat">Used credit: <strong class="chat-credit-used-val">${escapeMarkdownHtml(usedVal)}</strong></span> <span class="chat-status-stat">Remaining credit: <strong class="chat-credit-rem-val">${escapeMarkdownHtml(remainingVal)}</strong></span>`;
        } else if (remOnlyMatch) {
            const [, prefixPart, remainingVal] = remOnlyMatch;
            status.innerHTML = `<span class="chat-status-tier">${escapeMarkdownHtml(prefixPart.trim())}</span> <span class="chat-status-stat">Remaining credit: <strong class="chat-credit-rem-val">${escapeMarkdownHtml(remainingVal)}</strong></span>`;
        } else {
            status.textContent = message;
        }
        if (upgradeLink) upgradeLink.hidden = !showUpgrade;
    }

    async function refreshDisplayedCredits() {
        try {
            await window.JEVEXA_SETTINGS?.refreshCredits?.();
            window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
        } catch (error) {
            console.error('Credit balance refresh failed:', error);
        }
    }

    let userScrolledUpDuringStream = false;

    function isScrolledNearBottom(threshold = 120) {
        if (!messages) return true;
        return (messages.scrollHeight - messages.scrollTop - messages.clientHeight) <= threshold;
    }

    function updateScrollBottomButton() {
        const scrollBottomBtn = document.getElementById('chatScrollBottom');
        if (!messages || !scrollBottomBtn) return;
        const distance = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
        if (distance > 140) {
            scrollBottomBtn.hidden = false;
            scrollBottomBtn.classList.add('visible');
        } else {
            scrollBottomBtn.hidden = true;
            scrollBottomBtn.classList.remove('visible');
        }
    }

    function scrollChatToBottom(force = false) {
        if (!messages) return;
        if (force) {
            userScrolledUpDuringStream = false;
            messages.scrollTo({
                top: messages.scrollHeight,
                behavior: 'auto'
            });
            updateScrollBottomButton();
            return;
        }
        if (!userScrolledUpDuringStream && isScrolledNearBottom(140)) {
            messages.scrollTop = messages.scrollHeight;
            updateScrollBottomButton();
        }
    }

    function escapeMarkdownHtml(str) {
        return String(str).replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    function applyInlineMarkdown(escapedText) {
        if (!escapedText) return '';
        const inlineCodes = [];
        let out = escapedText.replace(/`([^`\n]+)`/g, (_m, code) => {
            const idx = inlineCodes.length;
            inlineCodes.push(`<code>${code}</code>`);
            return `@@JEVEXA_INLINE_CODE_${idx}@@`;
        });
        out = out
            .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
            .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
            .replace(/(^|\s)\*{3,}(?=\s|$)/g, '$1')
            .replace(/\[([^\]]+)\]\((#[a-zA-Z0-9_-]+)\)/g, '<a href="$2">$1</a>')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^\s<>"')]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        return out.replace(/@@JEVEXA_INLINE_CODE_(\d+)@@/g, (_m, idx) => inlineCodes[Number(idx)] || '');
    }

    function splitTableRow(line) {
        const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
        return trimmed.split('|').map(cell => cell.trim());
    }

    function isTableSeparatorLine(line) {
        const trimmed = line.trim();
        if (!trimmed.includes('|') && !trimmed.includes('-')) return false;
        const cells = splitTableRow(trimmed);
        return cells.length >= 1 && cells.every(c => /^:?-{3,}:?$/.test(c));
    }

    function getTableAlignments(sepLine) {
        return splitTableRow(sepLine).map(cell => {
            if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
            if (cell.endsWith(':')) return 'right';
            return 'left';
        });
    }

    function highlightCodeTokens(escapedCode, lang) {
        const cleanLang = String(lang || '').toLowerCase();
        if (!escapedCode || !cleanLang || cleanLang === 'text' || cleanLang === 'txt' || cleanLang === 'plain' || cleanLang === 'plaintext') {
            return escapedCode;
        }
        const tokenPlaceholders = [];
        const saveToken = (cls, text) => {
            const idx = tokenPlaceholders.length;
            tokenPlaceholders.push(`<span class="${cls}">${text}</span>`);
            return `@@JEV_TOK_${idx}@@`;
        };
        let out = escapedCode
            // Strings (HTML-escaped quotes are &quot; or &#39; or backticks)
            .replace(/(&quot;(?:\\.|(?!&quot;)[^\\\n])*?&quot;|&#39;(?:\\.|(?!&#39;)[^\\\n])*?&#39;|`[^`\n]*?`)/g, m => saveToken('tok-str', m))
            // Line comments (// or # or --)
            .replace(/(\/\/[^\n]*|(?<=^|\s)#[^\n]*|--[^\n]*)/gm, m => saveToken('tok-com', m));
        // Keywords
        out = out.replace(/\b(const|let|var|function|async|await|return|if|else|for|while|switch|case|break|continue|import|export|from|default|class|extends|new|try|catch|finally|throw|typeof|instanceof|def|elif|with|as|pass|yield|lambda|SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|JOIN|ON|GROUP|BY|ORDER|LIMIT|AND|OR|NOT|NULL|TRUE|FALSE|true|false|null|undefined|None|True|False)\b/g, '<span class="tok-kw">$1</span>');
        // Numbers
        out = out.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
        return out.replace(/@@JEV_TOK_(\d+)@@/g, (_m, idx) => tokenPlaceholders[Number(idx)] || '');
    }

    function renderMarkdown(text, { streaming = false } = {}) {
        if (!text) return '';
        const codeBlocks = [];
        let sourceText = String(text);

        // 1. Extract closed fenced code blocks first so inner formatting isn't mangled
        let placeholderText = sourceText.replace(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g, (_match, lang, code) => {
            const index = codeBlocks.length;
            codeBlocks.push({ lang: lang ? lang.trim() : 'text', code, unclosed: false });
            return `\n@@JEVEXA_CODE_BLOCK_${index}@@\n`;
        });

        // Support trailing unclosed code fence smoothly during live SSE streaming
        if (streaming) {
            placeholderText = placeholderText.replace(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*)$/, (_match, lang, code) => {
                const index = codeBlocks.length;
                codeBlocks.push({ lang: lang ? lang.trim() : 'text', code, unclosed: true });
                return `\n@@JEVEXA_CODE_BLOCK_${index}@@\n`;
            });
        }

        // 2. Escape HTML special characters to prevent XSS
        const escaped = escapeMarkdownHtml(placeholderText);

        // 3. Block-level parsing (headings, tables, lists, blockquotes, hr, grouped paragraphs)
        const lines = escaped.split(/\r?\n/);
        const output = [];
        let inUl = false;
        let inOl = false;
        let paragraphLines = [];
        let blockquoteLines = [];

        const flushParagraph = () => {
            if (paragraphLines.length > 0) {
                output.push(`<p>${paragraphLines.map(l => applyInlineMarkdown(l)).join('<br>')}</p>`);
                paragraphLines = [];
            }
        };

        const flushBlockquote = () => {
            if (blockquoteLines.length > 0) {
                output.push(`<blockquote>${blockquoteLines.map(l => applyInlineMarkdown(l)).join('<br>')}</blockquote>`);
                blockquoteLines = [];
            }
        };

        const closeLists = () => {
            if (inUl) { output.push('</ul>'); inUl = false; }
            if (inOl) { output.push('</ol>'); inOl = false; }
        };

        const flushAllBlocks = () => {
            flushParagraph();
            flushBlockquote();
            closeLists();
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed) {
                flushAllBlocks();
                continue;
            }

            if (/^@@JEVEXA_CODE_BLOCK_(\d+)@@$/.test(trimmed)) {
                flushAllBlocks();
                output.push(trimmed);
                continue;
            }

            // Markdown Tables: header row followed by | --- | separator row
            if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
                flushAllBlocks();
                const headers = splitTableRow(trimmed);
                const alignments = getTableAlignments(lines[i + 1]);
                const bodyRows = [];
                i += 2;
                while (i < lines.length) {
                    const rowTrimmed = lines[i].trim();
                    if (!rowTrimmed || !rowTrimmed.includes('|') || /^@@JEVEXA_CODE_BLOCK_\d+@@$/.test(rowTrimmed)) {
                        i -= 1;
                        break;
                    }
                    bodyRows.push(splitTableRow(rowTrimmed));
                    i += 1;
                }
                const colCount = Math.max(headers.length, alignments.length);
                const thHtml = Array.from({ length: colCount }, (_, colIdx) => {
                    const align = alignments[colIdx] || 'left';
                    return `<th style="text-align:${align}">${applyInlineMarkdown(headers[colIdx] || '')}</th>`;
                }).join('');
                const trHtml = bodyRows.map(cells => {
                    const tds = Array.from({ length: colCount }, (_, colIdx) => {
                        const align = alignments[colIdx] || 'left';
                        return `<td style="text-align:${align}">${applyInlineMarkdown(cells[colIdx] || '')}</td>`;
                    }).join('');
                    return `<tr>${tds}</tr>`;
                }).join('');
                output.push(`<div class="chat-table-wrap"><table class="chat-md-table"><thead><tr>${thHtml}</tr></thead>${trHtml ? `<tbody>${trHtml}</tbody>` : ''}</table></div>`);
                continue;
            }

            // Headings
            if (/^####\s+(.+)$/.test(trimmed)) {
                flushAllBlocks();
                output.push(`<h5 class="chat-h4">${applyInlineMarkdown(trimmed.replace(/^####\s+/, ''))}</h5>`);
                continue;
            }
            if (/^###\s+(.+)$/.test(trimmed)) {
                flushAllBlocks();
                output.push(`<h4 class="chat-h3">${applyInlineMarkdown(trimmed.replace(/^###\s+/, ''))}</h4>`);
                continue;
            }
            if (/^##\s+(.+)$/.test(trimmed)) {
                flushAllBlocks();
                output.push(`<h3 class="chat-h2">${applyInlineMarkdown(trimmed.replace(/^##\s+/, ''))}</h3>`);
                continue;
            }
            if (/^#\s+(.+)$/.test(trimmed)) {
                flushAllBlocks();
                output.push(`<h2 class="chat-h1">${applyInlineMarkdown(trimmed.replace(/^#\s+/, ''))}</h2>`);
                continue;
            }

            // Blockquotes (grouped consecutive > lines)
            if (/^&gt;\s*(.*)$/.test(trimmed)) {
                flushParagraph();
                closeLists();
                blockquoteLines.push(trimmed.replace(/^&gt;\s*/, ''));
                continue;
            }

            // Horizontal rule
            if (/^(?:---|\*\*\*|___)$/.test(trimmed)) {
                flushAllBlocks();
                output.push('<hr class="chat-divider">');
                continue;
            }

            // Unordered list item
            const ulMatch = trimmed.match(/^[-*•]\s+(.+)$/);
            if (ulMatch) {
                flushParagraph();
                flushBlockquote();
                if (inOl) { output.push('</ol>'); inOl = false; }
                if (!inUl) { output.push('<ul>'); inUl = true; }
                output.push(`<li>${applyInlineMarkdown(ulMatch[1])}</li>`);
                continue;
            }

            // Ordered list item
            const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
            if (olMatch) {
                flushParagraph();
                flushBlockquote();
                if (inUl) { output.push('</ul>'); inUl = false; }
                if (!inOl) { output.push('<ol>'); inOl = true; }
                output.push(`<li>${applyInlineMarkdown(olMatch[1])}</li>`);
                continue;
            }

            // Regular paragraph line (grouped cleanly)
            flushBlockquote();
            closeLists();
            paragraphLines.push(line);
        }
        flushAllBlocks();

        let rendered = output.join('');

        // 4. Reinsert code blocks with header and copy button
        rendered = rendered.replace(/@@JEVEXA_CODE_BLOCK_(\d+)@@/g, (_match, idx) => {
            const block = codeBlocks[Number(idx)];
            if (!block) return '';
            const safeCode = escapeMarkdownHtml(block.code);
            const langLabel = escapeMarkdownHtml(block.lang || 'code');
            const highlighted = streaming ? safeCode : highlightCodeTokens(safeCode, block.lang);
            return `<div class="chat-code-block"><div class="chat-code-header"><span class="chat-code-lang">${langLabel}</span><button type="button" class="chat-code-copy" aria-label="Copy code"><i class="far fa-copy" aria-hidden="true"></i> <span>Copy</span></button></div><pre><code class="language-${langLabel}">${highlighted}</code></pre></div>`;
        });

        return rendered;
    }

    function trimConversationToMax(maxMessages = 100) {
        if (conversation.length <= maxMessages) return;
        const dropCount = conversation.length - maxMessages;
        conversation.splice(0, dropCount);
        if (!messages) return;
        const rendered = Array.from(messages.querySelectorAll('.message:not([data-chat-welcome])'));
        rendered.forEach(node => {
            const oldIdx = Number(node.dataset.messageIndex);
            if (!Number.isInteger(oldIdx)) return;
            const newIdx = oldIdx - dropCount;
            if (newIdx < 0) {
                node.remove();
            } else {
                node.dataset.messageIndex = String(newIdx);
            }
        });
    }

    function buildUserActionButtons() {
        const actions = document.createElement('div');
        actions.className = 'chat-message-actions chat-user-actions';
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'chat-action-btn';
        copy.dataset.chatAction = 'copy-user';
        copy.setAttribute('aria-label', 'Copy message');
        copy.title = 'Copy prompt';
        copy.innerHTML = '<i class="far fa-copy" aria-hidden="true"></i><span>Copy</span>';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'chat-action-btn';
        edit.dataset.chatAction = 'edit-user';
        edit.setAttribute('aria-label', 'Edit message');
        edit.title = 'Edit & resubmit';
        edit.innerHTML = '<i class="fas fa-pen" aria-hidden="true"></i><span>Edit</span>';
        actions.append(copy, edit);
        return actions;
    }

    function buildBotActionButtons() {
        const actions = document.createElement('div');
        actions.className = 'chat-message-actions chat-bot-actions';
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'chat-action-btn';
        copy.dataset.chatAction = 'copy';
        copy.setAttribute('aria-label', 'Copy response');
        copy.title = 'Copy response';
        copy.innerHTML = '<i class="far fa-copy" aria-hidden="true"></i><span>Copy</span>';
        const regenerate = document.createElement('button');
        regenerate.type = 'button';
        regenerate.className = 'chat-action-btn';
        regenerate.dataset.chatAction = 'regenerate';
        regenerate.setAttribute('aria-label', 'Regenerate response');
        regenerate.title = 'Regenerate response';
        regenerate.innerHTML = '<i class="fas fa-rotate-right" aria-hidden="true"></i><span>Regenerate</span>';
        actions.append(copy, regenerate);
        return actions;
    }

    function applyBotMetaStatus(content, meta) {
        if (!content || !meta) return;
        content.querySelectorAll('.chat-web-grounded-badge, .chat-credit-receipt').forEach(el => el.remove());

        const extracted = window.JEVEXA_EXTRACT_CREDIT_USAGE?.(meta, {
            fallbackToLiveBalance: !meta._fromHistory
        });
        let used = extracted?.used ?? (
            Number.isInteger(meta.creditsUsed) ? meta.creditsUsed
                : (Number.isInteger(meta.credits_used) ? meta.credits_used
                    : (Number.isInteger(meta.creditsCharged) ? meta.creditsCharged
                        : (Number.isInteger(meta.charged_credits) ? meta.charged_credits : null)))
        );
        if (used === null && !meta.unconfirmedSettlement && !meta._fromHistory) {
            used = 1;
        } else if (used === null && meta._fromHistory && !meta.unconfirmedSettlement && (meta.tier || meta.modelName || meta.model)) {
            used = 1;
        }
        let remaining = extracted?.remaining ?? (
            Number.isInteger(meta.remainingCredits) ? meta.remainingCredits
                : (Number.isInteger(meta.remaining_credits) ? meta.remaining_credits
                    : (Number.isInteger(meta.creditsRemaining) ? meta.creditsRemaining : null))
        );
        if (remaining === null && !meta._fromHistory) {
            const liveBal = getCachedRemainingCredits();
            if (Number.isInteger(liveBal) && liveBal >= 0) remaining = liveBal;
        }

        const tierNameMap = { lite: 'Core Engine', pro: 'Pro Engine', max: 'Deep Reasoning', ultra: 'Ultra Reasoning' };
        const fallbackModel = (meta.tier && tierNameMap[String(meta.tier).toLowerCase()]) || 'Core Engine';
        const rawModel = extracted?.model || meta.modelName || meta.model || fallbackModel;
        const activeModel = window.JEVEXA_SANITIZE_ENGINE_NAME
            ? window.JEVEXA_SANITIZE_ENGINE_NAME(rawModel, fallbackModel)
            : fallbackModel;
        const webGrounded = Boolean(meta.webSearch);
        const webSurcharge = Number(meta.webSearchSurcharge) || 5;
        if (used !== null && remaining !== null) {
            setStatus(formatMinimalStatus({ tier: meta.tier || currentTier, webSearch: webGrounded, used, remaining }));
        }
        if (webGrounded) {
            const webBadge = document.createElement('div');
            webBadge.className = 'chat-web-grounded-badge';
            webBadge.title = `Real-time web grounding applied (+${webSurcharge} credits)`;
            webBadge.innerHTML = `<i class="fas fa-globe" aria-hidden="true"></i><span>Web Grounded</span>`;
            content.appendChild(webBadge);
        }
        if (used !== null && used >= 0) {
            const receipt = document.createElement('div');
            receipt.className = 'chat-credit-receipt';
            receipt.setAttribute('role', 'status');
            receipt.setAttribute('aria-live', 'polite');
            receipt.dataset.usedCredits = String(used);
            if (remaining !== null && remaining >= 0) {
                receipt.dataset.remainingCredits = String(remaining);
            }
            const remHtml = (remaining !== null && remaining >= 0)
                ? ` <span class="chat-receipt-rem">Remaining credit: <strong>${remaining}</strong></span>`
                : '';
            receipt.innerHTML = `<span class="chat-receipt-tier">${escapeHtml(activeModel)}</span> <span class="chat-receipt-used">⚡ Used credit: <strong>${used}</strong></span>${remHtml}`;
            content.appendChild(receipt);
        } else if (meta.unconfirmedSettlement) {
            const receipt = document.createElement('div');
            receipt.className = 'chat-credit-receipt';
            receipt.setAttribute('role', 'status');
            receipt.innerHTML = `<span class="chat-receipt-tier">${escapeHtml(activeModel)}</span> <span class="chat-receipt-used">⚡ Credit settlement pending reconciliation</span>`;
            content.appendChild(receipt);
        }
    }

    function createStreamingMessageRow(index = conversation.length) {
        if (!messages) return null;
        const row = document.createElement('div');
        row.className = 'message bot is-streaming';
        row.dataset.messageIndex = String(index);
        const avatar = document.createElement('div');
        avatar.className = 'msg-avatar';
        const icon = document.createElement('i');
        icon.className = 'fas fa-wand-magic-sparkles';
        avatar.appendChild(icon);
        const col = document.createElement('div');
        col.className = 'msg-bot-col';
        const content = document.createElement('div');
        content.className = 'msg-content';
        const body = document.createElement('div');
        body.className = 'msg-body';
        content.appendChild(body);
        col.appendChild(content);
        row.append(avatar, col);
        messages.appendChild(row);
        const renderedMessages = messages.querySelectorAll('.message:not([data-chat-welcome])');
        for (let i = 0; i < renderedMessages.length - maxRenderedMessages; i += 1) {
            renderedMessages[i].remove();
        }
        const welcome = messages.querySelector('[data-chat-welcome]');
        if (welcome) welcome.hidden = true;
        const emptyState = document.getElementById('chatEmptyState');
        if (emptyState) emptyState.hidden = true;
        return { row, col, content, body };
    }

    function appendMessage(text, user = false, index = conversation.length, meta = null) {
        if (!messages) return;
        const row = document.createElement('div');
        row.className = `message ${user ? 'user' : 'bot'}`;
        row.dataset.messageIndex = String(index);
        const avatar = document.createElement('div');
        avatar.className = 'msg-avatar';
        const icon = document.createElement('i');
        icon.className = `fas fa-${user ? 'user' : 'wand-magic-sparkles'}`;
        avatar.appendChild(icon);
        const content = document.createElement('div');
        content.className = 'msg-content';
        const body = document.createElement('div');
        body.className = 'msg-body';
        body.innerHTML = renderMarkdown(text);
        content.appendChild(body);
        if (user) {
            const col = document.createElement('div');
            col.className = 'msg-user-col';
            col.append(content, buildUserActionButtons());
            row.append(avatar, col);
        } else {
            const col = document.createElement('div');
            col.className = 'msg-bot-col';
            applyBotMetaStatus(content, meta);
            col.append(content, buildBotActionButtons());
            row.append(avatar, col);
        }
        messages.appendChild(row);
        const renderedMessages = messages.querySelectorAll('.message:not([data-chat-welcome])');
        for (let idx = 0; idx < renderedMessages.length - maxRenderedMessages; idx += 1) {
            renderedMessages[idx].remove();
        }
        const welcome = messages.querySelector('[data-chat-welcome]');
        if (welcome) welcome.hidden = true;
        const emptyState = document.getElementById('chatEmptyState');
        if (emptyState) emptyState.hidden = true;
        scrollChatToBottom(user);
        return content;
    }

    let activeChatAbortController = null;
    let activeChatRequestId = null;
    let activeStreamFinalizeFn = null;
    let typingStatusTimer = null;
    let typingPhaseTimeouts = [];

    function clearTypingTimers() {
        if (typingStatusTimer) {
            clearInterval(typingStatusTimer);
            typingStatusTimer = null;
        }
        if (Array.isArray(typingPhaseTimeouts)) {
            typingPhaseTimeouts.forEach(t => clearTimeout(t));
            typingPhaseTimeouts = [];
        }
    }

    function abortInFlightChatRequest() {
        if (typeof activeStreamFinalizeFn === 'function') {
            try { activeStreamFinalizeFn(); } catch {}
            activeStreamFinalizeFn = null;
        }
        if (activeChatAbortController) {
            try {
                activeChatAbortController.abort();
            } catch {}
            activeChatAbortController = null;
        }
        activeChatRequestId = null;
        removeTyping();
        sending = false;
        if (sendButton) {
            sendButton.disabled = false;
            sendButton.classList.remove('chat-stop-btn');
            sendButton.setAttribute('aria-label', 'Send message');
            sendButton.title = 'Send message';
            sendButton.innerHTML = '<i class="fas fa-paper-plane" aria-hidden="true"></i>';
        }
        if (input) input.disabled = false;
        if (attachButton) attachButton.disabled = false;
    }
    window.abortChatRequest = abortInFlightChatRequest;

    function showTyping() {
        if (!messages) return;
        removeTyping();

        const typing = document.createElement('div');
        typing.className = 'message bot live-typing-msg';
        typing.id = 'typingMsg';
        typing.setAttribute('role', 'status');
        typing.setAttribute('aria-live', 'polite');
        const isSearchingWeb = Boolean(webSearchEnabled && isWebSearchAllowed());
        const liveStates = isSearchingWeb
            ? [
                { text: 'Searching the web...', icon: 'fa-globe' },
                { text: 'Synthesizing live results...', icon: 'fa-wand-magic-sparkles' }
            ]
            : [
                { text: 'Thinking...', icon: 'fa-brain' },
                { text: 'Generating response...', icon: 'fa-wand-magic-sparkles' }
            ];

        typing.innerHTML = `
            <div class="msg-avatar"><i class="fas fa-wand-magic-sparkles"></i></div>
            <div class="msg-content live-status-bubble">
                <div class="live-status-indicator">
                    <div class="live-status-icon-wrap"><i class="fas ${liveStates[0].icon}" id="liveChatIcon"></i></div>
                    <span class="live-status-text" id="liveChatStatusText">${liveStates[0].text}</span>
                    <div class="live-status-dots" aria-hidden="true">
                        <span class="live-dot"></span>
                        <span class="live-dot"></span>
                        <span class="live-dot"></span>
                    </div>
                </div>
            </div>
        `;
        messages.appendChild(typing);
        scrollChatToBottom(false);

        clearTypingTimers();

        function setPhase(idx) {
            const textEl = document.getElementById('liveChatStatusText');
            const iconEl = document.getElementById('liveChatIcon');
            if (textEl && iconEl && liveStates[idx]) {
                textEl.classList.add('fade-out');
                setTimeout(() => {
                    textEl.textContent = liveStates[idx].text;
                    iconEl.className = `fas ${liveStates[idx].icon}`;
                    textEl.classList.remove('fade-out');
                    textEl.classList.add('fade-in');
                }, 140);
            }
        }

        // Phase 1 is immediately visible: "Thinking..."
        // Phase 2: Transition smoothly to "Generating response..." before first token arrives
        const t1 = setTimeout(() => {
            setPhase(1);
        }, 1200);
        typingPhaseTimeouts.push(t1);
    }

    function removeTyping() {
        clearTypingTimers();
        const typingEl = messages?.querySelector('#typingMsg');
        if (typingEl) {
            typingEl.remove();
        }
        const allTyping = messages?.querySelectorAll('.live-typing-msg, #typingMsg');
        allTyping?.forEach(el => el.remove());
    }
    window.removeChatTyping = removeTyping;

    function createRequestId() {
        if (crypto.randomUUID) return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    async function getSession() {
        if (!window.JEVEXA_SUPABASE_READY) {
            throw new Error('Account and AI chat features are temporarily unavailable. Please try again later.');
        }
        const { data, error } = typeof window.JEVEXA_GET_SESSION === 'function'
            ? await window.JEVEXA_GET_SESSION({ timeoutMs: 4000, maxRetries: 2 })
            : await supabaseClient.auth.getSession();
        if (error) throw new Error('Could not verify your sign-in. Please sign in again.');
        if (!data?.session?.access_token) return null;
        return data.session;
    }

    function pendingRequestKey(userId) {
        return `jevexa_${userId}_pending_credit_request`;
    }

    function rememberPendingRequest(session, requestId) {
        ambiguousRequestId = requestId;
        try {
            localStorage.setItem(pendingRequestKey(session.user.id), requestId);
            localStorage.setItem(pendingRequestKey(session.user.id) + '_time', String(Date.now()));
        } catch (error) {
            console.warn('Could not persist pending credit request to storage:', error);
        }
    }

    function forgetPendingRequest(session) {
        ambiguousRequestId = null;
        try {
            const uid = session?.user?.id || historyUserId || activeAuthUserId;
            if (uid) {
                localStorage.removeItem(pendingRequestKey(uid));
                localStorage.removeItem(pendingRequestKey(uid) + '_time');
            }
        } catch (error) {
            console.error('Could not clear pending credit request:', error);
        }
    }

    async function reconcilePendingRequest(session) {
        let requestId = ambiguousRequestId;
        let storedTimestamp = 0;
        try {
            requestId ||= localStorage.getItem(pendingRequestKey(session.user.id));
            const savedTime = localStorage.getItem(pendingRequestKey(session.user.id) + '_time');
            if (savedTime) storedTimestamp = Number(savedTime) || 0;
        } catch (error) {
            console.error('Could not read pending credit request:', error);
        }
        if (!requestId) return false;

        ambiguousRequestId = requestId;
        let data = null;
        try {
            const res = await supabaseClient
                .from('credit_reservations')
                .select('status,reserved_credits,charged_credits,created_at')
                .eq('user_id', session.user.id)
                .eq('request_id', requestId)
                .maybeSingle();
            if (res.error) throw res.error;
            data = res.data;
        } catch (error) {
            console.warn('Reconciliation status check query error:', error);
            if (storedTimestamp && (Date.now() - storedTimestamp > 30000)) {
                forgetPendingRequest(session);
                setStatus('Stale credit hold expired. AI chat is ready.');
                return false;
            }
            return false;
        }

        if (!data) {
            forgetPendingRequest(session);
            setStatus('No credit reservation was recorded for the previous request. It is safe to retry.');
            await refreshDisplayedCredits();
            return false;
        }

        if (data.status === 'settled' || data.status === 'released') {
            const statusText = data.status === 'settled'
                ? `settled for ${data.charged_credits} credits`
                : 'released; its reserved credits were returned';
            forgetPendingRequest(session);
            setStatus(`Previous request ${statusText}. Your wallet and history have been refreshed.`);
            await refreshDisplayedCredits();
            return false;
        }

        if (data.status === 'reserved') {
            const reservationTime = data.created_at ? new Date(data.created_at).getTime() : (storedTimestamp || Date.now());
            const ageMs = Date.now() - reservationTime;

            // Auto-reconciliation: stale holds older than 15 seconds are released safely
            if (ageMs > 15000) {
                try {
                    const reconcileRes = await requestJson('/api/credits/reconcile', session, {
                        method: 'POST',
                        body: JSON.stringify({ requestId })
                    });
                    if (reconcileRes?.released) {
                        forgetPendingRequest(session);
                        await refreshDisplayedCredits();
                        setStatus(`Stale request ${requestId} was auto-reconciled (${data.reserved_credits} credits released). Chat is ready.`);
                        return false;
                    }
                } catch (recError) {
                    console.warn('Auto-reconciliation network attempt:', recError);
                }

                if (ageMs > 30000) {
                    forgetPendingRequest(session);
                    await refreshDisplayedCredits();
                    setStatus('Stale reservation hold expired and was safely cleared. You can now chat.');
                    return false;
                }
            }

            // Immediately auto-reconcile or release so user is never trapped in a deadlocked state
            try {
                const recRes = await requestJson('/api/credits/reconcile', session, {
                    method: 'POST',
                    body: JSON.stringify({ requestId })
                });
                if (recRes?.released) {
                    forgetPendingRequest(session);
                    await refreshDisplayedCredits();
                    setStatus(`Pending hold on request ${requestId} was auto-reconciled (${data.reserved_credits} credits released). Ready to chat.`);
                    return false;
                }
            } catch (err) {
                console.warn('Immediate reconciliation notice:', err);
            }

            forgetPendingRequest(session);
            await refreshDisplayedCredits();
            setStatus('Previous request status checked. AI chat is ready.');
            return false;
        }

        forgetPendingRequest(session);
        return false;
    }

    async function requestJson(url, session, options = {}, retries = 1) {
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 35000);
            if (options.signal) {
                if (options.signal.aborted) {
                    clearTimeout(timeoutId);
                    controller.abort();
                } else {
                    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
                }
            }
            try {
                const response = await fetch(url, {
                    ...options,
                    signal: controller.signal,
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
                        ...(options.headers || {})
                    }
                });
                clearTimeout(timeoutId);
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    const error = new Error(payload.error || 'The request could not be completed.');
                    error.status = response.status;
                    error.payload = payload;
                    if (response.status >= 400 && response.status < 500) {
                        throw error;
                    }
                    if (attempt < retries) {
                        await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
                        continue;
                    }
                    throw error;
                }
                return payload;
            } catch (err) {
                clearTimeout(timeoutId);
                lastError = err;
                if (err?.name === 'AbortError' || (err?.status && err.status < 500)) {
                    throw err;
                }
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
                    continue;
                }
                throw err;
            }
        }
        throw lastError;
    }

    function generateChatbotGuestReply(queryText) {
        const raw = String(queryText || '').trim();
        const q = raw.toLowerCase();
        const activeTier = tierSelect?.value || 'lite';
        const modelNames = { lite: 'Jevexa Lite', pro: 'Jevexa Pro', max: 'Jevexa Max', ultra: 'Jevexa Ultra' };
        const activeModelName = modelNames[activeTier] || 'Jevexa Lite';
        if (/[\u0600-\u06FF]/.test(raw)) {
            const isUrdu = /[\u0679\u0688\u0691\u06BA\u06C1\u06BE\u06CC\u06D2\u06AF\u0686\u067E\u06A9]/.test(raw);
            return isUrdu
                ? `میں اس وقت ${activeModelName} کے طور پر کام کر رہا ہوں۔ مکمل AI چیٹ استعمال کرنے اور 100 مفت کریڈٹس حاصل کرنے کے لیے براہِ کرم سائن ان کریں۔`
                : `أنا أعمل الآن بنموذج ${activeModelName}. يُرجى تسجيل الدخول لفتح المحادثة الكاملة والحصول على 100 رصيد مجاني.`;
        }
        if (/[\u0900-\u097F]/.test(raw)) {
            return `मैं अभी ${activeModelName} पर चल रहा हूँ। पूरा AI चैट इस्तेमाल करने और 100 मुफ्त क्रेडिट पाने के लिए कृपया साइन इन करें।`;
        }
        if (/\b(?:kya|kaise|kese|hai|hain|hoon|mujhe|batao|samjhao|karo|kardo|kar\s+do|shukriya|salam|bhai|yaar)\b/i.test(q)) {
            return `Main abhi ${activeModelName} par kaam kar raha hoon. Poora AI chat aur 100 free welcome credits istemal karne ke liye barah-e-karam sign in karein.`;
        }
        if (/which model|what model|model are you|model is working|active model|current model|who is running/i.test(q)) {
            return `I am currently operating as **${activeModelName}** in JEVEXA AI Studio. My reasoning depth and responses are powered by active ${activeModelName} configuration with transparent token-weighted credit accounting.`;
        }
        if (/^(hi|hello|hey|greetings|howdy|salam|aoa)\b/i.test(q)) {
            return `Hello! I am ${activeModelName}, your intelligent automation assistant. Ready to help you draft content, brainstorm marketing strategies, explain our AI tools, or automate business workflows. What would you like to work on today?`;
        }
        if (/who are you|what can you do|what is jevexa/i.test(q)) {
            return `I am ${activeModelName}, the core assistant for JEVEXA AI Studio. I help teams automate operations, draft high-performing marketing & business copy, analyze documents (PDF & ZIP on Paid plans), and streamline workflows with dedicated AI tools.`;
        }
        if (/blog|write a blog/i.test(q)) {
            return "Here is a high-converting blog outline you can use right away:\n\n1. **Hook:** State the industry challenge and why previous solutions fall short.\n2. **The Core Shift:** Introduce AI-driven automation as the competitive edge.\n3. **Practical Framework:** Step-by-step implementation guide with tangible metrics.\n4. **Call to Action:** Direct readers to test the workflow.\n\n*Tip:* Our live **Content Generation** tool drafts complete articles with customizable tone and length! Sign in to get 100 free credits to generate yours.";
        }
        if (/draft an email|email/i.test(q)) {
            return "Here is a professional outreach email template:\n\n**Subject:** Streamlining your AI workflow at [Company Name]\n\nHi [First Name],\n\nI noticed your team is scaling operations and thought you might be interested in automating repetitive content and customer queries.\n\nAt JEVEXA, our AI tools help teams save 15+ hours weekly with intelligent chat, automated drafting, and workflow integrations. Would you be open to a quick 5-minute look this week?\n\nBest regards,\n[Your Name]\n\n*Tip:* You can generate personalized email sequences using our Content Generation tool with your 100 free credits!";
        }
        if (/credit|token|balance|cost|quota/i.test(q)) {
            return "JEVEXA credits power all 10 live studio tools with transparent unit economics:\n• **100 Free Welcome Credits:** Included immediately upon sign-up.\n• **Token-Weighted Chat:** Usage scales cleanly across Fast / Core Engine (1.0x), Pro Engine (3.0x), and Deep Reasoning Engine (18.0x) + attachment surcharges.\n• **Real-Time Web Search:** +5 credits per grounded search request (Pro 15/day, Max 50/day, Ultra 150/day).\n• **Credit Packages:** One-time purchases with an automatic **20% annual discount** and a 7-day refund policy!";
        }
        if (/price|pricing|plan|ultra|pro|lite|max|annual|discount/i.test(q)) {
            return "JEVEXA offers 5 transparent tiers with an automatic 20% annual package discount:\n• **Free ($0):** 100 welcome credits, Fast / Core Engine (1.0x), thinking OFF\n• **Lite:** $5/mo ($4/mo annual, $48/yr) — 2,500 monthly credits, Pro Engine (3.0x), PDF + ZIP unlocked\n• **Pro:** $15/mo ($12/mo annual, $144/yr) — 10,000 monthly credits, Low/Medium thinking, Web Search (15/day, +5 cr/req)\n• **Max:** $29/mo ($23.20/mo annual, $278.40/yr) — 22,000 monthly credits, Deep Reasoning Engine (18.0x), High thinking & priority queues, Web Search (50/day)\n• **Ultra:** $49/mo ($39.20/mo annual, $470.40/yr) — 40,000 monthly credits, Maximum Deep Reasoning & priority compute, Max thinking depth, Web Search (150/day).\nAll annual packages are discounted by 20% and paid once!";
        }
        if (/tool|feature|capabilities|model|ocr|crm/i.test(q)) {
            return "All 10 JEVEXA AI Studio tools are live today: AI Chat, Content Generation, Email & Outreach AI, Mini CRM, Document AI & OCR, Social Media Assistant, Business Analytics, Team Admin, Workflow Automation, and Data Management. Sign in to test all 10 tools with 100 free credits!";
        }
        return "I can help with that! As your JEVEXA AI Assistant, I can draft comprehensive responses, analyze technical topics, explore business automation strategies, or guide you through our studio tools. Let me know what specific focus or format you prefer!";
    }
    // generateChatbotGuestReply(displayText) reference for offline/fallback compatibility

    async function streamChatRequest(url, session, bodyObj, { signal, requestId, onStatus, onToken } = {}) {
        const controller = new AbortController();
        let idleTimer = null;
        const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => controller.abort(), 35000);
        };
        const onExternalAbort = () => controller.abort();
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', onExternalAbort, { once: true });
        }
        resetIdle();

        try {
            let response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream, application/json',
                        'Idempotency-Key': requestId,
                        Authorization: session?.access_token ? `Bearer ${session.access_token}` : ''
                    },
                    body: JSON.stringify({ ...bodyObj, requestId, stream: true })
                });
            } catch (netErr) {
                if (netErr?.name === 'AbortError' || signal?.aborted || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
                    throw netErr;
                }
                await new Promise(r => setTimeout(r, 350));
                resetIdle();
                response = await fetch(url, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream, application/json',
                        'Idempotency-Key': requestId,
                        Authorization: session?.access_token ? `Bearer ${session.access_token}` : ''
                    },
                    body: JSON.stringify({ ...bodyObj, requestId, stream: true })
                });
            }
            resetIdle();

            const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                const error = new Error(payload.error || 'The request could not be completed.');
                error.status = response.status;
                error.payload = payload;
                throw error;
            }

            if (contentType.includes('text/event-stream') && response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let currentEvent = 'message';
                let finalResult = null;
                let streamErrorPayload = null;

                const dispatchEvent = (evtName, rawData) => {
                    if (!rawData) return;
                    let parsedData;
                    try { parsedData = JSON.parse(rawData); } catch { return; }
                    if (evtName === 'status') {
                        onStatus?.(parsedData);
                    } else if (evtName === 'token') {
                        if (typeof parsedData.text === 'string' && parsedData.text.length > 0) {
                            onToken?.(parsedData.text);
                        }
                    } else if (evtName === 'done') {
                        finalResult = parsedData;
                    } else if (evtName === 'error') {
                        streamErrorPayload = parsedData;
                    }
                };

                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) {
                            buffer += decoder.decode();
                            if (buffer.trim()) {
                                buffer += '\n';
                            }
                        } else {
                            resetIdle();
                            buffer += decoder.decode(value, { stream: true });
                        }
                        let nlIdx;
                        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
                            const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
                            buffer = buffer.slice(nlIdx + 1);
                            if (line === '') {
                                currentEvent = 'message';
                            } else if (line.startsWith('event:')) {
                                currentEvent = line.slice(6).trim() || 'message';
                            } else if (line.startsWith('data:')) {
                                dispatchEvent(currentEvent, line.slice(5).trim());
                            }
                        }
                        if (done) break;
                    }
                } finally {
                    reader.releaseLock();
                }

                if (streamErrorPayload) {
                    const err = new Error(streamErrorPayload.error || 'Streaming error occurred.');
                    err.status = Number.isInteger(streamErrorPayload.status) ? streamErrorPayload.status : 502;
                    err.payload = streamErrorPayload;
                    throw err;
                }
                if (finalResult) {
                    return finalResult;
                }
                throw new Error('Stream ended before completion.');
            }

            const jsonPayload = await response.json().catch(() => ({}));
            if (jsonPayload?.reply) {
                onToken?.(String(jsonPayload.reply));
            }
            return jsonPayload;
        } finally {
            if (idleTimer) clearTimeout(idleTimer);
            if (signal) signal.removeEventListener('abort', onExternalAbort);
        }
    }

    async function handleSend() {
        if (sending) {
            abortInFlightChatRequest();
        }
        const text = input?.value.trim();
        if (!text && pendingAttachments.length === 0) return;

        if (!getChatbotOnlineState() || (typeof navigator !== 'undefined' && !navigator.onLine)) {
            setStatus('You are currently offline. Please check your internet connection before sending.', true);
            if (typeof window.showToast === 'function') {
                window.showToast('⚠️ You are currently offline. Please reconnect to send messages.');
            }
            window.JEVEXA_CONNECTIVITY?.checkNow?.({ notifyToast: false });
            return;
        }

        // Strict Login Wall: Intercept unauthenticated guest immediately BEFORE sending
        let session = null;
        try {
            session = await getSession();
        } catch {
            session = null;
        }

        if (!session) {
            if (typeof window.storePendingServiceIntent === 'function') {
                window.storePendingServiceIntent('chatbot');
            }
            if (typeof window.showToast === 'function') {
                window.showToast('Please create an account or sign in to use Jevexa AI Chatbot.');
            }
            setStatus('Please sign in or create an account to use the AI Chatbot.', true);
            if (typeof window.openAuthModal === 'function') {
                window.openAuthModal('signup');
            } else if (typeof window.openLogin === 'function') {
                window.openLogin();
            }
            return;
        }

        const attachments = pendingAttachments.map(item => ({ ...item }));
        const displayText = text || `Attached: ${attachments.map(item => item.name).join(', ')}`;
        const selectedTier = tierSelect?.value || 'lite';
        const isPaid = isPaidPlanActive();

        // Gate non-image attachments BEFORE mutating conversation or clearing composer
        if (!isPaid && attachments.some(item => !item.type.startsWith('image/'))) {
            setStatus('PDF and ZIP uploads require a Paid plan. Upgrade to unlock document and archive files.', true);
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL('Lite', 'PDF & ZIP file uploads', attachButton);
            }
            return;
        }

        // Reconcile any interrupted request BEFORE mutating conversation state
        try {
            if (await reconcilePendingRequest(session)) {
                return;
            }
        } catch (_) {}

        // Guarantee active session and user ID
        historyUserId = session.user.id;
        activeAuthUserId = session.user.id;
        if (!activeChatId) {
            activeChatId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            chatSessions.unshift({
                id: activeChatId,
                title: (text || 'New chat').slice(0, 48),
                updatedAt: Date.now(),
                pinned: false,
                messages: []
            });
            try {
                localStorage.setItem(activeChatKey(historyUserId), activeChatId);
            } catch (_) {}
        }

        // Setup unique AbortController and RequestId for this exact send
        abortInFlightChatRequest();
        const currentAbortController = new AbortController();
        activeChatAbortController = currentAbortController;
        const requestId = createRequestId();
        activeChatRequestId = requestId;
        userScrolledUpDuringStream = false;

        sending = true;
        if (sendButton) {
            sendButton.disabled = false;
            sendButton.classList.add('chat-stop-btn');
            sendButton.setAttribute('aria-label', 'Stop generation');
            sendButton.title = 'Stop generation';
            sendButton.innerHTML = '<i class="fas fa-square" aria-hidden="true"></i>';
        }
        if (input) input.disabled = true;
        if (attachButton) attachButton.disabled = true;

        // Optimistically record user prompt in conversation and render user bubble immediately
        conversation.push({ role: 'user', text: displayText });
        trimConversationToMax(100);
        const userMsgIndex = conversation.length - 1;
        appendMessage(displayText, true, userMsgIndex);
        if (input) {
            input.value = '';
            input.style.height = 'auto';
        }
        pendingAttachments.length = 0;
        renderAttachments();

        // Update active session metadata and recent chats list
        const activeSess = chatSessions.find(item => item.id === activeChatId);
        if (activeSess) {
            activeSess.messages = conversation.slice(-100);
            activeSess.updatedAt = Date.now();
            if (!activeSess.title || activeSess.title === 'New chat') {
                activeSess.title = (text || 'New chat').slice(0, 48);
            }
            saveChatSessions();
        }
        renderChatHistory();

        showTyping();
        setStatus('Checking sign-in, tier access, and credit cost…');
        const prevCreditsBeforeSend = getCachedRemainingCredits();

        try {
            const planLimits = getUserPlanMemoryLimits();
            const historyForApi = conversation.slice(0, -1).slice(-planLimits.maxHistoryMessages);
            const effectiveWebSearch = isWebSearchAllowed() && Boolean(webSearchEnabled);
            const chatPayload = {
                message: text,
                tier: selectedTier,
                thinkingLevel: thinkingSelect?.value || 'off',
                webSearch: effectiveWebSearch,
                attachments,
                history: historyForApi,
                customSettings: getActiveCustomSettings(),
                memories: getActiveMemoriesList()
            };

            const tierMultipliers = { lite: 1.0, pro: 3.0, max: 18.0, ultra: 18.0 };
            const multiplier = tierMultipliers[selectedTier] || 1.0;
            let attachmentSurcharge = effectiveWebSearch ? 5 : 0;
            for (const att of attachments) {
                const t = (att?.type || '').toLowerCase();
                if (t.startsWith('image/')) attachmentSurcharge += 2;
                else if (t === 'application/pdf') attachmentSurcharge += 4;
                else if (t.includes('zip')) attachmentSurcharge += 5;
            }
            const estInputTokens = Math.max(1, Math.ceil((text.length + 50) / 4));
            const estOutputTokens = selectedTier === 'ultra' ? 800 : selectedTier === 'max' ? 600 : selectedTier === 'pro' ? 400 : 250;
            const calculatedEstCredits = Math.max(1, Math.ceil(((estInputTokens + estOutputTokens) / 500) * multiplier)) + attachmentSurcharge;

            let quote = null;
            try {
                const quotePayload = {
                    ...chatPayload,
                    attachments: attachments.map(({ name, type, size }) => ({ name, type, size, quoteOnly: true }))
                };
                quote = await Promise.race([
                    requestJson('/api/credits/quote', session, {
                        method: 'POST',
                        signal: currentAbortController.signal,
                        body: JSON.stringify(quotePayload)
                    }),
                    new Promise(resolve => setTimeout(resolve, 600))
                ]);
            } catch (quoteErr) {
                console.warn('Credit quote lookup notice:', quoteErr?.message || quoteErr);
            }

            const estimatedCredits = quote?.estimatedCredits || calculatedEstCredits;

            let wallet = null;
            const countEl = document.getElementById('creditsCount');
            const cachedBalance = countEl ? parseInt(countEl.textContent, 10) : NaN;
            if (!isNaN(cachedBalance)) {
                wallet = { balance: cachedBalance };
            } else {
                try {
                    const walletRes = await Promise.race([
                        supabaseClient
                            .from('user_credits')
                            .select('balance')
                            .eq('user_id', session.user.id)
                            .maybeSingle(),
                        new Promise(resolve => setTimeout(() => resolve({ data: null }), 600))
                    ]);
                    wallet = walletRes?.data;
                } catch (wErr) {
                    console.warn('Wallet balance check notice:', wErr?.message || wErr);
                }
            }

            if (wallet && Number(wallet.balance) < estimatedCredits) {
                removeTyping();
                const requiredPlanName = selectedTier === 'lite' ? 'Lite' : selectedTier === 'pro' ? 'Pro' : selectedTier === 'max' ? 'Max' : 'Ultra';
                const warningMsg = `Not enough credits for this ${selectedTier.toUpperCase()} message. It costs ~${estimatedCredits} credits; your balance is ${wallet.balance}. [View Upgrade Plans](/pricing) to top up.`;
                setStatus(`This ${selectedTier.toUpperCase()} message costs ~${estimatedCredits} token-weighted credits; your available balance is ${wallet.balance}. Choose a plan to continue.`, true);
                conversation.push({ role: 'assistant', text: warningMsg });
                trimConversationToMax(100);
                appendMessage(warningMsg, false, conversation.length - 1);
                persistConversation(session.user.id);
                if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                    window.JEVEXA_SHOW_UPGRADE_MODAL(requiredPlanName, 'additional AI credits');
                }
                return;
            }

            setStatus(formatMinimalStatus({ tier: selectedTier, webSearch: webSearchEnabled }));

            let streamedText = '';
            let streamBubble = null;
            let rafId = null;
            let streamFinalized = false;

            const flushStreamRender = (isFinal = false) => {
                if (!streamBubble) return;
                streamBubble.body.innerHTML = renderMarkdown(streamedText, { streaming: !isFinal });
                if (!userScrolledUpDuringStream) {
                    scrollChatToBottom(false);
                }
            };

            const scheduleStreamRender = () => {
                if (rafId !== null) return;
                rafId = requestAnimationFrame(() => {
                    rafId = null;
                    flushStreamRender(false);
                });
            };

            activeStreamFinalizeFn = () => {
                if (rafId !== null) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
                if (streamBubble && !streamFinalized) {
                    streamFinalized = true;
                    streamBubble.row.classList.remove('is-streaming');
                    const partial = streamedText.trim();
                    if (partial) {
                        streamBubble.body.innerHTML = renderMarkdown(partial, { streaming: false });
                        conversation.push({ role: 'assistant', text: partial });
                        trimConversationToMax(100);
                        streamBubble.row.dataset.messageIndex = String(conversation.length - 1);
                        (streamBubble.col || streamBubble.content).appendChild(buildBotActionButtons());
                        persistConversation(session.user.id);
                    } else {
                        streamBubble.row.remove();
                    }
                }
            };

            try {
                const result = await streamChatRequest('/api/chat', session, chatPayload, {
                    signal: currentAbortController.signal,
                    requestId,
                    onStatus: (statusEvt) => {
                        if (statusEvt?.phase === 'thinking') {
                            const statusEl = document.getElementById('liveChatStatusText');
                            if (statusEl) statusEl.textContent = 'Thinking...';
                        }
                    },
                    onToken: (delta) => {
                        if (currentAbortController.signal.aborted) return;
                        if (!streamBubble) {
                            removeTyping();
                            streamBubble = createStreamingMessageRow(conversation.length);
                        }
                        streamedText += delta;
                        scheduleStreamRender();
                    }
                });

                if (rafId !== null) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
                activeStreamFinalizeFn = null;

                if (currentAbortController.signal.aborted || activeChatAbortController !== currentAbortController || (activeChatRequestId && activeChatRequestId !== requestId)) {
                    removeTyping();
                    return;
                }

                removeTyping();
                window.JEVEXA_CONNECTIVITY?.reportSuccess?.();
                const replyText = String(result.reply || streamedText || '').trim();
                const creditUsage = window.JEVEXA_EXTRACT_CREDIT_USAGE?.(result, { fallbackToLiveBalance: false });
                const remaining = creditUsage?.remaining ?? (
                    Number.isInteger(result.remainingCredits)
                        ? result.remainingCredits
                        : (Number.isInteger(result.remaining_credits)
                            ? result.remaining_credits
                            : (Number.isInteger(result.creditsRemaining) ? result.creditsRemaining : getCachedRemainingCredits()))
                );
                let usedCreditsMeta = creditUsage?.used ?? (
                    Number.isInteger(result?.creditsUsed)
                        ? result.creditsUsed
                        : (Number.isInteger(result?.credits_used)
                            ? result.credits_used
                            : (Number.isInteger(result?.creditsCharged)
                                ? result.creditsCharged
                                : (Number.isInteger(result?.charged_credits) ? result.charged_credits : null)))
                );
                if (usedCreditsMeta === null) {
                    if (Number.isInteger(prevCreditsBeforeSend) && Number.isInteger(remaining) && prevCreditsBeforeSend > remaining) {
                        usedCreditsMeta = prevCreditsBeforeSend - remaining;
                    } else if (Number.isFinite(calculatedEstCredits) && calculatedEstCredits > 0) {
                        usedCreditsMeta = calculatedEstCredits;
                    } else {
                        usedCreditsMeta = 1;
                    }
                }
                const resolvedMeta = {
                    ...result,
                    tier: String(result?.tier || selectedTier),
                    creditsUsed: usedCreditsMeta,
                    ...(Number.isInteger(remaining) && remaining >= 0 ? { remainingCredits: remaining } : {})
                };
                const replyMeta = {};
                if (usedCreditsMeta !== null && usedCreditsMeta >= 0) replyMeta.creditsUsed = usedCreditsMeta;
                if (remaining !== null && remaining >= 0) replyMeta.remainingCredits = remaining;
                if (resolvedMeta.tier) replyMeta.tier = resolvedMeta.tier;
                if (result?.modelName || result?.model) replyMeta.modelName = String(result.modelName || result.model);
                if (result?.webSearch) {
                    replyMeta.webSearch = true;
                    replyMeta.webSearchSurcharge = Number(result.webSearchSurcharge) || 5;
                }
                conversation.push({
                    role: 'assistant',
                    text: replyText,
                    ...(Object.keys(replyMeta).length ? { meta: replyMeta } : {})
                });
                trimConversationToMax(100);
                const assistantMsgIndex = conversation.length - 1;

                if (result?.switchedLanguage && activeSess) {
                    activeSess.languageOverride = result.switchedLanguage === 'auto' ? null : result.switchedLanguage;
                }

                let renderedBotContent = null;
                if (streamBubble) {
                    streamFinalized = true;
                    streamBubble.row.classList.remove('is-streaming');
                    streamBubble.row.dataset.messageIndex = String(assistantMsgIndex);
                    streamBubble.body.innerHTML = renderMarkdown(replyText, { streaming: false });
                    applyBotMetaStatus(streamBubble.content, resolvedMeta);
                    renderedBotContent = streamBubble.content;
                    (streamBubble.col || streamBubble.content).appendChild(buildBotActionButtons());
                    if (!userScrolledUpDuringStream) scrollChatToBottom(false);
                } else {
                    renderedBotContent = appendMessage(replyText, false, assistantMsgIndex, resolvedMeta);
                }

                persistConversation(session.user.id);
                updateChatHeaderTitle();
                if (remaining !== null) {
                    const countEl = document.getElementById('creditsCount');
                    if (countEl) countEl.textContent = String(remaining);
                    const settingsBal = document.getElementById('settingsBalance');
                    if (settingsBal) settingsBal.textContent = String(remaining);
                    try {
                        localStorage.setItem('jevexa_persisted_credits', String(remaining));
                    } catch (_) {}
                    window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
                    window.JEVEXA_UPDATE_CREDIT_BALANCE?.(remaining);
                }
                if (usedCreditsMeta !== null && usedCreditsMeta >= 0 && Number.isInteger(remaining) && remaining >= 0) {
                    lastTurnCreditUsage = { used: usedCreditsMeta, remaining };
                }
                setStatus(formatMinimalStatus({
                    tier: selectedTier,
                    webSearch: Boolean(result?.webSearch),
                    used: usedCreditsMeta,
                    remaining: remaining !== null ? remaining : undefined
                }));
                await refreshDisplayedCredits();
                if (remaining === null) {
                    const postRefreshRemaining = getCachedRemainingCredits();
                    if (Number.isInteger(postRefreshRemaining) && postRefreshRemaining >= 0) {
                        resolvedMeta.remainingCredits = postRefreshRemaining;
                        if (conversation[assistantMsgIndex]?.meta) {
                            conversation[assistantMsgIndex].meta.remainingCredits = postRefreshRemaining;
                        }
                        if (renderedBotContent) {
                            applyBotMetaStatus(renderedBotContent, resolvedMeta);
                        }
                        lastTurnCreditUsage = { used: usedCreditsMeta, remaining: postRefreshRemaining };
                        persistConversation(session.user.id);
                        setStatus(formatMinimalStatus({
                            tier: selectedTier,
                            webSearch: Boolean(result?.webSearch),
                            used: usedCreditsMeta,
                            remaining: postRefreshRemaining
                        }));
                    }
                }
            } catch (error) {
                if (rafId !== null) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
                activeStreamFinalizeFn = null;

                if (error?.name === 'AbortError' || currentAbortController.signal.aborted || (activeChatRequestId && activeChatRequestId !== requestId)) {
                    removeTyping();
                    return;
                }
                if (streamBubble && !streamFinalized) {
                    streamFinalized = true;
                    streamBubble.row.classList.remove('is-streaming');
                    streamBubble.row.remove();
                    streamBubble = null;
                }
                removeTyping();
                await refreshDisplayedCredits();
                if (error.payload?.reply) {
                    const replyText = String(error.payload.reply).trim();
                    const replyMeta = {
                        tier: selectedTier,
                        unconfirmedSettlement: true
                    };
                    conversation.push({ role: 'assistant', text: replyText, meta: replyMeta });
                    trimConversationToMax(100);
                    appendMessage(replyText, false, conversation.length - 1, replyMeta);
                    persistConversation(session.user.id);
                    forgetPendingRequest(session);
                    setStatus('AI reply completed. (Credits will reconcile automatically).');
                    await refreshDisplayedCredits();
                    return;
                }
                if (!Number.isInteger(error.status)) {
                    window.JEVEXA_CONNECTIVITY?.reportNetworkFailure?.();
                    rememberPendingRequest(session, requestId);
                    setStatus('Connection interrupted — checking request status…');
                    appendMessage('Connection interrupted. Verifying your request…');
                    try {
                        const stillPending = await reconcilePendingRequest(session);
                        if (!stillPending) {
                            setStatus('Request could not be confirmed. No credits were charged. You can send another message.');
                            if (input && !input.value && displayText) {
                                input.value = displayText;
                            }
                        }
                    } catch {
                        forgetPendingRequest(session);
                        setStatus('Could not verify the interrupted request. You can send another message.');
                        if (input && !input.value && displayText) {
                            input.value = displayText;
                        }
                    }
                } else if (error.status === 402) {
                    setStatus(error.message, true);
                    appendMessage(error.message);
                } else if (error.status === 403 && error.payload?.code === 'tier_required') {
                    setStatus(error.message, true);
                    appendMessage(error.message);
                } else if (error.payload?.requestId && /reservation.*held/i.test(error.message)) {
                    rememberPendingRequest(session, requestId);
                    setStatus('Checking request status…');
                    try {
                        const recRes = await requestJson('/api/credits/reconcile', session, {
                            method: 'POST',
                            body: JSON.stringify({ requestId })
                        });
                        if (recRes?.released) {
                            forgetPendingRequest(session);
                            await refreshDisplayedCredits();
                            setStatus('Held credits were released. You can send another message.');
                            if (input && !input.value && displayText) {
                                input.value = displayText;
                            }
                            return;
                        }
                    } catch (recErr) {
                        console.warn('Auto-reconciliation notice:', recErr);
                    }
                    setStatus('AI is temporarily busy. Any held credits will clear automatically.');
                    appendMessage('The previous request was held for safety and will release automatically. Please try again shortly.');
                    if (input && !input.value && displayText) {
                        input.value = displayText;
                    }
                } else if (error.status === 409 && error.payload?.status === 'reserved') {
                    rememberPendingRequest(session, requestId);
                    const message = `Request ${requestId} is still processing. Do not submit it again.`;
                    setStatus(message);
                    appendMessage(message);
                } else if (error.status === 503) {
                    setStatus(warmingMessage);
                    const isPricingConfigNotice = error.message && /pricing.*not configured|tier pricing|could not be confirmed/i.test(error.message);
                    const cleanMessage = isPricingConfigNotice
                        ? 'AI assistant is temporarily busy. Please try sending your message again.'
                        : (error.message && error.message !== 'Credit service is not configured.' ? error.message : warmingMessage);
                    if (cleanMessage !== warmingMessage) {
                        setStatus(cleanMessage, !isPricingConfigNotice);
                    }
                    appendMessage(cleanMessage);
                    if (input && !input.value && displayText) {
                        input.value = displayText;
                    }
                } else if (error.status === 429) {
                    setStatus('Rate limited. Wait 60 seconds before sending another message.');
                    appendMessage('Rate limited. Wait 60 seconds before sending another message.');
                    if (input && !input.value && displayText) {
                        input.value = displayText;
                    }
                } else {
                    const message = error.message || (error.status >= 500
                        ? 'The AI assistant could not complete that request. Please try again shortly.'
                        : 'An error occurred.');
                    setStatus(message, true);
                    appendMessage(message);
                    if (error.status >= 500 && input && !input.value && displayText) {
                        input.value = displayText;
                    }
                }
            }
        } catch (error) {
            removeTyping();
            const message = error?.message || 'The AI assistant encountered an error. Please try again shortly.';
            setStatus(message, true);
            appendMessage(message);
        } finally {
            activeStreamFinalizeFn = null;
            if (activeChatAbortController === currentAbortController) {
                activeChatAbortController = null;
                activeChatRequestId = null;
            }
            removeTyping();
            sending = false;
            if (sendButton) {
                sendButton.disabled = false;
                sendButton.classList.remove('chat-stop-btn');
                sendButton.setAttribute('aria-label', 'Send message');
                sendButton.title = 'Send message';
                sendButton.innerHTML = '<i class="fas fa-paper-plane" aria-hidden="true"></i>';
            }
            if (input) input.disabled = false;
            if (attachButton) attachButton.disabled = false;
            input?.focus();
        }
    }

    bindSafe(document, 'click', event => {
        const target = event.target instanceof Element ? event.target : null;
        const button = target?.closest('#chatSend, #chatWelcomeChips .chat-welcome-chip');
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (button.id === 'chatSend' && sending) {
            abortInFlightChatRequest();
            setStatus('Generation stopped.');
            input?.focus();
            return;
        }
        if (button.matches('.chat-welcome-chip') && input) input.value = button.textContent.trim();
        handleSend();
    }, {
        matches: event => event.target instanceof Element
            && Boolean(event.target.closest('#chatSend, #chatWelcomeChips .chat-welcome-chip')),
        getKey: event => event.target instanceof Element
            ? event.target.closest('#chatSend, #chatWelcomeChips .chat-welcome-chip') || document
            : document,
        debounceMs: 100,
        listenerOptions: true
    });

    document.addEventListener('keydown', event => {
        if (event.target !== input || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (sending) return;
        handleSend();
    }, true);

    input?.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    });

    async function writeClipboardText(text) {
        if (typeof window.JEVEXA_COPY_TO_CLIPBOARD === 'function') {
            const ok = await window.JEVEXA_COPY_TO_CLIPBOARD(text, { silent: true });
            if (ok) return true;
        }
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (_) {}
        }
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;font-size:16px;';
        document.body.appendChild(ta);
        ta.focus({ preventScroll: true });
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (_) {}
        ta.remove();
        if (!ok) throw new Error('Clipboard unavailable');
        return true;
    }

    async function copyButtonWithFeedback(button, text, statusMsg, copiedHtml = '<i class="fas fa-check" aria-hidden="true"></i><span>Copied!</span>') {
        const originalHtml = button.dataset.origHtml || button.innerHTML;
        button.dataset.origHtml = originalHtml;
        await writeClipboardText(text);
        button.innerHTML = copiedHtml;
        button.classList.add('copied', 'is-copied');
        if (button._copyTimer) clearTimeout(button._copyTimer);
        button._copyTimer = setTimeout(() => {
            button.innerHTML = originalHtml;
            button.classList.remove('copied', 'is-copied');
            button._copyTimer = null;
        }, 2000);
        if (typeof window.showToast === 'function') {
            window.showToast('Copied to clipboard');
        }
        if (statusMsg) setStatus(statusMsg);
    }

    function startInlineUserEdit(row, index) {
        if (!row || !Number.isInteger(index) || index < 0) return;
        const msgContent = row.querySelector('.msg-content');
        const msgBody = row.querySelector('.msg-body');
        const userActions = row.querySelector('.chat-user-actions');
        if (!msgContent || !msgBody) return;
        if (row.querySelector('.chat-user-edit-box')) return;

        const rawText = typeof conversation[index]?.text === 'string'
            ? conversation[index].text
            : (msgBody.textContent || '');

        row.classList.add('is-editing');
        msgBody.hidden = true;
        if (userActions) userActions.hidden = true;

        const editBox = document.createElement('div');
        editBox.className = 'chat-user-edit-box';

        const textarea = document.createElement('textarea');
        textarea.className = 'chat-user-edit-textarea';
        textarea.rows = 2;
        textarea.value = rawText;
        textarea.setAttribute('aria-label', 'Edit your message');

        const controls = document.createElement('div');
        controls.className = 'chat-user-edit-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'chat-user-edit-cancel';
        cancelBtn.textContent = 'Cancel';

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'chat-user-edit-save';
        saveBtn.innerHTML = '<i class="fas fa-paper-plane" aria-hidden="true"></i> <span>Save &amp; Submit</span>';

        const autoSize = () => {
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(260, Math.max(52, textarea.scrollHeight))}px`;
        };

        const cleanupEdit = () => {
            editBox.remove();
            msgBody.hidden = false;
            if (userActions) userActions.hidden = false;
            row.classList.remove('is-editing');
        };

        const commitEdit = () => {
            const editedText = textarea.value.trim();
            if (!editedText) {
                setStatus('Message cannot be empty.', true);
                textarea.focus();
                return;
            }
            cleanupEdit();
            abortInFlightChatRequest();
            conversation.splice(index);
            messages?.querySelectorAll('.message:not([data-chat-welcome])').forEach(message => {
                if (Number(message.dataset.messageIndex) >= index) message.remove();
            });
            persistConversation(historyUserId);
            if (input) input.value = editedText;
            handleSend();
        };

        textarea.addEventListener('input', autoSize);
        textarea.addEventListener('keydown', ev => {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                cleanupEdit();
            } else if (ev.key === 'Enter' && (!ev.shiftKey || ev.ctrlKey || ev.metaKey) && !ev.isComposing) {
                ev.preventDefault();
                ev.stopPropagation();
                commitEdit();
            }
        });
        bindSafe(cancelBtn, 'click', e => {
            e.preventDefault();
            e.stopPropagation();
            cleanupEdit();
        });
        bindSafe(saveBtn, 'click', e => {
            e.preventDefault();
            e.stopPropagation();
            commitEdit();
        });

        controls.append(cancelBtn, saveBtn);
        editBox.append(textarea, controls);
        msgContent.appendChild(editBox);
        autoSize();
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    bindSafe(messages, 'click', async event => {
        const copyCodeBtn = event.target.closest('.chat-code-copy');
        if (copyCodeBtn) {
            const block = copyCodeBtn.closest('.chat-code-block');
            const codeEl = block?.querySelector('code');
            if (codeEl) {
                try {
                    await copyButtonWithFeedback(
                        copyCodeBtn,
                        codeEl.textContent || '',
                        'Code copied to clipboard.',
                        '<i class="fas fa-check" aria-hidden="true"></i> <span>Copied!</span>'
                    );
                } catch {
                    setStatus('Could not copy code on your device.');
                }
            }
            return;
        }
        const button = event.target.closest('[data-chat-action]');
        if (!button) return;
        const row = button.closest('.message');
        const index = Number(row?.dataset.messageIndex);
        const action = button.dataset.chatAction;

        if (action === 'copy-user') {
            const rawPrompt = conversation[index]?.text || row?.querySelector('.msg-body')?.textContent || '';
            try {
                await copyButtonWithFeedback(button, rawPrompt, 'Prompt copied to clipboard.');
            } catch (error) {
                console.error('Could not copy user prompt:', error);
                setStatus('Could not copy this prompt on your device.');
            }
            return;
        }
        if (action === 'edit-user') {
            startInlineUserEdit(row, index);
            return;
        }
        if (action === 'copy') {
            const rawReply = conversation[index]?.text || row?.querySelector('.msg-body, .msg-content p')?.textContent || '';
            try {
                await copyButtonWithFeedback(button, rawReply, 'Response copied.');
            } catch (error) {
                console.error('Could not copy chat response:', error);
                setStatus('Could not copy this response on your device.');
            }
            return;
        }
        if (action === 'regenerate' && Number.isInteger(index) && index > 0) {
            abortInFlightChatRequest();
            const userIndex = index - 1;
            const userMessage = conversation[userIndex];
            if (userMessage?.role !== 'user') return;
            const targetText = userMessage.text;
            conversation.splice(userIndex);
            messages.querySelectorAll('.message:not([data-chat-welcome])').forEach(message => {
                if (Number(message.dataset.messageIndex) >= userIndex) message.remove();
            });
            persistConversation(historyUserId);
            if (input) input.value = targetText;
            handleSend();
        }
    }, {
        getKey: event => event.target instanceof Element
            ? event.target.closest('[data-chat-action], .chat-code-copy') || messages
            : messages
    });

    bindSafe(attachButton, 'click', async () => {
        try {
            fileInput?.click();
        } catch (error) {
            console.error('Attach button error:', error);
        }
    });
    const scrollBottomBtn = document.getElementById('chatScrollBottom');
    if (messages && scrollBottomBtn) {
        messages.addEventListener('scroll', () => {
            const nearBottom = isScrolledNearBottom(120);
            if (!nearBottom && sending) {
                userScrolledUpDuringStream = true;
            } else if (nearBottom) {
                userScrolledUpDuringStream = false;
            }
            updateScrollBottomButton();
        }, { passive: true });

        bindSafe(scrollBottomBtn, 'click', () => {
            userScrolledUpDuringStream = false;
            messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
            scrollBottomBtn.hidden = true;
            scrollBottomBtn.classList.remove('visible');
        });
    }
    function resumeChatSession(force = false) {
        const uid = historyUserId || activeAuthUserId || getPersistedUserId();
        if (uid) {
            loadConversation(uid, force);
            renderChatHistory();
            const statusText = document.getElementById('chatbotStatusText') || document.querySelector('.chatbot-info .status');
            if (statusText && (statusText.textContent.includes('Sign-in') || statusText.textContent === 'Offline')) {
                setChatHeaderConnLabel(statusText, 'AI chat • Online');
            }
            const signInPrompt = document.getElementById('chatSignInPrompt');
            if (signInPrompt) signInPrompt.hidden = true;
        }
    }
    window.JEVEXA_RESUME_CHAT = resumeChatSession;

    // Early synchronous hydration from persisted auth to prevent blank/stale hydration flash
    const earlyPersistedUid = getPersistedUserId();
    if (earlyPersistedUid) {
        try {
            historyUserId = earlyPersistedUid;
            activeAuthUserId = earlyPersistedUid;
            loadConversation(earlyPersistedUid, false);
            const statusText = document.getElementById('chatbotStatusText') || document.querySelector('.chatbot-info .status');
            setChatHeaderConnLabel(statusText, 'AI chat • Online');
            const signInPrompt = document.getElementById('chatSignInPrompt');
            if (signInPrompt) signInPrompt.hidden = true;
        } catch (e) {
            console.warn('Early chat hydration notice:', e);
        }
    }

    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            const chatbotWin = document.getElementById('chatbotWindow');
            if (chatbotWin && chatbotWin.classList.contains('open')) {
                resumeChatSession(false);
            }
        }
    });

    window.addEventListener('storage', event => {
        if (event.key && historyUserId && (event.key.includes(historyUserId) || event.key === 'jevexa_persisted_credits')) {
            const chatbotWin = document.getElementById('chatbotWindow');
            if (chatbotWin && chatbotWin.classList.contains('open')) {
                resumeChatSession(false);
            }
        }
    });

    bindSafe(document.getElementById('chatbotToggle'), 'click', () => {
        updateChatWelcome();
        resumeChatSession(false);
        void initializeChatSession();
    });
    if (typeof supabaseClient !== 'undefined' && supabaseClient?.auth?.onAuthStateChange) {
        supabaseClient.auth.onAuthStateChange((_event, session) => {
            const userId = session?.user?.id || null;
            if (activeAuthUserId && activeAuthUserId !== userId) clearAccountChatState();
            activeAuthUserId = userId;
            const statusText = document.getElementById('chatbotStatusText') || document.querySelector('.chatbot-info .status');
            setChatHeaderConnLabel(statusText, userId ? 'AI chat • Online' : 'AI chat • Sign-in required');
            updateChatWelcome(session?.user || null);
            if (userId) {
                void initializeChatSession();
            } else {
                lockChatTiers();
            }
        });
    }
    if (typeof supabaseClient !== 'undefined' && supabaseClient?.auth?.getSession) {
        void initializeChatSession();
    }
    fileInput?.addEventListener('change', async () => {
        try {
            await addAttachments(Array.from(fileInput.files || []));
        } catch (error) {
            console.error('Could not read chat attachment:', error);
            setStatus(error?.message || 'Could not read the selected attachment.');
        } finally {
            fileInput.value = '';
        }
    });

    const dropTarget = document.getElementById('chatForm') || document.getElementById('chatbotWindow');
    if (dropTarget) {
        ['dragenter', 'dragover'].forEach(eventName => {
            dropTarget.addEventListener(eventName, e => {
                e.preventDefault();
                e.stopPropagation();
                dropTarget.classList.add('is-dragover');
            });
        });
        ['dragleave', 'dragend', 'drop'].forEach(eventName => {
            dropTarget.addEventListener(eventName, e => {
                e.preventDefault();
                e.stopPropagation();
                dropTarget.classList.remove('is-dragover');
            });
        });
        dropTarget.addEventListener('drop', async e => {
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length > 0) {
                await addAttachments(files);
            }
        });
    }

    input?.addEventListener('paste', async e => {
        const files = Array.from(e.clipboardData?.files || []);
        if (files.length > 0) {
            e.preventDefault();
            await addAttachments(files);
        }
    });

    bindSafe(document.getElementById('chatNewConversation'), 'click', () => {
        createChatSession();
    });

    document.getElementById('chatHistorySearch')?.addEventListener('input', renderChatHistory);
    bindSafe(document.getElementById('chatHistorySearchClear'), 'click', () => {
        const searchInput = document.getElementById('chatHistorySearch');
        if (searchInput) searchInput.value = '';
        renderChatHistory();
        searchInput?.focus();
    });
    initChatSidebarDrawer();
    initChatSidebarResizer();
    initChatCustomizationSuite();
    initVirtualViewportTracking();
    loadCustomSettings(null);
    loadMemories(null);
    document.getElementById('chatDensity')?.addEventListener('change', event => {
        document.getElementById('chatbotWindow')?.setAttribute('data-chat-density', event.target.value);
        chatCustomSettings.density = event.target.value;
        saveCustomSettings(historyUserId);
    });
    document.getElementById('chatTier')?.addEventListener('change', () => {
        const tier = tierSelect.value;
        // Defensive: Ensure maximum values are valid before comparison
        const currentMaximumChatTier = typeof maximumChatTier === 'string' && maximumChatTier.length > 0 ? maximumChatTier : 'lite';
        if (tierOrder.indexOf(tier) > tierOrder.indexOf(currentMaximumChatTier)) {
            tierSelect.value = currentTier;
            updateSelectorDisplay('tier');
            const requiredPlan = ({ pro: 'Lite', max: 'Max', ultra: 'Ultra' })[tier] || 'Lite';
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL(requiredPlan, 'this model tier');
            } else if (typeof window.showToast === 'function') {
                window.showToast(`Upgrade to ${requiredPlan} Plan to unlock this model tier.`);
            } else {
                setStatus(`Upgrade to ${requiredPlan} Plan to unlock this model tier.`);
            }
            return;
        }
        currentTier = tier;
        updateSelectorDisplay('tier');
        setStatus(formatMinimalStatus({ tier, webSearch: webSearchEnabled }));
        const statusText = document.getElementById('chatbotStatusText') || document.querySelector('.chatbot-info .status');
        if (statusText && activeAuthUserId) setChatHeaderConnLabel(statusText, 'AI chat • Online');
    });
    document.getElementById('chatThinking')?.addEventListener('change', () => {
        const selected = thinkingSelect.value;
        // Defensive: Ensure maximum values are valid before comparison
        const currentMaximumThinkingLevel = typeof maximumThinkingLevel === 'string' && maximumThinkingLevel.length > 0 ? maximumThinkingLevel : 'off';
        if (thinkingOrder.indexOf(selected) > thinkingOrder.indexOf(currentMaximumThinkingLevel)) {
            thinkingSelect.value = currentThinkingLevel;
            updateSelectorDisplay('thinking');
            const requiredPlan = selected === 'max' ? 'Max' : 'Pro';
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL(requiredPlan, 'advanced thinking');
            } else if (typeof window.showToast === 'function') {
                window.showToast(`Upgrade to ${requiredPlan} Plan to unlock this feature.`);
            } else {
                setStatus(`Upgrade to ${requiredPlan} Plan to unlock this feature.`);
            }
            return;
        }
        currentThinkingLevel = selected;
        updateSelectorDisplay('thinking');
    });
    function handleWebSearchButtonActivation(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        closeOtherSelectors();
        const btn = document.getElementById('chatWebSearchBtn');
        if (!isWebSearchAllowed()) {
            webSearchEnabled = false;
            syncWebSearchUI();
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'Live Web Search', btn);
            } else {
                setStatus('Live Web Search requires Pro ($15/mo), Max ($29/mo), or Ultra ($49/mo).', true);
                window.showToast?.('Live Web Search requires Pro, Max, or Ultra. Visit /pricing to upgrade.');
            }
            return;
        }
        webSearchEnabled = !webSearchEnabled;
        const uid = historyUserId || activeAuthUserId;
        saveWebSearchPref(uid, webSearchEnabled);
        if (activeChatId) {
            const activeSess = chatSessions.find(item => item.id === activeChatId);
            if (activeSess) {
                activeSess.webSearch = webSearchEnabled;
                saveChatSessions();
            }
        }
        syncWebSearchUI();
        setStatus(formatMinimalStatus({ tier: currentTier, webSearch: webSearchEnabled }));
    }

    const tierControlsContainer = document.querySelector('.chat-tier-controls');
    if (tierControlsContainer) {
        bindSafe(tierControlsContainer, 'click', event => {
            const btn = event.target instanceof Element ? event.target.closest('#chatWebSearchBtn') : null;
            if (!btn) return;
            handleWebSearchButtonActivation(event);
        }, {
            matches: event => event.target instanceof Element && Boolean(event.target.closest('#chatWebSearchBtn')),
            getKey: () => document.getElementById('chatWebSearchBtn') || tierControlsContainer,
            preventDefaultOnDebounce: false,
            debounceMs: 50
        });
    } else {
        bindSafe(document.getElementById('chatWebSearchBtn'), 'click', handleWebSearchButtonActivation, {
            getKey: () => document.getElementById('chatWebSearchBtn'),
            preventDefaultOnDebounce: false,
            debounceMs: 50
        });
    }
    syncWebSearchUI();
    document.getElementById('chatTheme')?.addEventListener('change', event => {
        const themeVal = event.target.value || 'dark';
        chatCustomSettings.theme = themeVal;
        const modalThemeEl = document.getElementById('chatModalThemeSelect');
        if (modalThemeEl) modalThemeEl.value = themeVal;
        document.getElementById('chatbotWindow')?.setAttribute('data-chat-theme', themeVal);
        saveCustomSettings(historyUserId);
        if (historyUserId) {
            try {
                localStorage.setItem(`jevexa_${historyUserId}_chat_theme`, themeVal);
            } catch (error) {
                console.warn('Could not save chat theme:', error);
            }
        }
    });
    document.getElementById('chatReducedMotion')?.addEventListener('change', event => {
        document.documentElement.classList.toggle('jevexa-reduce-motion', event.target.checked);
        window.dispatchEvent(new Event('jevexa-motion-change'));
        if (historyUserId) {
            try {
                localStorage.setItem(`jevexa_${historyUserId}_chat_reduced_motion`, String(event.target.checked));
            } catch (error) {
                console.warn('Could not save reduced-motion preference:', error);
            }
        }
    });
    bindSafe(document.getElementById('chatClearAll') || document.getElementById('chatSettingsClearAllBtn'), 'click', () => {
        clearAllConversations();
    });

    bindSafe(document.getElementById('chatbotWindow'), 'click', event => {
        if (event.target === document.getElementById('chatbotWindow')) {
            document.getElementById('chatSidebar')?.classList.remove('open');
            document.getElementById('chatbotWindow')?.classList.remove('chat-history-open');
        }
    }, {
        matches: event => event.target === document.getElementById('chatbotWindow'),
        getKey: () => document.getElementById('chatbotWindow')
    });

    if (upgradeLink) {
        bindSafe(upgradeLink, 'click', (event) => {
            event.preventDefault();
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'AI Chat Credits', upgradeLink);
            } else if (typeof window.JEVEXA_SCROLL_TO_PRICING === 'function') {
                window.JEVEXA_SCROLL_TO_PRICING('pro');
            } else {
                window.JEVEXA_CLOSE_ALL_WORKSPACES?.();
                const pricingSection = document.getElementById('pricing');
                if (pricingSection) pricingSection.scrollIntoView({ behavior: 'smooth' });
            }
        });
    }

    function appendServicePricing(services) {
        const content = document.getElementById('settingsContent');
        if (!content || content.querySelector('#creditServicePricing')) return;
        const legacyRetiredKeys = new Set([
            'document_ai',
            'social_media',
            'analytics',
            'user_admin',
            'rpa',
            'voice_ai',
            'lead_scoring',
            'data_enrichment',
            'enterprise_security'
        ]);
        const chatTierMultipliers = {
            ai_chat: 1.0,
            ai_chat_pro: 3.0,
            ai_chat_max: 18.0,
            ai_chat_ultra: 18.0
        };
        const visibleServices = (Array.isArray(services) ? services : []).filter(service => {
            const key = typeof service?.service_key === 'string' ? service.service_key.trim().toLowerCase() : '';
            if (legacyRetiredKeys.has(key)) return false;
            if (!service?.enabled || service?.integration_status === 'unavailable') return false;
            if (service?.display_name === 'Legacy service (disabled)') return false;
            return true;
        });
        const card = document.createElement('section');
        card.className = 'settings-card';
        card.id = 'creditServicePricing';
        const heading = document.createElement('div');
        heading.className = 'settings-card-heading';
        heading.innerHTML = '<h3>Service availability &amp; pricing</h3><p>Only connected services can use credits. Variable AI usage is charged from provider-reported tokens.</p>';
        card.appendChild(heading);

        visibleServices.forEach(service => {
            const row = document.createElement('div');
            row.className = 'settings-service-row';
            const name = document.createElement('strong');
            name.textContent = service.display_name;
            const price = document.createElement('span');
            if (service.fixed_credits) {
                const multiplier = chatTierMultipliers[service.service_key] || Number(service.fixed_credits) || 1;
                const multLabel = Number.isInteger(multiplier) ? `${multiplier}.0x` : `${multiplier}x`;
                const creditWord = service.fixed_credits === 1 ? 'credit' : 'credits';
                price.textContent = `${service.fixed_credits} ${creditWord} baseline (${multLabel} · ${service.fixed_credits} cr / 500 tokens)`;
            } else if (service.credits_per_1000_tokens) {
                price.textContent = `${service.credits_per_1000_tokens} credit(s) per 1,000 measured tokens`;
            } else {
                price.textContent = 'Pricing not configured';
            }
            row.append(name, price);
            card.appendChild(row);
        });
        content.appendChild(card);
    }

    async function loadCreditDetails() {
        const list = document.getElementById('settingsTransactions');
        if (!list) return;
        try {
            const { data: userData, error: userError } = await supabaseClient.auth.getUser();
            if (userError || !userData?.user) throw new Error('Please sign in again to view transactions.');
            const [ledgerResult, reservationResult] = await Promise.all([
                supabaseClient
                    .from('credit_transactions')
                    .select('amount,description,type,service,status,created_at')
                    .eq('user_id', userData.user.id)
                    .order('created_at', { ascending: false })
                    .limit(50),
                supabaseClient
                    .from('credit_reservations')
                    .select('reserved_credits,service,status,created_at')
                    .eq('user_id', userData.user.id)
                    .in('status', ['reserved', 'released'])
                    .order('created_at', { ascending: false })
                    .limit(50)
            ]);
            if (ledgerResult.error || reservationResult.error) {
                throw new Error('Transaction history is unavailable right now.');
            }
            list.replaceChildren();
            const entries = [
                ...(ledgerResult.data || []).map(transaction => ({
                    description: transaction.description || transaction.type || 'Credit activity',
                    service: transaction.service,
                    status: transaction.status,
                    created_at: transaction.created_at,
                    amount: Number(transaction.amount) || 0
                })),
                ...(reservationResult.data || []).map(reservation => ({
                    description: reservation.status === 'reserved'
                        ? 'AI request credits held'
                        : 'Failed AI request — credits released',
                    service: reservation.service,
                    status: reservation.status,
                    created_at: reservation.created_at,
                    amountLabel: reservation.status === 'reserved'
                        ? `${reservation.reserved_credits} held`
                        : `${reservation.reserved_credits} released`
                }))
            ].sort((left, right) => new Date(right.created_at) - new Date(left.created_at)).slice(0, 50);
            if (!entries.length) {
                const empty = document.createElement('p');
                empty.className = 'settings-muted';
                empty.textContent = 'No credit transactions yet.';
                list.appendChild(empty);
            } else {
                entries.forEach(transaction => {
                    const row = document.createElement('div');
                    row.className = 'settings-transaction';
                    const label = document.createElement('span');
                    const title = document.createElement('strong');
                    title.textContent = transaction.description || transaction.type || 'Credit activity';
                    const details = document.createElement('small');
                    const date = transaction.created_at ? new Date(transaction.created_at).toLocaleString() : 'Date unavailable';
                    details.textContent = [transaction.service, transaction.status, date].filter(Boolean).join(' · ');
                    label.append(title, details);
                    const amount = document.createElement('b');
                    if (transaction.amountLabel) {
                        amount.textContent = transaction.amountLabel;
                    } else {
                        const value = transaction.amount;
                        amount.textContent = `${value > 0 ? '+' : ''}${value}`;
                    }
                    row.append(label, amount);
                    list.appendChild(row);
                });
            }

            const session = await getSession();
            const pricing = await requestJson('/api/credits/pricing', session);
            appendServicePricing(pricing.services);
        } catch (error) {
            const message = document.createElement('p');
            message.className = 'settings-muted';
            message.textContent = error?.message || 'Could not load credit details.';
            list.replaceChildren(message);
        }
    }

    window.JEVEXA_RECONCILE_PENDING = async () => {
        try {
            const session = await getSession();
            if (session) {
                await reconcilePendingRequest(session);
                await refreshDisplayedCredits();
            }
        } catch (_) {}
    };

    window.JEVEXA_CLEAR_ACCOUNT_STATE = clearAccountChatState;

    window.JEVEXA_CREDITS = {
        refreshHistory: loadCreditDetails,
        fetchBalance: refreshDisplayedCredits,
        updateBalance: (newBalance) => {
            if (newBalance !== undefined && newBalance !== null) {
                window.JEVEXA_UPDATE_CREDIT_BALANCE?.(newBalance);
            }
            return refreshDisplayedCredits();
        }
    };
})();
