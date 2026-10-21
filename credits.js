/* Authenticated credit controls for the existing JEVEXA account and chatbot UI. */
(function () {
    const input = document.getElementById('chatInput');
    const sendButton = document.getElementById('chatSend');
    const messages = document.getElementById('chatMessages');
    const status = document.getElementById('chatCreditStatus');
    const upgradeLink = document.getElementById('chatCreditUpgrade');
    let sending = false;
    let ambiguousRequestId = null;

    function setStatus(message, showUpgrade = false) {
        if (status) status.textContent = message;
        if (upgradeLink) upgradeLink.hidden = !showUpgrade;
    }

    async function refreshDisplayedCredits() {
        try {
            await window.JEVEXA_SETTINGS?.refreshCredits?.();
        } catch (error) {
            console.error('Credit balance refresh failed:', error);
        }
    }

    function appendMessage(text, user = false) {
        if (!messages) return;
        const row = document.createElement('div');
        row.className = `message ${user ? 'user' : 'bot'}`;
        const avatar = document.createElement('div');
        avatar.className = 'msg-avatar';
        const icon = document.createElement('i');
        icon.className = `fas fa-${user ? 'user' : 'wand-magic-sparkles'}`;
        avatar.appendChild(icon);
        const content = document.createElement('div');
        content.className = 'msg-content';
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        content.appendChild(paragraph);
        row.append(avatar, content);
        messages.appendChild(row);
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
        } catch (error) {
            console.error('Could not persist pending credit request:', error);
            setStatus(`Request ${requestId} may still be processing. Keep this page open and check your balance/history before retrying.`);
        }
    }

    function forgetPendingRequest(session) {
        ambiguousRequestId = null;
        try {
            localStorage.removeItem(pendingRequestKey(session.user.id));
        } catch (error) {
            console.error('Could not clear pending credit request:', error);
        }
    }

    async function reconcilePendingRequest(session) {
        let requestId = ambiguousRequestId;
        try {
            requestId ||= localStorage.getItem(pendingRequestKey(session.user.id));
        } catch (error) {
            console.error('Could not read pending credit request:', error);
        }
        if (!requestId) return false;

        ambiguousRequestId = requestId;
        const { data, error } = await supabaseClient
            .from('credit_reservations')
            .select('status,reserved_credits,charged_credits')
            .eq('user_id', session.user.id)
            .eq('request_id', requestId)
            .maybeSingle();
        if (error) {
            setStatus(`Could not verify whether request ${requestId} is still holding credits. Do not retry until your account history is available.`);
            return true;
        }
        if (!data) {
            forgetPendingRequest(session);
            setStatus('No credit reservation was recorded for the previous request. It is safe to retry.');
            await refreshDisplayedCredits();
            return false;
        }
        if (data.status === 'reserved') {
            setStatus(`Request ${requestId} is still awaiting safe reconciliation (${data.reserved_credits} credits held). Do not submit another paid request yet.`);
            return true;
        }
        if (data.status === 'settled' || data.status === 'released') {
            const status = data.status === 'settled'
                ? `settled for ${data.charged_credits} credits`
                : 'released; its reserved credits were returned';
            forgetPendingRequest(session);
            setStatus(`Previous request ${status}. Your wallet and history have been refreshed.`);
            await refreshDisplayedCredits();
            return false;
        }
        setStatus(`Request ${requestId} has an unrecognized credit state. Do not retry until support reconciles it.`);
        return true;
    }

    async function requestJson(url, session, options = {}) {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
                ...(options.headers || {})
            }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error || 'The request could not be completed.');
            error.status = response.status;
            error.payload = payload;
            throw error;
        }
        return payload;
    }

    async function handleSend() {
        if (sending) return;
        const text = input?.value.trim();
        if (!text) return;

        sending = true;
        if (sendButton) sendButton.disabled = true;
        if (input) input.disabled = true;
        setStatus('Checking sign-in and current AI usage estimate…');

        try {
            const session = await getSession();
            if (!session) {
                setStatus('Please sign in to use the AI chatbot.');
                openLogin();
                return;
            }
            if (await reconcilePendingRequest(session)) return;

            const chatPayload = { message: text };
            const quote = await requestJson('/api/credits/quote', session, {
                method: 'POST',
                body: JSON.stringify(chatPayload)
            });

            const { data: wallet, error: walletError } = await supabaseClient
                .from('user_credits')
                .select('balance')
                .eq('user_id', session.user.id)
                .maybeSingle();
            if (walletError || !wallet) throw new Error('Could not confirm your current credit balance. Please retry.');

            if (Number(wallet.balance) < quote.estimatedCredits) {
                setStatus(`This request may reserve up to ${quote.estimatedCredits} credits; your available balance is ${wallet.balance}. Choose a plan to continue.`, true);
                appendMessage(`Not enough credits for this request. Up to ${quote.estimatedCredits} credits may be needed; your balance is ${wallet.balance}.`);
                return;
            }

            setStatus(`Up to ${quote.estimatedCredits} credits will be reserved. You are charged only for confirmed AI usage.`);
            appendMessage(text, true);
            input.value = '';
            showTyping();
            const requestId = createRequestId();

            try {
                const result = await requestJson('/api/chat', session, {
                    method: 'POST',
                    headers: { 'Idempotency-Key': requestId },
                    body: JSON.stringify({ ...chatPayload, requestId })
                });
                removeTyping();
                appendMessage(result.reply);
                setStatus(
                    result.usageEstimated
                        ? `AI reply completed. ${result.creditsCharged} credits charged using the conservative estimate; balance ${result.creditsRemaining}.`
                        : `AI reply completed. ${result.creditsCharged} credits charged for ${result.totalTokens} measured tokens; balance ${result.creditsRemaining}.`
                );
                await refreshDisplayedCredits();
            } catch (error) {
                removeTyping();
                await refreshDisplayedCredits();
                if (!Number.isInteger(error.status)) {
                    rememberPendingRequest(session, requestId);
                    setStatus(`Connection was interrupted. Request ${requestId} may still be processing; do not resubmit it with a new request.`);
                } else if (error.status === 402) {
                    setStatus(error.message, true);
                    appendMessage(error.message);
                } else if (error.payload?.requestId && /reservation.*held/i.test(error.message)) {
                    rememberPendingRequest(session, requestId);
                    setStatus(`${error.message} Request ${requestId} is held for reconciliation.`);
                    appendMessage(error.message);
                } else if (error.status === 409 && error.payload?.status === 'reserved') {
                    rememberPendingRequest(session, requestId);
                    setStatus(`Request ${requestId} is still processing. Do not submit it again.`);
                } else {
                    setStatus(error.message, error.status === 402);
                    appendMessage(error.message);
                }
            }
        } catch (error) {
            setStatus(error?.message || 'Unable to check credits right now.');
        } finally {
            sending = false;
            if (sendButton) sendButton.disabled = false;
            if (input) input.disabled = false;
            input?.focus();
        }
    }

    document.addEventListener('click', event => {
        const button = event.target.closest('#chatSend, #chatSuggestions .suggestion');
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (button.matches('.suggestion') && input) input.value = button.textContent.trim();
        handleSend();
    }, true);

    document.addEventListener('keydown', event => {
        if (event.target !== input || event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        handleSend();
    }, true);

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
