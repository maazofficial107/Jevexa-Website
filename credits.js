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
            label: 'Model'
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
    let historyUserId = null;
    let activeAuthUserId = null;
    let maximumChatTier = 'lite';
    let currentTier = 'lite';
    let maximumThinkingLevel = 'low';
    let currentThinkingLevel = 'low';
    const accountTiers = { free: 'lite', starter: 'lite', lite: 'lite', pro: 'pro', business: 'max', max: 'max', ultra: 'ultra' };
    const tierOrder = ['lite', 'pro', 'max', 'ultra'];

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

    function closeSelector(name, returnFocus = false) {
        const control = selectorControls[name];
        if (!control?.menu || !control.trigger) return;
        control.menu.hidden = true;
        control.trigger.setAttribute('aria-expanded', 'false');
        if (returnFocus) control.trigger.focus();
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
        if (focusSelected) {
            const selected = selectorOptions(name).find(option => option.dataset.value === control.input?.value);
            (selected || selectorOptions(name)[0])?.focus();
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
                : ({ pro: 'Pro', max: 'Max', ultra: 'Ultra' })[value] || 'Pro';
            closeSelector(name);
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL(requiredPlan, option.dataset.label || control.label, control.trigger);
            } else if (typeof window.showToast === 'function') {
                window.showToast(`Upgrade to ${requiredPlan} Plan to unlock this feature.`);
            } else {
                setStatus(`Upgrade to ${requiredPlan} Plan to unlock this feature.`);
            }
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL !== 'function') control.trigger.focus();
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
        bindSafe(control.trigger, 'click', () => {
            if (control.menu.hidden) openSelector(name);
            else closeSelector(name);
        });
        control.trigger.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            openSelector(name);
        });
        bindSafe(control.menu, 'click', event => {
            const target = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
            if (target && control.menu.contains(target)) selectOption(name, target);
        }, { getKey: event => event.target instanceof Element ? event.target.closest('[role="option"]') || control.menu : control.menu });
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
            options[nextIndex]?.focus();
        });
        updateSelectorDisplay(name);
    }

    Object.keys(selectorControls).forEach(wireCustomSelector);
    bindSafe(document, 'click', event => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.chat-select')) return;
        Object.keys(selectorControls).forEach(name => closeSelector(name));
    }, {
        getKey: event => event.target instanceof Element ? event.target.closest('.chat-select') || event.target : document,
        preventDefaultOnDebounce: false
    });

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
            maximumThinkingLevel = 'low';
            currentThinkingLevel = 'low';
            thinkingSelect.value = 'low';
            selectorOptions('thinking').forEach(option => {
                option.dataset.locked = String(option.dataset.value !== 'low');
            });
            updateSelectorDisplay('thinking');
        }
    }

    function clearAccountChatState() {
        conversation.length = 0;
        chatSessions = [];
        activeChatId = null;
        historyUserId = null;
        ambiguousRequestId = null;
        messages?.querySelectorAll('.message:not([data-chat-welcome])').forEach(message => message.remove());
        pendingAttachments.length = 0;
        renderAttachments();
        lockChatTiers();
        updateChatWelcome(null);
        setStatus('Please sign in to use the AI chatbot.');
    }

    function conversationKey(userId) {
        return `jevexa_${userId}_chat_sessions`;
    }

    function renderChatHistory() {
        const list = document.getElementById('chatHistoryList');
        if (!list) return;
        const query = document.getElementById('chatHistorySearch')?.value.trim().toLowerCase() || '';
        const emptyState = document.getElementById('chatHistoryEmpty');
        list.replaceChildren();
        const matchingSessions = chatSessions
            .map(session => ({
                session,
                preview: [...session.messages].reverse().find(item => item.role === 'user')?.text || ''
            }))
            .filter(({ session, preview }) => !query
                || `${session.title} ${preview}`.toLowerCase().includes(query))
            .sort((a, b) => b.session.updatedAt - a.session.updatedAt)
            .forEach(({ session, preview }) => {
                const row = document.createElement('div');
                row.className = `chat-history-row${session.id === activeChatId ? ' active' : ''}`;
                row.setAttribute('role', 'listitem');
                const select = document.createElement('button');
                select.type = 'button';
                select.className = 'chat-history-select';
                select.setAttribute('aria-label', `${session.title || 'New chat'}${preview ? `: ${preview}` : ''}`);
                select.setAttribute('aria-current', session.id === activeChatId ? 'true' : 'false');
                const title = document.createElement('span');
                title.className = 'chat-history-title';
                appendSearchHighlight(title, session.title || 'New chat', query);
                const previewText = document.createElement('span');
                previewText.className = 'chat-history-preview';
                appendSearchHighlight(previewText, preview.slice(0, 100), query);
                select.append(title, previewText);
                bindSafe(select, 'click', () => selectChatSession(session.id));
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'chat-history-delete';
                remove.setAttribute('aria-label', `Delete chat: ${session.title || 'New chat'}`);
                remove.textContent = '×';
                bindSafe(remove, 'click', () => {
                    if (!window.confirm('Delete this chat from this browser?')) return;
                    chatSessions = chatSessions.filter(item => item.id !== session.id);
                    if (session.id === activeChatId) createChatSession();
                    else saveChatSessions();
                });
                row.append(select, remove);
                list.appendChild(row);
            });
        if (emptyState) {
            emptyState.hidden = matchingSessions.length > 0;
            emptyState.textContent = query ? `No chats match “${query}”.` : 'No saved chats yet.';
        }
    }

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
        const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        activeChatId = id;
        conversation.length = 0;
        chatSessions.unshift({ id, title: 'New chat', updatedAt: Date.now(), messages: [] });
        messages?.querySelectorAll('.message:not([data-chat-welcome])').forEach(message => message.remove());
        const welcome = messages?.querySelector('[data-chat-welcome]');
        if (welcome) welcome.hidden = false;
        const emptyState = document.getElementById('chatEmptyState');
        if (emptyState) emptyState.hidden = false;
        updateChatWelcome();
        pendingAttachments.length = 0;
        renderAttachments();
        saveChatSessions();
        setStatus('New chat started.');
    }

    function selectChatSession(sessionId) {
        const session = chatSessions.find(item => item.id === sessionId);
        if (!session) return;
        activeChatId = sessionId;
        conversation.splice(0, conversation.length, ...session.messages);
        messages?.querySelectorAll('.message:not([data-chat-welcome])').forEach(message => message.remove());
        const welcome = messages?.querySelector('[data-chat-welcome]');
        if (welcome) welcome.hidden = conversation.length > 0;
        conversation.forEach((item, index) => appendMessage(item.text, item.role === 'user', index));
        const emptyState = document.getElementById('chatEmptyState');
        if (emptyState) emptyState.hidden = conversation.length > 0;
        updateChatWelcome();
        renderChatHistory();
    }

    function persistConversation(userId) {
        try {
            if (!activeChatId) {
                activeChatId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
                chatSessions.unshift({ id: activeChatId, title: 'New chat', updatedAt: Date.now(), messages: [] });
            }
            const session = chatSessions.find(item => item.id === activeChatId);
            if (!session) return false;
            session.messages = conversation.slice(-16);
            session.updatedAt = Date.now();
            session.title = session.messages.find(item => item.role === 'user')?.text.slice(0, 48) || 'New chat';
            return saveChatSessions();
        } catch (error) {
            console.error('Could not save chat history:', error);
            return false;
        }
    }

    function loadConversation(userId) {
        if (historyUserId === userId) return;
        historyUserId = userId;
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
                    messages: item.messages.slice(-16).filter(message =>
                        message && ['user', 'assistant'].includes(message.role)
                        && typeof message.text === 'string' && message.text.length <= 3000
                    )
                }));
            const legacy = JSON.parse(localStorage.getItem(`jevexa_${userId}_chat_history`) || '[]');
            if (!chatSessions.length && Array.isArray(legacy) && legacy.length) {
                chatSessions = [{
                    id: crypto.randomUUID?.() || `${Date.now()}-legacy`,
                    title: legacy.find(item => item?.role === 'user')?.text?.slice(0, 48) || 'Previous chat',
                    updatedAt: Date.now(),
                    messages: legacy.filter(item => item && ['user', 'assistant'].includes(item.role)
                        && typeof item.text === 'string' && item.text.length <= 3000).slice(-16)
                }];
            }
            if (chatSessions.length) {
                selectChatSession([...chatSessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].id);
            } else {
                createChatSession();
            }
            renderChatHistory();
        } catch (error) {
            console.warn('Chat history restore notice:', error?.message || error);
            chatSessions = [];
            createChatSession();
        }
    }

    async function refreshTierAccess(session) {
        if (!tierSelect) return;
        try {
            const { data, error } = await supabaseClient.from('user_credits')
                .select('plan,balance').eq('user_id', session.user.id).maybeSingle();
            let maximumTier = 'lite';
            if (data && typeof data.plan === 'string' && data.plan.trim()) {
                const planKey = data.plan.trim().toLowerCase();
                if (accountTiers[planKey]) {
                    maximumTier = accountTiers[planKey];
                }
            } else if (data && Number.isInteger(data.balance)) {
                if (data.balance >= 30000) maximumTier = 'max';
                else if (data.balance >= 10000) maximumTier = 'pro';
                else maximumTier = 'lite';
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
                maximumThinkingLevel = maximumIndex >= 2 ? 'max' : maximumIndex >= 1 ? 'standard' : 'low';
                const thinkingMaximumIndex = ['low', 'standard', 'max'].indexOf(maximumThinkingLevel);
                selectorOptions('thinking').forEach(option => {
                    const optionIndex = ['low', 'standard', 'max'].indexOf(option.dataset.value);
                    const locked = optionIndex > thinkingMaximumIndex;
                    option.dataset.locked = String(locked);
                });
                if (['low', 'standard', 'max'].indexOf(thinkingSelect.value) > thinkingMaximumIndex) thinkingSelect.value = 'low';
                currentThinkingLevel = thinkingSelect.value;
                updateSelectorDisplay('thinking');
            }
        } catch (tierErr) {
            console.warn('Chat tier lookup notice, defaulting to lite:', tierErr?.message || tierErr);
            maximumChatTier = 'lite';
            currentTier = 'lite';
            if (tierSelect) tierSelect.value = 'lite';
            updateSelectorDisplay('tier');
        }
    }

    async function initializeChatSession() {
        try {
            const session = await getSession();
            const statusText = document.getElementById('chatbotStatusText') || document.querySelector('.chatbot-info .status');
            if (!session) {
                if (statusText) statusText.textContent = 'AI chat • Sign-in required';
                updateChatWelcome(null);
                return;
            }
            if (statusText) statusText.textContent = 'AI chat • Online';
            loadConversation(session.user.id);
            updateChatWelcome(session.user);
            await refreshTierAccess(session);
            void reconcilePendingRequest(session);
            try {
                const savedTheme = localStorage.getItem(`jevexa_${session.user.id}_chat_theme`);
                const theme = ['dark', 'light', 'system'].includes(savedTheme) ? savedTheme : 'dark';
                setSelectorValue('theme', theme);
                document.getElementById('chatbotWindow')?.setAttribute('data-chat-theme', theme);
                document.getElementById('chatReducedMotion').checked =
                    localStorage.getItem(`jevexa_${session.user.id}_chat_reduced_motion`) === 'true';
                document.documentElement.classList.toggle(
                    'jevexa-reduce-motion',
                    document.getElementById('chatReducedMotion').checked
                );
            } catch (error) {
                console.warn('Could not restore chat settings:', error);
            }
        } catch (error) {
            console.warn('Chat session init:', error?.message || error);
        }
    }

    function renderAttachments() {
        if (!attachmentList) return;
        attachmentList.replaceChildren();
        pendingAttachments.forEach((attachment, index) => {
            const chip = document.createElement('span');
            chip.className = 'chat-attachment-chip';
            const label = document.createElement('span');
            label.textContent = attachment.name;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.setAttribute('aria-label', `Remove ${attachment.name}`);
            remove.textContent = '×';
            bindSafe(remove, 'click', () => {
                pendingAttachments.splice(index, 1);
                renderAttachments();
            });
            chip.append(label, remove);
            attachmentList.appendChild(chip);
        });
        attachmentList.hidden = pendingAttachments.length === 0;
    }

    async function addAttachments(files) {
        if (pendingAttachments.length + files.length > 2) {
            setStatus('Attach up to two files per message.');
            return;
        }
        const prepared = [];
        const tier = tierSelect?.value || 'lite';
        for (const file of files) {
            if (file.size >= 5 * 1024 * 1024) {
                setStatus(`${file.name} is too large. Each attachment must be under 5 MB.`);
                return;
            }
            const extension = file.name.split('.').pop().toLowerCase();
            const extensionTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', zip: 'application/zip' };
            const type = (file.type || extensionTypes[extension] || '').toLowerCase();
            const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
            const paidFileTypes = ['application/pdf', 'application/zip', 'application/x-zip-compressed'];
            if (tier === 'lite' && !imageTypes.includes(type)) {
                setStatus('Images only on Lite. Upgrade to attach PDF or ZIP files.', true);
                if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                    window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'PDF & ZIP file uploads', attachButton);
                }
                return;
            }
            if (imageTypes.includes(type) || (tier !== 'lite' && paidFileTypes.includes(type))) {
                prepared.push({
                    name: file.name,
                    type: type === 'application/x-zip-compressed' ? 'application/zip' : type,
                    data: await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => {
                            const result = String(reader.result || '');
                            const base64 = result.slice(result.indexOf(',') + 1);
                            resolve(`data:${type === 'application/x-zip-compressed' ? 'application/zip' : type};base64,${base64}`);
                        };
                        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
                        reader.readAsDataURL(file);
                    })
                });
            } else {
                setStatus('Supported files are JPEG, PNG, WebP, GIF, PDF, and ZIP under 5 MB.');
                return;
            }
        }
        pendingAttachments.push(...prepared);
        renderAttachments();
        if (pendingAttachments.length) setStatus(`${pendingAttachments.length} attachment${pendingAttachments.length === 1 ? '' : 's'} ready.`);
    }

    function setStatus(message, showUpgrade = false) {
        if (status) status.textContent = message;
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

    function renderMarkdown(text) {
        const escaped = String(text).replace(/[&<>"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
        })[character]);
        return escaped
            .replace(/`([^`\n]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
            .replace(/\[([^\]]+)\]\((#[a-zA-Z0-9_-]+|https?:\/\/[^\s<>"')]+)\)/g, '<a href="$2">$1</a>')
            .replace(/\n/g, '<br>');
    }

    function appendMessage(text, user = false, index = conversation.length) {
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
        const paragraph = document.createElement('p');
        paragraph.innerHTML = renderMarkdown(text);
        content.appendChild(paragraph);
        if (!user) {
            const actions = document.createElement('div');
            actions.className = 'chat-message-actions';
            const copy = document.createElement('button');
            copy.type = 'button';
            copy.dataset.chatAction = 'copy';
            copy.setAttribute('aria-label', 'Copy response');
            copy.textContent = 'Copy';
            const regenerate = document.createElement('button');
            regenerate.type = 'button';
            regenerate.dataset.chatAction = 'regenerate';
            regenerate.setAttribute('aria-label', 'Regenerate response');
            regenerate.textContent = 'Regenerate';
            actions.append(copy, regenerate);
            content.appendChild(actions);
        }
        row.append(avatar, content);
        messages.appendChild(row);
        const renderedMessages = messages.querySelectorAll('.message:not([data-chat-welcome])');
        for (let index = 0; index < renderedMessages.length - maxRenderedMessages; index += 1) {
            renderedMessages[index].remove();
        }
        const welcome = messages.querySelector('[data-chat-welcome]');
        if (welcome) welcome.hidden = true;
        const emptyState = document.getElementById('chatEmptyState');
        if (emptyState) emptyState.hidden = true;
        messages.scrollTop = messages.scrollHeight;
    }

    function showTyping() {
        if (!messages || messages.querySelector('#typingMsg')) return;
        const typing = document.createElement('div');
        typing.className = 'message bot';
        typing.id = 'typingMsg';
        typing.innerHTML = '<div class="msg-avatar"><i class="fas fa-wand-magic-sparkles"></i></div><div class="typing-indicator"><span></span><span></span><span></span></div>';
        messages.appendChild(typing);
        messages.scrollTop = messages.scrollHeight;
    }

    function removeTyping() {
        messages?.querySelector('#typingMsg')?.remove();
    }

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
        const { data, error } = await supabaseClient.auth.getSession();
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

    async function requestJson(url, session, options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 35000);
        let response;
        try {
            response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.access_token}`,
                    ...(options.headers || {})
                }
            });
        } finally {
            clearTimeout(timeoutId);
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error || 'The request could not be completed.');
            error.status = response.status;
            error.payload = payload;
            throw error;
        }
        return payload;
    }

    function generateChatbotGuestReply(queryText) {
        const q = String(queryText || '').toLowerCase().trim();
        if (/^(hi|hello|hey|greetings|howdy|salam|aoa)\b/i.test(q)) {
            return "Hello! I am Jevexa AI, your intelligent automation assistant. Ready to help you draft content, brainstorm marketing strategies, explain our AI tools, or automate business workflows. What would you like to work on today?";
        }
        if (/who are you|what can you do|what is jevexa/i.test(q)) {
            return "I am Jevexa AI, the core assistant for JEVEXA AI Studio. I help teams automate operations, draft high-performing marketing & business copy, analyze documents (PDF & ZIP on Pro+), and streamline workflows with dedicated AI tools.";
        }
        if (/blog|write a blog/i.test(q)) {
            return "Here is a high-converting blog outline you can use right away:\n\n1. **Hook:** State the industry challenge and why previous solutions fall short.\n2. **The Core Shift:** Introduce AI-driven automation as the competitive edge.\n3. **Practical Framework:** Step-by-step implementation guide with tangible metrics.\n4. **Call to Action:** Direct readers to test the workflow.\n\n*Tip:* Our live **Content Generation** tool drafts complete articles with customizable tone and length! Sign in to get 100 free credits to generate yours.";
        }
        if (/draft an email|email/i.test(q)) {
            return "Here is a professional outreach email template:\n\n**Subject:** Streamlining your AI workflow at [Company Name]\n\nHi [First Name],\n\nI noticed your team is scaling operations and thought you might be interested in automating repetitive content and customer queries.\n\nAt JEVEXA, our AI tools help teams save 15+ hours weekly with intelligent chat, automated drafting, and workflow integrations. Would you be open to a quick 5-minute look this week?\n\nBest regards,\n[Your Name]\n\n*Tip:* You can generate personalized email sequences using our Content Generation tool with your 100 free credits!";
        }
        if (/credit|token|balance|cost|quota/i.test(q)) {
            return "JEVEXA credits power all studio tools:\n• **100 Free Welcome Credits:** Included immediately upon sign-up (no card required).\n• **Fixed Per-Message Rates:** Lite is 1 credit/msg, Pro is 2 credits/msg, Max is 4 credits/msg, and Ultra is 8 credits/msg.\n• **Content Generation:** Measured transparently by provider usage.\n• **Credit Packages:** One-time purchases with an automatic **20% annual discount**!";
        }
        if (/price|pricing|plan|ultra|pro|lite|max|annual|discount/i.test(q)) {
            return "JEVEXA offers 4 scalable tiers with 20% annual discount:\n• **Lite:** $5/mo ($4/mo annual) — 2,000 monthly credits, Lite AI Chat (1 credit/msg)\n• **Pro:** $12/mo ($9.60/mo annual) — 10,000 monthly credits, Pro AI Chat (2 credits/msg), PDF & ZIP uploads\n• **Max:** $25/mo ($20/mo annual) — 30,000 monthly credits, Max AI Chat (4 credits/msg), full reasoning depth\n• **Ultra:** $49/mo ($39.20/mo annual) — 70,000 monthly credits, Ultra AI Chat (8 credits/msg), flagship models & priority queue.\nAll annual packages are discounted by 20% and paid once!";
        }
        if (/tool|feature|capabilities|model|ocr|crm/i.test(q)) {
            return "JEVEXA AI Studio features 10 business tools:\n• **AI Chat** & **Content Generation** are live today!\n• 8 additional tools (Email AI, Mini CRM, Document OCR, Social Assistant, Analytics, User Management, Workflow Automation, Data Management) roll out across planned releases.\nSign in to test the live tools with 100 free credits!";
        }
        return "I can help with that! As your JEVEXA AI Assistant, I can draft comprehensive responses, analyze technical topics, explore business automation strategies, or guide you through our studio tools. Let me know what specific focus or format you prefer!";
    }

    async function handleSend() {
        if (sending) return;
        const text = input?.value.trim();
        if (!text && pendingAttachments.length === 0) return;

        sending = true;
        if (sendButton) sendButton.disabled = true;
        if (input) input.disabled = true;
        if (attachButton) attachButton.disabled = true;

        const attachments = pendingAttachments.map(item => ({ ...item }));
        const displayText = text || `Attached: ${attachments.map(item => item.name).join(', ')}`;
        const messageIndex = conversation.length;

        // Immediately render user bubble and show typing indicator
        appendMessage(displayText, true, messageIndex);
        if (input) input.value = '';
        pendingAttachments.length = 0;
        renderAttachments();
        showTyping();
        setStatus('Checking sign-in, tier access, and credit cost…');

        try {
            const session = await getSession();
            if (!session) {
                let guestReply = '';
                try {
                    const response = await fetch('/api/support/ai', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message: displayText, history: conversation.slice(-4) })
                    });
                    const resJson = await response.json().catch(() => ({}));
                    if (typeof resJson?.reply === 'string' && resJson.reply.trim()) {
                        guestReply = resJson.reply.trim();
                    }
                } catch { /* fallback to client generator */ }

                if (!guestReply) {
                    guestReply = generateChatbotGuestReply(displayText);
                }

                removeTyping();
                conversation.push({ role: 'user', text: displayText });
                conversation.push({ role: 'assistant', text: guestReply });
                appendMessage(
                    `${guestReply}\n\n*⚡ Sign in to claim 100 free credits and unlock live AI generation, or explore our [Pricing](#pricing) tiers.*`,
                    false,
                    conversation.length - 1
                );
                setStatus('Guest mode • Sign in to claim 100 free credits and use full AI capabilities.');
                return;
            }

            loadConversation(session.user.id);
            if (await reconcilePendingRequest(session)) {
                removeTyping();
                return;
            }

            const selectedTier = tierSelect?.value || 'lite';
            if (selectedTier === 'lite' && attachments.some(item => !item.type.startsWith('image/'))) {
                removeTyping();
                setStatus('Images only on Lite. Remove PDF or ZIP attachments, or upgrade your plan.', true);
                if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                    window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'PDF & ZIP file uploads', attachButton);
                }
                return;
            }

            const chatPayload = {
                message: text,
                tier: selectedTier,
                thinkingLevel: thinkingSelect?.value || 'low',
                attachments,
                history: conversation.slice(-8)
            };

            const fixedTierCosts = { lite: 1, pro: 2, max: 4, ultra: 8 };
            let quote = null;
            try {
                quote = await Promise.race([
                    requestJson('/api/credits/quote', session, {
                        method: 'POST',
                        body: JSON.stringify(chatPayload)
                    }),
                    new Promise(resolve => setTimeout(resolve, 600))
                ]);
            } catch (quoteErr) {
                console.warn('Credit quote lookup notice:', quoteErr?.message || quoteErr);
            }

            const estimatedCredits = fixedTierCosts[selectedTier] || quote?.estimatedCredits || 1;

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
                setStatus(`This ${selectedTier.toUpperCase()} message costs ${estimatedCredits} credits; your available balance is ${wallet.balance}. Choose a plan to continue.`, true);
                appendMessage(`Not enough credits for this ${selectedTier.toUpperCase()} message. It costs ${estimatedCredits} credits; your balance is ${wallet.balance}. [View Upgrade Plans](#pricing) to top up.`);
                if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                    window.JEVEXA_SHOW_UPGRADE_MODAL(requiredPlanName, 'additional AI credits');
                }
                return;
            }

            setStatus(`${selectedTier.toUpperCase()} costs ${estimatedCredits} fixed credits per message.`);
            const requestId = createRequestId();

            try {
                const result = await requestJson('/api/chat', session, {
                    method: 'POST',
                    headers: { 'Idempotency-Key': requestId },
                    body: JSON.stringify({ ...chatPayload, requestId })
                });
                removeTyping();
                const replyText = String(result.reply || '').trim();
                conversation.push({ role: 'user', text: displayText });
                conversation.push({ role: 'assistant', text: replyText });
                appendMessage(replyText, false, conversation.length - 1);
                if (conversation.length > 16) conversation.splice(0, conversation.length - 16);
                const historySaved = persistConversation(session.user.id);
                const remaining = Number.isInteger(result.remaining_credits)
                    ? result.remaining_credits
                    : (Number.isInteger(result.creditsRemaining) ? result.creditsRemaining : null);
                const used = Number.isInteger(result.credits_used)
                    ? result.credits_used
                    : (Number.isInteger(result.creditsCharged) ? result.creditsCharged : 1);
                if (remaining !== null) {
                    const countEl = document.getElementById('creditsCount');
                    if (countEl) countEl.textContent = String(remaining);
                    const settingsBal = document.getElementById('settingsBalance');
                    if (settingsBal) settingsBal.textContent = String(remaining);
                    window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
                }
                setStatus(
                    `AI reply completed. ${used} ${String(result.tier || selectedTier).toUpperCase()} credit${used === 1 ? '' : 's'} used. Balance ${remaining !== null ? remaining : result.creditsRemaining}.`
                );
                await refreshDisplayedCredits();
            } catch (error) {
                removeTyping();
                await refreshDisplayedCredits();
                if (error.payload?.reply) {
                    const replyText = String(error.payload.reply).trim();
                    conversation.push({ role: 'user', text: displayText });
                    conversation.push({ role: 'assistant', text: replyText });
                    appendMessage(replyText, false, conversation.length - 1);
                    if (conversation.length > 16) conversation.splice(0, conversation.length - 16);
                    persistConversation(session.user.id);
                    forgetPendingRequest(session);
                    setStatus('AI reply completed. (Credits will reconcile automatically).');
                    await refreshDisplayedCredits();
                    return;
                }
                if (!Number.isInteger(error.status)) {
                    rememberPendingRequest(session, requestId);
                    setStatus('Connection interrupted — checking request status…');
                    appendMessage('Connection interrupted. Verifying your request…');
                    try {
                        const stillPending = await reconcilePendingRequest(session);
                        if (!stillPending) {
                            setStatus('Request could not be confirmed. No credits were charged. You can send another message.');
                        }
                    } catch {
                        forgetPendingRequest(session);
                        setStatus('Could not verify the interrupted request. You can send another message.');
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
                            return;
                        }
                    } catch (recErr) {
                        console.warn('Auto-reconciliation notice:', recErr);
                    }
                    setStatus('AI is temporarily busy. Any held credits will clear automatically.');
                    appendMessage('The previous request was held for safety and will release automatically. Please try again shortly.');
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
                } else if (error.status === 429) {
                    setStatus('Rate limited. Wait 60 seconds before sending another message.');
                    appendMessage('Rate limited. Wait 60 seconds before sending another message.');
                } else {
                    const message = error.message || (error.status >= 500
                        ? 'The AI assistant could not complete that request. Please try again shortly.'
                        : 'An error occurred.');
                    setStatus(message, true);
                    appendMessage(message);
                }
            }
        } catch (error) {
            removeTyping();
            const message = error?.message || 'The AI assistant encountered an error. Please try again shortly.';
            setStatus(message, true);
            appendMessage(message);
        } finally {
            sending = false;
            if (sendButton) sendButton.disabled = false;
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
        if (button.matches('.chat-welcome-chip') && input) input.value = button.textContent.trim();
        handleSend();
    }, {
        matches: event => event.target instanceof Element
            && Boolean(event.target.closest('#chatSend, #chatWelcomeChips .chat-welcome-chip')),
        getKey: event => event.target instanceof Element
            ? event.target.closest('#chatSend, #chatWelcomeChips .chat-welcome-chip') || document
            : document,
        listenerOptions: true
    });

    document.addEventListener('keydown', event => {
        if (event.target !== input || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        handleSend();
    }, true);

    input?.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    });

    bindSafe(messages, 'click', async event => {
        const button = event.target.closest('[data-chat-action]');
        if (!button) return;
        const row = button.closest('.message');
        const index = Number(row?.dataset.messageIndex);
        if (button.dataset.chatAction === 'copy') {
            try {
                await navigator.clipboard.writeText(conversation[index]?.text || row.querySelector('.msg-content p')?.textContent || '');
                setStatus('Response copied.');
            } catch (error) {
                console.error('Could not copy chat response:', error);
                setStatus('Could not copy this response on your device.');
            }
            return;
        }
        if (button.dataset.chatAction === 'regenerate' && Number.isInteger(index) && index > 0) {
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
            ? event.target.closest('[data-chat-action]') || messages
            : messages
    });

    bindSafe(attachButton, 'click', (event) => {
        try {
            // Lock file uploads for free tier (lite) users
            if (maximumChatTier === 'lite') {
                event.preventDefault();
                event.stopPropagation();
                const requiredPlan = 'Pro';
                if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                    window.JEVEXA_SHOW_UPGRADE_MODAL(requiredPlan, 'file uploads', attachButton);
                } else if (typeof window.showToast === 'function') {
                    window.showToast(`Upgrade to ${requiredPlan} Plan to unlock file uploads.`);
                }
                return;
            }
            fileInput?.click();
        } catch (error) {
            console.error('Attach button error:', error);
        }
    });
    bindSafe(document.getElementById('chatbotToggle'), 'click', () => {
        updateChatWelcome();
        void initializeChatSession();
    });
    if (typeof supabaseClient !== 'undefined' && supabaseClient?.auth?.onAuthStateChange) {
        supabaseClient.auth.onAuthStateChange((_event, session) => {
            const userId = session?.user?.id || null;
            if (activeAuthUserId && activeAuthUserId !== userId) clearAccountChatState();
            activeAuthUserId = userId;
            const statusText = document.getElementById('chatbotStatusText') || document.querySelector('.chatbot-info .status');
            if (statusText) statusText.textContent = userId ? 'AI chat • Online' : 'AI chat • Sign-in required';
            updateChatWelcome(session?.user || null);
            if (userId) {
                void initializeChatSession();
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

    bindSafe(document.getElementById('chatNewConversation'), 'click', () => {
        if (!historyUserId) {
            setStatus('Sign in before saving a new chat.');
            return;
        }
        createChatSession();
    });

    document.getElementById('chatHistorySearch')?.addEventListener('input', renderChatHistory);
    bindSafe(document.getElementById('chatSidebarToggle'), 'click', () => {
        const sidebar = document.getElementById('chatSidebar');
        const open = sidebar?.classList.toggle('open') || false;
        document.getElementById('chatbotWindow')?.classList.toggle('chat-history-open', open);
    });
    bindSafe(document.getElementById('chatSidebarClose'), 'click', () => {
        document.getElementById('chatSidebar')?.classList.remove('open');
        document.getElementById('chatbotWindow')?.classList.remove('chat-history-open');
    });
    document.getElementById('chatTier')?.addEventListener('change', () => {
        const tier = tierSelect.value;
        // Defensive: Ensure maximum values are valid before comparison
        const currentMaximumChatTier = typeof maximumChatTier === 'string' && maximumChatTier.length > 0 ? maximumChatTier : 'lite';
        if (tierOrder.indexOf(tier) > tierOrder.indexOf(currentMaximumChatTier)) {
            tierSelect.value = currentTier;
            updateSelectorDisplay('tier');
            const requiredPlan = ({ pro: 'Pro', max: 'Max', ultra: 'Ultra' })[tier] || 'Pro';
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL(requiredPlan, 'this chat tier');
            } else if (typeof window.showToast === 'function') {
                window.showToast(`Upgrade to ${requiredPlan} Plan to unlock this feature.`);
            } else {
                setStatus(`Upgrade to ${requiredPlan} Plan to unlock this feature.`);
            }
            return;
        }
        currentTier = tier;
        updateSelectorDisplay('tier');
        setStatus(`⚡ ${tier[0].toUpperCase()}${tier.slice(1)} • ${{ lite: 1, pro: 2, max: 4, ultra: 8 }[tier]} credit${tier === 'lite' ? '' : 's'}/msg`);
    });
    document.getElementById('chatThinking')?.addEventListener('change', () => {
        const selected = thinkingSelect.value;
        // Defensive: Ensure maximum values are valid before comparison
        const currentMaximumThinkingLevel = typeof maximumThinkingLevel === 'string' && maximumThinkingLevel.length > 0 ? maximumThinkingLevel : 'low';
        if (['low', 'standard', 'max'].indexOf(selected) > ['low', 'standard', 'max'].indexOf(currentMaximumThinkingLevel)) {
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
    document.getElementById('chatTheme')?.addEventListener('change', event => {
        document.getElementById('chatbotWindow')?.setAttribute('data-chat-theme', event.target.value);
        if (historyUserId) {
            try {
                localStorage.setItem(`jevexa_${historyUserId}_chat_theme`, event.target.value);
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
    bindSafe(document.getElementById('chatClearAll'), 'click', () => {
        if (!historyUserId || !window.confirm('Delete all saved chats from this browser?')) return;
        chatSessions = [];
        try {
            localStorage.removeItem(conversationKey(historyUserId));
        } catch (error) {
            console.warn('Could not clear chat sessions from storage:', error);
        }
        createChatSession();
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
        const card = document.createElement('section');
        card.className = 'settings-card';
        card.id = 'creditServicePricing';
        const heading = document.createElement('div');
        heading.className = 'settings-card-heading';
        heading.innerHTML = '<h3>Service availability &amp; pricing</h3><p>Only connected services can use credits. Variable AI usage is charged from provider-reported tokens.</p>';
        card.appendChild(heading);

        services.forEach(service => {
            const row = document.createElement('div');
            row.className = 'settings-service-row';
            const name = document.createElement('strong');
            name.textContent = service.display_name;
            const price = document.createElement('span');
            if (!service.enabled || service.integration_status === 'unavailable') {
                price.textContent = 'Unavailable — provider integration not connected';
            } else if (service.fixed_credits) {
                price.textContent = `${service.fixed_credits} credits per operation`;
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

    window.JEVEXA_CREDITS = {
        refreshHistory: loadCreditDetails
    };
})();
