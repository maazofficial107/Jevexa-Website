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

    function sanitizeSupportText(raw) {
        if (typeof window.JEVEXA_SANITIZE_MARKDOWN_TEXT === 'function') {
            raw = window.JEVEXA_SANITIZE_MARKDOWN_TEXT(raw, { keepHr: false });
        }
        let text = String(raw || '').replace(/\r\n?/g, '\n');
        text = text.replace(/\*{3}([^*\n]+?)\*{3}/g, '**$1**');
        text = text.replace(/^[ \t]*(?:\*{3,}|-{3,}|_{3,})[ \t]*$/gm, '');
        text = text.replace(/(^|\s)\*{3,}(?=\s|$)/gm, '$1');
        text = text.replace(/\*{3,}/g, '');
        text = text.replace(/^[ \t]*#{1,4}[ \t]+(.+)$/gm, '**$1**');
        text = text.replace(/^[ \t]*[-*][ \t]+/gm, '• ');
        return text.replace(/\n{3,}/g, '\n\n').trim();
    }

    function appendFormattedSupportText(parent, text) {
        const cleanText = sanitizeSupportText(text);
        const lines = cleanText.split(/\n/);
        lines.forEach((line, lineIdx) => {
            if (lineIdx > 0) parent.appendChild(document.createElement('br'));
            const tokenPattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\/(?:pricing|refund-policy|about|contact|terms|privacy-policy)\b|hello@jevexa\.net)/g;
            let lastIndex = 0;
            let match;
            while ((match = tokenPattern.exec(line)) !== null) {
                if (match.index > lastIndex) {
                    parent.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
                }
                const tok = match[0];
                if (tok.startsWith('**') && tok.endsWith('**')) {
                    const strong = document.createElement('strong');
                    strong.textContent = tok.slice(2, -2);
                    parent.appendChild(strong);
                } else if (tok.startsWith('*') && tok.endsWith('*') && tok.length > 2) {
                    const em = document.createElement('em');
                    em.textContent = tok.slice(1, -1);
                    parent.appendChild(em);
                } else if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
                    const code = document.createElement('code');
                    code.className = 'support-inline-code';
                    code.textContent = tok.slice(1, -1);
                    parent.appendChild(code);
                } else if (tok === 'hello@jevexa.net') {
                    const link = document.createElement('a');
                    link.href = 'mailto:hello@jevexa.net';
                    link.textContent = tok;
                    link.style.cssText = 'color:#22d3ee; text-decoration:underline;';
                    parent.appendChild(link);
                } else if (tok.startsWith('/')) {
                    const link = document.createElement('a');
                    link.href = tok;
                    link.textContent = tok;
                    link.style.cssText = 'color:#22d3ee; text-decoration:underline;';
                    parent.appendChild(link);
                }
                lastIndex = tokenPattern.lastIndex;
            }
            if (lastIndex < line.length) {
                parent.appendChild(document.createTextNode(line.slice(lastIndex)));
            }
        });
    }

    function addAiMessage(text, user = false) {
        const message = document.createElement('p');
        message.className = `support-ai-message${user ? ' user' : ''}`;
        message.style.whiteSpace = 'pre-line';
        if (user) {
            message.textContent = text;
        } else {
            appendFormattedSupportText(message, text);
        }
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
        const raw = String(userMessage || '').trim();
        const q = raw.toLowerCase();
        if (/\b(?:kya|kaise|kese|hai|hain|hoon|mujhe|batao|samjhao|karo|krdo|kar\s+do|shukriya|salam|bhai|madad)\b/i.test(q)) {
            if (/price|pricing|plan|pro|max|ultra|lite|cost|kharch|kitna/i.test(q)) {
                return "JEVEXA ke 5 transparent plans hain (20% annual discount ke saath):\n• **Free ($0):** 100 welcome credits, Core Engine (1.0x)\n• **Lite ($5/mo):** 2,500 credits/mo, Pro Engine (3.0x), PDF/ZIP uploads\n• **Pro ($15/mo):** 10,000 credits/mo, Low/Medium thinking, Web Search (15/day)\n• **Max ($29/mo):** 22,000 credits/mo, Deep Reasoning (18.0x), High thinking, Web Search (50/day)\n• **Ultra ($49/mo):** 40,000 credits/mo, Ultra Reasoning, Web Search (150/day)\nDetails ke liye /pricing dekhein ya 'Talk to Human Agent' click karein.";
            }
            if (/credit|token|balance|refund/i.test(q)) {
                return "Naye accounts ko **100 free welcome credits** milte hain. AI Chat token-weighted billing use karta hai (Core 1.0x, Pro 3.0x, Deep Reasoning 18.0x; Web Search +5 cr; Image +2 / PDF +4 / ZIP +5). **7-day refund policy** (/refund-policy) <10% usage par laagu hoti hai.";
            }
            if (/tool|feature|ocr|crm|content|social|analytics|workflow/i.test(q)) {
                return "JEVEXA AI Studio mein **10 live business tools** shamil hain: AI Chat, Content Generation, Email & Outreach AI, Mini CRM, Document AI & OCR, Social Media Assistant, Business Analytics, Team Admin, Workflow Automation, aur Data Management.";
            }
            return "Assalam-o-Alaikum! Main JEVEXA Support Assistant hoon. Aap mujhse pricing (/pricing), 100 free credits, 10 AI tools, Web Search ya Thinking levels ke baare mein pooch sakte hain. Agar account issue ho toh 'Talk to Human Agent' par click karein.";
        }
        if (/^(?:hi|hello|hey|aoa|salam|good\s+(?:morning|afternoon|evening))\b[!.?]*$/i.test(raw)) {
            return "Hello! Welcome to JEVEXA Support. How can I help you today? Feel free to ask about our plans (/pricing), credits, any of our 10 AI tools, or account troubleshooting.";
        }
        if (/offline|connect|network|internet|connection/i.test(q)) {
            return "Every JEVEXA workspace monitors your live connection status (`Online` / `Offline`).\n• If your connection drops, workspaces immediately switch to **Offline** and pause cloud requests so no credits are wasted.\n• Once your internet reconnects, status switches back to **Online** automatically.";
        }
        if (/reconcil|stuck|hold|held|awaiting safe|locked|unlock/i.test(q)) {
            return "If a credit reservation is ever held after an interrupted request:\n• Stale pending holds older than **15–30 seconds** release automatically and return credits to your wallet.\n• Click **Talk to Human Agent** below if you need manual account assistance.";
        }
        if (/refund|cancel|money\s*back/i.test(q)) {
            return "All JEVEXA credit packages are **one-time purchases** (no auto-renewal).\n• Eligible for a full refund within **7 days** if less than **10%** of credits are consumed.\n• Read full details at /refund-policy or click **Talk to Human Agent**.";
        }
        if (/\bpro\b.*(?:cost|price|pricing|much|include)|(?:cost|price|pricing).*\bpro\b/i.test(q)) {
            return "The **Pro Plan** is **$15/mo** (or **$12/mo** billed annually at **$144/yr**, saving 20%):\n• **10,000 credits/month** across all 10 AI Studio tools\n• **Core Engine (1.0x)** & **Pro Engine (3.0x)** unlocked\n• **Low & Medium Thinking** modes + **Images, PDF & ZIP** uploads\n• **Live Web Search** (15 requests/day, +5 credits/request)\nCompare all plans at /pricing.";
        }
        if (/\b(tools?|features?|capabilities|ocr|crm|content|social|analytics|workflow)\b/i.test(q)) {
            return "JEVEXA AI Studio includes **10 live business tools**: AI Chat, Content Generation, Email & Outreach AI, Mini CRM, Document AI & OCR, Social Media Assistant, Business Analytics, Team Admin, Workflow Automation, and Data Management. Test them right now with your **100 free credits**!";
        }
        if (/price|pricing|\bplans?\b|ultra|pro|lite|max|annual|discount|subscription|buy|checkout|safepay/i.test(q)) {
            return "JEVEXA offers 5 transparent plans with an automatic **20% annual discount** (one-time purchases, no auto-renewal):\n• **Free ($0):** 100 welcome credits, Core Engine (1.0x), Thinking OFF\n• **Lite ($5/mo · $48/yr):** 2,500 credits/month, Pro Engine (3.0x), PDF & ZIP uploads\n• **Pro ($15/mo · $144/yr):** 10,000 credits/month, Low/Medium Thinking, Live Web Search (15/day)\n• **Max ($29/mo · $278.40/yr):** 22,000 credits/month, Deep Reasoning (18.0x), High Thinking, Web Search (50/day)\n• **Ultra ($49/mo · $470.40/yr):** 40,000 credits/month, Ultra Reasoning priority, Max Thinking, Web Search (150/day)\nVisit /pricing to compare or click **Talk to Human Agent**!";
        }
        if (/credit|token|balance|cost|quota|rate limit|welcome/i.test(q)) {
            return "JEVEXA includes **100 free welcome credits** (no card required), and every output shows **Used credit** and **Remaining credit** right underneath.\n• **Engines:** Core (1.0x), Pro (3.0x), Deep Reasoning (18.0x)\n• **Add-ons:** Web Search (+5 cr/req), Image (+2 cr), PDF (+4 cr), ZIP (+5 cr)\nProtected by our **7-day refund policy** (/refund-policy) when <10% of credits are consumed.";
        }
        if (/think|reasoning|model|search|upload|attachment|pdf|zip|file/i.test(q)) {
            return "Here is how JEVEXA engines, thinking, search, and uploads work:\n• **Engines:** Core (1.0x, Free+), Pro (3.0x, Lite+), Deep/Ultra Reasoning (18.0x, Max/Ultra)\n• **Thinking Mode:** Off on Free/Lite · Low/Medium on Pro · High/Max on Max & Ultra\n• **Live Web Search:** 15/day on Pro, 50/day on Max, 150/day on Ultra (+5 cr/req)\n• **Uploads:** Free allows 5 images (5 MB); Lite+ unlocks PDF & ZIP archives.";
        }
        if (/human|agent|support|maaz|contact|ticket|email|phone|call/i.test(q)) {
            return "Our team is happy to help! **Email Support:** Response within 24 hours (Mon–Sat).\n• Click **Talk to Human Agent** below to submit a ticket directly.\n• Or reach us anytime at hello@jevexa.net.";
        }
        if (/login|signin|sign in|signup|sign up|register|account|password|forgot/i.test(q)) {
            return "To sign in or create an account:\n• Click **Get Started** or **Login** in the top-right navigation bar.\n• New accounts receive **100 free welcome credits** right away.\n• Use **Forgot password?** in the login dialog if you need a reset.";
        }
        return "Happy to help! Ask me about JEVEXA plans (/pricing), credit rates, Web Search & Thinking modes, file uploads, or any of our 10 AI tools—or click **Talk to Human Agent** for direct account support.";
    }

    function isCurrentlyOffline() {
        if (window.JEVEXA_CONNECTIVITY && typeof window.JEVEXA_CONNECTIVITY.isOnline === 'function') {
            return !window.JEVEXA_CONNECTIVITY.isOnline();
        }
        return typeof navigator !== 'undefined' && !navigator.onLine;
    }

    bindSafe(aiForm, 'submit', async event => {
        event.preventDefault();
        const message = aiInput.value.trim();
        if (!message || aiBusy) return;
        if (isCurrentlyOffline()) {
            addAiMessage('⚠️ You are currently offline. Please check your internet connection and try again.');
            return;
        }
        aiBusy = true;
        aiSend.disabled = true;
        aiInput.disabled = true;
        addAiMessage(message, true);
        aiInput.value = '';
        const typing = addAiMessage('Thinking…');
        let controller = null;
        let timeoutId = null;
        try {
            controller = new AbortController();
            timeoutId = window.setTimeout(() => controller.abort(), 12000);
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
        if (isCurrentlyOffline()) {
            setTicketStatus('You are currently offline. Please check your connection and try again.', 'error');
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
