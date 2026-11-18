(function () {
    const bindSafe = (target, type, handler, options) => {
        if (window.JEVEXA_SAFE_INTERACTION?.bind) {
            window.JEVEXA_SAFE_INTERACTION.bind(target, type, handler, options);
        } else {
            target?.addEventListener(type, handler, options?.listenerOptions);
        }
    };
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
            return "JEVEXA AI Studio features 10 business tools: AI Chat and Content Generation are live today! The remaining 8 tools (Email & Outreach AI, Mini CRM, Document AI & OCR, Social Media Assistant, Business Analytics, User & Admin Management, Workflow Automation, and Data Management) are rolling out across upcoming releases. You can test live tools right now with your 100 free credits, or click 'Talk to Human' for custom support.";
        }
        if (/price|pricing|\bplans?\b|ultra|pro|lite|max|annual|discount|subscription|buy|checkout|safepay/i.test(q)) {
            return "JEVEXA offers 4 scalable plans with an automatic 20% annual package discount:\n• Lite: $5/mo ($4/mo annual, $48 paid once) — 2,000 monthly credits (24,000 annual), Lite AI chat (1 credit/msg)\n• Pro: $12/mo ($9.60/mo annual, $115.20 paid once) — 10,000 monthly credits (120,000 annual), Pro AI chat (2 credits/msg), PDF & ZIP uploads, Standard thinking\n• Max: $25/mo ($20/mo annual, $240 paid once) — 30,000 monthly credits (360,000 annual), Max AI chat (4 credits/msg), Max deep reasoning\n• Ultra: $49/mo ($39.20/mo annual, $470.40 paid once) — 70,000 monthly credits (840,000 annual), Ultra AI chat (8 credits/msg), flagship models & priority queue.\nAll credit packages are one-time purchases via Safepay, never recurring subscriptions. Check out our #pricing section or click 'Talk to Human'!";
        }
        if (/credit|token|balance|cost|quota|rate limit|welcome/i.test(q)) {
            return "JEVEXA includes 100 free welcome credits upon sign-up (no credit card required). AI Chat costs a fixed rate per message by tier:\n• Lite: 1 credit per message (Low thinking)\n• Pro: 2 credits per message (Standard thinking, PDF/ZIP uploads)\n• Max: 4 credits per message (Max deep reasoning)\n• Ultra: 8 credits per message (Flagship models, priority queue)\nVariable services like Content Generation use transparent provider-metered credits based on token length. Credit packages are one-time top-ups, not recurring subscriptions. Click 'Talk to Human' if you need account-specific credit adjustments.";
        }
        if (/think|reasoning|model|upload|attachment|pdf|zip|file/i.test(q)) {
            return "JEVEXA AI Chat provides tailored models and capabilities across tiers:\n• Thinking Levels: Lite includes Low thinking; Pro includes Standard thinking; Max and Ultra unlock full Deep Reasoning (Max thinking).\n• File Uploads: Lite supports images (JPEG, PNG, WebP, GIF); Pro, Max, and Ultra support both images and document suites (PDF & ZIP files under 5 MB).\nUpgrade to Pro or higher from the chat model dropdown or #pricing section to unlock multi-file analysis!";
        }
        if (/tool|feature|capabilities|model|ocr|crm|email|content|social|analytics|workflow/i.test(q)) {
            return "JEVEXA AI Studio features 10 business tools: AI Chat and Content Generation are live today! The remaining 8 tools (Email & Outreach AI, Mini CRM, Document AI & OCR, Social Media Assistant, Business Analytics, User & Admin Management, Workflow Automation, and Data Management) are rolling out across upcoming releases. You can test live tools right now with your 100 free credits, or click 'Talk to Human' for custom support.";
        }
        if (/human|agent|support|maaz|contact|ticket|email|phone|call/i.test(q)) {
            return "You can connect with our human support team directly! Click the 'Talk to Human' button in this dialog to submit a ticket that alerts Maaz and our engineering team immediately, or reach us at maazofficial107@gmail.com.";
        }
        if (/login|signin|sign in|signup|sign up|register|account|password|forgot/i.test(q)) {
            return "You can sign up or sign in using the 'Get Started' or 'Sign In' button at the top right of the page. Once signed in, your account receives 100 free welcome credits immediately to use across AI Chat and Content Generation. If you forgot your password, use the 'Forgot password?' link in the login dialog.";
        }
        if (/^(hi|hello|hey|greetings|howdy|salam|aoa)\b/i.test(q)) {
            return "Hello! I am the JEVEXA Support Assistant. I can help answer questions about our AI tools (AI Chat & Content Generation), credit costs (1/2/4/8 credits per message), pricing plans (Lite, Pro, Max, Ultra with 20% annual discount), or account setup. You can also click 'Talk to Human' to reach Maaz directly!";
        }
        return "Hello! I am the JEVEXA Support Assistant. I can help answer questions about our AI tools, credit packages (Lite, Pro, Max, Ultra with 20% annual discount), platform features, and account setup. For complex queries or direct account assistance, feel free to click 'Talk to Human' to reach Maaz and our team!";
    }

    bindSafe(aiForm, 'submit', async event => {
        event.preventDefault();
        const message = aiInput.value.trim();
        if (!message || aiBusy) return;
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
            document.getElementById('supportConnecting').hidden = true;
            await prefillTicketForm();
            form.hidden = false;
            document.getElementById('supportName').focus();
        }, 2000);
    });

    bindSafe(form, 'submit', async event => {
        event.preventDefault();
        if (ticketBusy) return;
        
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = 'Sending…';
        }
        setTicketStatus('Sending your message…', 'pending');
        ticketBusy = true;
        let controller = null;
        let timeoutId = null;
        
        try {
            controller = new AbortController();
            timeoutId = window.setTimeout(() => controller.abort(), 15000);
            const response = await fetch('/api/support-ticket', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: document.getElementById('supportName').value,
                    email: document.getElementById('supportEmail').value,
                    message: document.getElementById('supportMessage').value
                }),
                signal: controller.signal
            });
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

})();
