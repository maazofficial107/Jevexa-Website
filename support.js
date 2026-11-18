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
            if (!response.ok || typeof result.reply !== 'string' || !result.reply.trim()) {
                throw new Error(result.error || 'Support AI is temporarily unavailable. Please talk to a human agent.');
            }
            addAiMessage(result.reply);
            aiHistory.push({ role: 'user', content: message }, { role: 'assistant', content: result.reply });
            if (aiHistory.length > 12) aiHistory.splice(0, aiHistory.length - 12);
        } catch (error) {
            typing.remove();
            console.error('Support AI request failed:', error);
            addAiMessage(error?.name === 'AbortError'
                ? 'Support AI took too long to respond. Please talk to a human agent.'
                : error?.message || 'Support AI could not connect. Please talk to a human agent.');
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
