(function () {
    const bindSafe = (target, type, handler, options) => {
        if (window.JEVEXA_SAFE_INTERACTION?.bind) {
            window.JEVEXA_SAFE_INTERACTION.bind(target, type, handler, options);
        } else {
            target?.addEventListener(type, handler, options?.listenerOptions);
        }
    };
    function initSupportModal() {
        const modal = document.getElementById('supportModal');
    const form = document.getElementById('supportTicketForm');
    const aiForm = document.getElementById('supportAiForm');
    const aiMessages = document.getElementById('supportAiMessages');
    const submitButton = document.getElementById('supportTicketSubmit');
    const status = document.getElementById('supportTicketStatus');
    const aiSend = document.getElementById('supportAiSend');
    const aiInput = document.getElementById('supportAiInput');
    const aiHistory = [];
    if (!modal || !form || !aiForm || !aiMessages) return;

    let returnFocus = null;
    let connectingTimer = null;
    let aiBusy = false;
    let ticketBusy = false;

    function setTicketStatus(message, state) {
        if (!status) return;
        status.textContent = message;
        status.dataset.state = state;
    }

    async function getSession() {
        if (!window.JEVEXA_SUPABASE_READY || typeof supabaseClient === 'undefined' || !supabaseClient) return null;
        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw new Error('Could not confirm your sign-in. Please try again.');
        return data?.session || null;
    }

    async function prefillTicketForm() {
        try {
            const session = await getSession();
            if (!session) return;
            const user = session.user;
            const fullName = user.user_metadata?.full_name || user.user_metadata?.name || '';
            const nameInput = document.getElementById('supportName');
            const emailInput = document.getElementById('supportEmail');
            if (!nameInput.value) nameInput.value = fullName;
            if (!emailInput.value) emailInput.value = user.email || '';
        } catch (error) {
            console.info('Support form prefill is unavailable:', error.message);
        }
    }

    function openModal() {
        returnFocus = document.activeElement;
        modal.hidden = false;
        document.getElementById('supportAiPhase').hidden = false;
        document.getElementById('supportHumanButton').hidden = false;
        document.getElementById('supportConnecting').hidden = true;
        document.getElementById('supportSuccess').hidden = true;
        form.hidden = true;
        setTicketStatus('', '');
        aiInput?.focus();
    }

    window.JEVEXA_SUPPORT_MODAL_OPEN = openModal;

    function closeModal() {
        if (connectingTimer !== null) {
            window.clearTimeout(connectingTimer);
            connectingTimer = null;
        }
        modal.hidden = true;
        returnFocus?.focus?.();
    }

    function addAiMessage(text, user = false) {
        const message = document.createElement('p');
        message.className = `support-ai-message${user ? ' user' : ''}`;
        message.textContent = text;
        aiMessages.appendChild(message);
        aiMessages.scrollTop = aiMessages.scrollHeight;
        return message;
    }

    bindSafe(document.getElementById('supportModalClose'), 'click', closeModal);
    bindSafe(modal, 'click', event => {
        if (event.target === modal) closeModal();
    }, { matches: event => event.target === modal, getKey: () => modal });
    document.addEventListener('keydown', event => {
        if (modal.hidden) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeModal();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(modal.querySelectorAll(
            'button:not(:disabled):not([hidden]), input:not(:disabled):not([hidden]), textarea:not(:disabled):not([hidden]), a[href]'
        )).filter(element => element.getClientRects().length);
        if (!focusable.length) return;
        if (event.shiftKey && document.activeElement === focusable[0]) {
            event.preventDefault();
            focusable[focusable.length - 1].focus();
        } else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
            event.preventDefault();
            focusable[0].focus();
        }
    });

    function generateClientSupportReply(userMessage) {
        const q = String(userMessage || '').toLowerCase().trim();
        if (/reconcil|stuck|hold|held|awaiting safe|locked|unlock/i.test(q)) {
            return "If an AI message or credit reservation ever displays 'awaiting reconciliation', our system automatically releases any stale pending hold older than 15–30 seconds and restores the held credits to your wallet. You can also click 'Clear & Unlock Chat' in the chat header to reset your session immediately. If you need any manual account adjustment, click 'Talk to Human' below!";
        }
        if (/\b(tools?|features?|capabilities|ocr|crm|content|social|analytics|workflow)\b/i.test(q)) {
            return "JEVEXA AI Studio features 10 comprehensive business tools: AI Chat, Content Generation, Email & Outreach AI, Mini CRM, Document AI & OCR, Social Media Assistant, Business Analytics, User & Admin Management, Workflow Automation, and Data Management. You can launch and test all 10 tools directly from the Studio dashboard with your credits, or click 'Talk to Human' for custom support.";
        }
        if (/price|pricing|\bplans?\b|ultra|pro|lite|max|annual|discount|subscription|buy|checkout|safepay/i.test(q)) {
            return "JEVEXA offers 5 transparent plans with an automatic 20% annual package discount:\n• Free ($0): 100 one-time signup credits (max 15 credits/day), Economy models (1.0x), thinking OFF\n• Lite: $5/mo ($4/mo annual, $48/yr) — 2,500 credits/month (~1.25M fast tokens), unlocks Standard Tier (3.0x) & PDF/ZIP uploads\n• Pro: $15/mo ($12/mo annual, $144/yr) — 10,000 credits/month (~5M tokens), Low/Medium thinking, Web Search (15/day, +5 cr/req)\n• Max: $29/mo ($23.20/mo annual, $278.40/yr) — 22,000 credits/month (~11M tokens), Flagship Reasoning (18.0x), High/Max thinking, Web Search (50/day)\n• Ultra: $49/mo ($39.20/mo annual, $470.40/yr) — 40,000 credits/month (~20M tokens), Flagship Reasoning (18.0x), High/Max thinking, Web Search (150/day).\nAll credit packages are one-time purchases backed by our 7-day refund policy (/refund-policy). Visit /pricing or click 'Talk to Human'!";
        }
        if (/credit|token|balance|cost|quota|rate limit|welcome|refund/i.test(q)) {
            return "JEVEXA includes 100 free signup credits (capped at 15 credits/day, no card required). AI Chat uses transparent token-weighted billing (1 credit per 500 tokens, including thinking output tokens):\n• Model weights: Economy (1.0x), Standard (3.0x), Flagship Reasoning (18.0x)\n• Attachment surcharges: Image (+2 credits), PDF (+4 credits), ZIP (+5 credits)\n• Web Search Grounding: +5 credits/request (Pro 15/day, Max 50/day, Ultra 150/day)\nProtected by our 7-day refund policy (/refund-policy) when <10% of credits are consumed.";
        }
        if (/think|reasoning|model|search|upload|attachment|pdf|zip|file/i.test(q)) {
            return "JEVEXA model routing & capability rules:\n• Economy Tier (1.0x): Available on all plans (gemini-2.5-flash-lite / llama-3.3-70b-versatile)\n• Standard Tier (3.0x): Available on Lite, Pro, Max, Ultra (gemini-3.5-flash-lite / gemini-3.8-flash)\n• Flagship Reasoning Tier (18.0x): Available ONLY on Max & Ultra (gemini-4-argon / gemini-4-carbon)\n• Thinking Mode: OFF on Free & Lite; Low/Medium on Pro; High/Max ONLY on Max & Ultra\n• Uploads: Free allows 5 images (5 MB); Lite/Pro/Max/Ultra unlock PDF + ZIP + Images.";
        }
        if (/tool|feature|capabilities|model|ocr|crm|email|content|social|analytics|workflow|data/i.test(q)) {
            return "JEVEXA AI Studio features 10 live business tools: AI Chat, Content Generation, Email & Outreach AI, Mini CRM, Document AI & OCR, Social Media Assistant, Business Analytics, Team Admin, Workflow Automation, and Data Management. You can test all 10 tools right now with your 100 free credits!";
        }
        if (/human|agent|support|maaz|contact|ticket|email|phone|call/i.test(q)) {
            return "Email Support: Response within 24 hours (Mon–Sat). Click 'Talk to Human' below to submit a ticket directly, or reach us at hello@jevexa.net / maazofficial107@gmail.com.";
        }
        if (/login|signin|sign in|signup|sign up|register|account|password|forgot/i.test(q)) {
            return "You can sign up or sign in using the 'Get Started' or 'Sign In' button at the top right of the page. Once signed in, your account receives 100 free welcome credits immediately to use across all 10 AI tools. If you forgot your password, use the 'Forgot password?' link in the login dialog.";
        }
        if (/^(hi|hello|hey|greetings|howdy|salam|aoa)\b/i.test(q)) {
            return "Hello! I am the JEVEXA Support Assistant. I can help answer questions about our 10 live AI tools (AI Chat, Content Generation, Outreach, CRM, OCR, Social, Analytics, Team Admin, Workflows, Data Management), token-weighted credit rates (1 credit per 500 tokens), progressive file upload rules, pricing plans (Lite, Pro, Max, Ultra with 20% annual discount), or account setup. You can also click 'Talk to Human' to reach Maaz directly!";
        }
        return "Hello! I am the JEVEXA Support Assistant. I can help answer questions about our AI tools, credit packages (Lite, Pro, Max, Ultra with 20% annual discount), platform features, and account setup. For complex queries or direct account assistance, feel free to click 'Talk to Human' to reach Maaz and our team!";
    }

    bindSafe(aiForm, 'submit', async event => {
        event.preventDefault();
        const message = aiInput.value.trim();
        if (!message || aiBusy) return;
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            addAiMessage('⚠️ You appear to be offline. Please check your internet connection and try again.');
            return;
        }
        aiBusy = true;
        aiSend.disabled = true;
        aiInput.disabled = true;
        addAiMessage(message, true);
        aiInput.value = '';
        const typing = addAiMessage('Connecting to Jevexa Support AI…');
        let controller = null;
        let timeoutId = null;
        try {
            controller = new AbortController();
            timeoutId = window.setTimeout(() => controller.abort(), 20000);
            const response = await fetch('/api/support/ai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, history: aiHistory.slice(-6) }),
                signal: controller.signal
            });
            const result = await response.json().catch(() => ({}));
            typing.remove();
            const reply = (typeof result?.reply === 'string' && result.reply.trim())
                ? result.reply.trim()
                : generateClientSupportReply(message);
            addAiMessage(reply);
            aiHistory.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
            if (aiHistory.length > 12) aiHistory.splice(0, aiHistory.length - 12);
        } catch (error) {
            typing.remove();
            console.warn('Support AI request failed, serving fallback:', error);
            const fallback = generateClientSupportReply(message);
            addAiMessage(fallback);
            aiHistory.push({ role: 'user', content: message }, { role: 'assistant', content: fallback });
            if (aiHistory.length > 12) aiHistory.splice(0, aiHistory.length - 12);
        } finally {
            if (timeoutId !== null) window.clearTimeout(timeoutId);
            aiBusy = false;
            aiSend.disabled = false;
            aiInput.disabled = false;
            aiInput.focus();
        }
    });

    bindSafe(document.getElementById('supportHumanButton'), 'click', () => {
        document.getElementById('supportAiPhase').hidden = true;
        document.getElementById('supportHumanButton').hidden = true;
        document.getElementById('supportConnecting').hidden = false;
        connectingTimer = window.setTimeout(async () => {
            connectingTimer = null;
            const connectingEl = document.getElementById('supportConnecting');
            if (connectingEl) connectingEl.hidden = true;
            await prefillTicketForm();
            form.hidden = false;
            document.getElementById('supportName')?.focus();
        }, 2000);
    });

    bindSafe(form, 'submit', async event => {
        event.preventDefault();
        if (ticketBusy) return;
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            setTicketStatus('You appear to be offline. Please check your connection and try again.', 'error');
            return;
        }
        
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = 'Sending…';
        }
        setTicketStatus('Sending your message…', 'pending');
        ticketBusy = true;
        let controller = null;
        let timeoutId = null;
        let response = null;
        let lastError = null;
        
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                controller = new AbortController();
                timeoutId = window.setTimeout(() => controller.abort(), 15000);
                try {
                    response = await fetch('/api/support-ticket', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: document.getElementById('supportName')?.value || '',
                            email: document.getElementById('supportEmail')?.value || '',
                            message: document.getElementById('supportMessage')?.value || ''
                        }),
                        signal: controller.signal
                    });
                    lastError = null;
                    if (response.ok || (response.status >= 400 && response.status < 500)) {
                        break;
                    }
                    if (attempt === 0 && [502, 503, 504].includes(response.status)) {
                        await new Promise(r => setTimeout(r, 600));
                        continue;
                    }
                    break;
                } catch (err) {
                    lastError = err;
                    if (err?.name === 'AbortError') throw err;
                    if (attempt === 0) {
                        await new Promise(r => setTimeout(r, 600));
                        continue;
                    }
                    throw err;
                } finally {
                    if (timeoutId !== null) window.clearTimeout(timeoutId);
                    timeoutId = null;
                }
            }
            if (!response && lastError) throw lastError;
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.success !== true || typeof result.ticketId !== 'string') {
                const ticketReference = typeof result.ticketId === 'string' ? ` Ticket reference: ${result.ticketId}.` : '';
                throw new Error(`${result.error || 'Your support request could not be submitted.'}${ticketReference}`);
            }
            form.hidden = true;
            document.getElementById('supportSuccess').hidden = false;
            setTicketStatus(`Message sent. Ticket ${result.ticketId} was saved and Maaz was notified.`, 'success');
        } catch (error) {
            console.error('Support ticket submission failed:', error);
            setTicketStatus(
                error?.name === 'AbortError'
                    ? 'This request took too long. Please check your connection and try again.'
                    : error?.message || 'Your support request could not be submitted. Please try again.',
                'error'
            );
        } finally {
            if (timeoutId !== null) window.clearTimeout(timeoutId);
            ticketBusy = false;
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = 'Send & Notify Maaz';
            }
        }
    });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSupportModal);
    } else {
        initSupportModal();
    }
})();
