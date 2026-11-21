(() => {
    const bindSafe = (target, type, handler, options) => {
        if (window.JEVEXA_SAFE_INTERACTION?.bind) {
            window.JEVEXA_SAFE_INTERACTION.bind(target, type, handler, options);
        } else {
            target?.addEventListener(type, handler, options?.listenerOptions);
        }
    };
    const form = document.getElementById('contentForm');
    const topicInput = document.getElementById('contentTopic');
    const typeInput = document.getElementById('contentType');
    const toneInput = document.getElementById('contentTone');
    const lengthInput = document.getElementById('contentLength');
    const generateButton = document.getElementById('contentGenerate');
    const status = document.getElementById('contentStatus');
    const output = document.getElementById('contentOutput');
    const copyButton = document.getElementById('contentCopy');
    const downloadButton = document.getElementById('contentDownload');

    if (!form || !topicInput || !typeInput || !toneInput || !lengthInput
        || !generateButton || !status || !output || !copyButton || !downloadButton) {
        return;
    }

    let requestInFlight = false;

    function setStatus(message, state = 'info') {
        status.textContent = message;
        status.dataset.state = state;
    }

    function pendingRequestKey(userId) {
        return `jevexa_${userId}_pending_content_request`;
    }

    function rememberPendingRequest(session, requestId) {
        if (!session?.user?.id) return false;
        try {
            localStorage.setItem(pendingRequestKey(session.user.id), requestId);
            return true;
        } catch (error) {
            console.error('Could not persist pending content request:', error);
            setStatus(`Request ${requestId} may still be processing. Keep this page open and check your balance before retrying.`, 'error');
            return false;
        }
    }

    function forgetPendingRequest(session, requestId) {
        if (!session?.user?.id) return;
        try {
            const key = pendingRequestKey(session.user.id);
            if (localStorage.getItem(key) === requestId) localStorage.removeItem(key);
        } catch (error) {
            console.error('Could not clear pending content request:', error);
        }
    }

    async function reconcilePendingRequest(session) {
        if (!session?.user?.id) return false;
        let requestId;
        try {
            requestId = localStorage.getItem(pendingRequestKey(session.user.id));
        } catch (error) {
            console.error('Could not read pending content request:', error);
            setStatus('Could not verify an earlier content request. Do not generate again until your account history is available.', 'error');
            return true;
        }
        if (!requestId) return false;

        let result;
        try {
            result = await supabaseClient
                .from('credit_reservations')
                .select('status,reserved_credits,charged_credits,created_at')
                .eq('user_id', session.user.id)
                .eq('request_id', requestId)
                .maybeSingle();
        } catch (error) {
            console.warn('Could not check pending content reservation:', error);
            return false;
        }
        if (result.error || !result.data) {
            forgetPendingRequest(session, requestId);
            setStatus('No active reservation is held for the previous request. You can generate content.');
            return false;
        }
        if (result.data.status === 'reserved') {
            const reservationTime = result.data.created_at ? new Date(result.data.created_at).getTime() : Date.now();
            const ageMs = Date.now() - reservationTime;
            if (ageMs > 15000) {
                try {
                    const recRes = await fetch('/api/credits/reconcile', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${session.access_token}`
                        },
                        body: JSON.stringify({ requestId })
                    });
                    const recData = await recRes.json().catch(() => ({}));
                    if (recData?.released) {
                        forgetPendingRequest(session, requestId);
                        setStatus(`Stale request ${requestId} was auto-reconciled (${result.data.reserved_credits} credits released). Ready to generate.`);
                        return false;
                    }
                } catch (recErr) {
                    console.warn('Content auto-reconciliation call:', recErr);
                }
                if (ageMs > 30000) {
                    forgetPendingRequest(session, requestId);
                    setStatus('Stale generation hold expired and was safely cleared.');
                    return false;
                }
            }
            try {
                const recRes = await fetch('/api/credits/reconcile', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${session.access_token}`
                    },
                    body: JSON.stringify({ requestId })
                });
                const recData = await recRes.json().catch(() => ({}));
                if (recData?.released) {
                    forgetPendingRequest(session, requestId);
                    setStatus(`Pending request ${requestId} was auto-reconciled (${result.data.reserved_credits} credits released). Ready to generate.`);
                    return false;
                }
            } catch (recErr) {
                console.warn('Content immediate auto-reconciliation call:', recErr);
            }
            forgetPendingRequest(session, requestId);
            setStatus('Previous generation hold cleared. Ready to generate.');
            return false;
        }
        if (result.data.status === 'settled' || result.data.status === 'released') {
            const previousStatus = result.data.status === 'settled'
                ? `settled for ${result.data.charged_credits} credits`
                : 'released; its reserved credits were returned';
            forgetPendingRequest(session, requestId);
            setStatus(`Previous request ${previousStatus}. Check your balance or generate again.`);
            return false;
        }
        forgetPendingRequest(session, requestId);
        return false;
    }

    function createRequestId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        if (window.crypto?.getRandomValues) {
            const bytes = new Uint8Array(16);
            window.crypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        throw new Error('Secure request IDs are unavailable. Please use a modern browser over HTTPS.');
    }

    async function getSession() {
        if (typeof supabaseClient === 'undefined' || !supabaseClient?.auth?.getSession) {
            throw new Error('Sign-in is unavailable right now. Please refresh the page and try again.');
        }
        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw new Error('Could not verify your session. Please sign in again.');
        return data?.session?.access_token ? data.session : null;
    }

    function responseError(response, payload) {
        if (response.status === 402) return payload?.error || 'You do not have enough credits to generate this content.';
        if (response.status === 429) return payload?.error || 'Content generation is busy. Please wait a moment and try again.';
        if (payload?.requestId && [502, 503, 504].includes(response.status)) {
            return `${payload.error || 'The request outcome could not be confirmed.'} Reference: ${payload.requestId}`;
        }
        return payload?.error || 'Content generation is temporarily unavailable. Please try again.';
    }

    let contentProcessingTimer = null;

    function showContentProcessing() {
        if (!output) return;
        output.innerHTML = `
            <div class="content-processing-container" role="status" aria-live="polite">
                <div class="live-status-indicator">
                    <div class="live-status-icon-wrap"><i class="fas fa-globe" id="liveContentIcon"></i></div>
                    <span class="live-status-text" id="liveContentStatusText">Searching the web...</span>
                    <div class="live-status-dots" aria-hidden="true"><span></span><span></span><span></span></div>
                </div>
                <div class="content-skeleton-lines" aria-hidden="true">
                    <div class="content-skeleton-bar"></div>
                    <div class="content-skeleton-bar"></div>
                    <div class="content-skeleton-bar"></div>
                    <div class="content-skeleton-bar"></div>
                </div>
            </div>
        `;

        const liveStates = [
            { text: 'Searching the web...', icon: 'fa-globe' },
            { text: 'Analyzing context & tone...', icon: 'fa-brain' },
            { text: 'Synthesizing & generating...', icon: 'fa-pen-nib' }
        ];
        let stateIdx = 0;
        if (contentProcessingTimer) clearInterval(contentProcessingTimer);
        contentProcessingTimer = setInterval(() => {
            stateIdx = (stateIdx + 1) % liveStates.length;
            const textEl = document.getElementById('liveContentStatusText');
            const iconEl = document.getElementById('liveContentIcon');
            if (textEl && iconEl) {
                textEl.classList.add('fade-out');
                setTimeout(() => {
                    textEl.textContent = liveStates[stateIdx].text;
                    iconEl.className = `fas ${liveStates[stateIdx].icon}`;
                    textEl.classList.remove('fade-out');
                    textEl.classList.add('fade-in');
                }, 180);
            }
        }, 1800);
    }

    function clearContentProcessing() {
        if (contentProcessingTimer) {
            clearInterval(contentProcessingTimer);
            contentProcessingTimer = null;
        }
    }
    window.clearContentProcessing = clearContentProcessing;

    function requestOutcomeIsUncertain(response, payload) {
        return Boolean(payload?.requestId && (
            (response.status === 409 && payload.status === 'reserved')
            || /held|uncertain|outcome could not be confirmed/i.test(payload.error || '')
        ));
    }

    bindSafe(form, 'submit', async event => {
        event.preventDefault();
        if (requestInFlight) return;

        const existingRetry = document.getElementById('contentRetryAction');
        if (existingRetry) existingRetry.remove();

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            setStatus('You are currently offline. Please check your internet connection before generating content.', 'error');
            if (typeof window.showToast === 'function') {
                window.showToast('You are currently offline. Please reconnect to generate content.');
            }
            return;
        }

        let session;
        try {
            session = await getSession();
        } catch (error) {
            setStatus(error?.message || 'Could not verify your session.', 'error');
            return;
        }
        if (!session) {
            if (typeof window.showToast === 'function') {
                window.showToast('Please create an account or sign in to use the Content Generator.');
            }
            setStatus('Please create an account or sign in to generate content.', 'info');
            if (typeof window.openAuthModal === 'function') {
                window.openAuthModal('signup');
            } else if (typeof window.openLogin === 'function') {
                window.openLogin();
            } else {
                setStatus('Sign-in is unavailable right now. Please try again later.', 'error');
            }
            return;
        }

        const countEl = document.getElementById('creditsCount');
        const cachedBalance = countEl ? parseInt(countEl.textContent, 10) : NaN;
        if (!isNaN(cachedBalance) && cachedBalance <= 0) {
            setStatus('You have 0 credits remaining. Please choose a plan or top up to generate content.', 'error');
            if (typeof window.JEVEXA_SHOW_UPGRADE_MODAL === 'function') {
                window.JEVEXA_SHOW_UPGRADE_MODAL('Pro', 'additional AI credits');
            } else if (typeof window.showToast === 'function') {
                window.showToast('You have 0 credits remaining. Please choose a plan to continue.');
            }
            return;
        }

        if (await reconcilePendingRequest(session)) return;

        let requestId;
        try {
            requestId = createRequestId();
        } catch (error) {
            setStatus(error.message, 'error');
            return;
        }

        const requestBody = {
            topic: topicInput.value.trim(),
            type: typeInput.value,
            tone: toneInput.value,
            length: lengthInput.value,
            requestId
        };
        requestInFlight = true;
        generateButton.disabled = true;
        copyButton.disabled = true;
        downloadButton.disabled = true;
        showContentProcessing();
        setStatus('Generating content…', 'info');
        rememberPendingRequest(session, requestId);

        try {
            let response;
            let lastFetchError = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                const contentController = new AbortController();
                const contentTimeoutId = setTimeout(() => contentController.abort(), 35000);
                try {
                    response = await fetch('/api/content', {
                        method: 'POST',
                        signal: contentController.signal,
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${session.access_token}`,
                            'Idempotency-Key': requestId
                        },
                        body: JSON.stringify(requestBody)
                    });
                    lastFetchError = null;
                    if (response.ok || (response.status >= 400 && response.status < 500)) {
                        break;
                    }
                    if (attempt === 0 && [502, 503, 504].includes(response.status)) {
                        await new Promise(r => setTimeout(r, 600));
                        continue;
                    }
                    break;
                } catch (fetchErr) {
                    lastFetchError = fetchErr;
                    if (fetchErr?.name === 'AbortError') throw fetchErr;
                    if (attempt === 0) {
                        await new Promise(r => setTimeout(r, 600));
                        continue;
                    }
                    throw fetchErr;
                } finally {
                    clearTimeout(contentTimeoutId);
                }
            }
            if (!response && lastFetchError) throw lastFetchError;
            let payload;
            try {
                payload = await response.json();
            } catch {
                throw new Error('The content service returned an invalid response. Please try again later.');
            }
            if (!response.ok) {
                clearContentProcessing();
                if (payload?.content && typeof payload.content === 'string' && payload.content.trim()) {
                    output.textContent = payload.content;
                    forgetPendingRequest(session, requestId);
                    copyButton.disabled = false;
                    downloadButton.disabled = false;
                    setStatus('Content generated successfully! (Credits will reconcile automatically).', 'success');
                    if (typeof window.JEVEXA_SETTINGS?.refreshCredits === 'function') {
                        try {
                            await window.JEVEXA_SETTINGS.refreshCredits();
                            window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
                        } catch { /* ignore */ }
                    }
                    return;
                }
                output.textContent = '';
                if (requestOutcomeIsUncertain(response, payload)) {
                    rememberPendingRequest(session, payload.requestId);
                    try {
                        const recRes = await fetch('/api/credits/reconcile', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${session.access_token}`
                            },
                            body: JSON.stringify({ requestId: payload.requestId || requestId })
                        });
                        const recData = await recRes.json().catch(() => ({}));
                        if (recData?.released) {
                            forgetPendingRequest(session, requestId);
                            setStatus('Previous reservation cleared. Ready to generate.', 'info');
                            return;
                        }
                    } catch (recErr) {
                        console.warn('Immediate content reconciliation notice:', recErr);
                    }
                } else {
                    forgetPendingRequest(session, requestId);
                }
                setStatus(responseError(response, payload), 'error');
                return;
            }
            const remaining = Number.isInteger(payload.remaining_credits)
                ? payload.remaining_credits
                : (Number.isInteger(payload.creditsRemaining) ? payload.creditsRemaining : null);
            const used = Number.isInteger(payload.credits_used)
                ? payload.credits_used
                : (Number.isInteger(payload.creditsCharged) ? payload.creditsCharged : null);

            if (typeof payload?.content !== 'string' || !payload.content.trim()
                || used === null || used < 1
                || remaining === null || remaining < 0) {
                throw new Error('The content response could not be verified. Please contact JEVEXA Support before retrying.');
            }

            clearContentProcessing();
            output.textContent = payload.content;
            let receipt = document.getElementById('contentCreditReceipt');
            if (!receipt) {
                receipt = document.createElement('div');
                receipt.id = 'contentCreditReceipt';
                receipt.className = 'content-credit-receipt';
                output.parentNode.appendChild(receipt);
            }
            receipt.innerHTML = `<span>⚡ Credits used: <strong>${used}</strong> &nbsp;•&nbsp; Remaining: <strong>${remaining}</strong></span>`;
            receipt.hidden = false;

            const retryContainer = document.getElementById('contentRetryAction');
            if (retryContainer) retryContainer.remove();

            forgetPendingRequest(session, requestId);
            copyButton.disabled = false;
            downloadButton.disabled = false;
            if (remaining !== null) {
                const countEl = document.getElementById('creditsCount');
                if (countEl) countEl.textContent = String(remaining);
                const settingsBal = document.getElementById('settingsBalance');
                if (settingsBal) settingsBal.textContent = String(remaining);
                window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
                window.JEVEXA_UPDATE_CREDIT_BALANCE?.(remaining);
            }
            let balanceMessage = '';
            if (typeof window.JEVEXA_SETTINGS?.refreshCredits === 'function') {
                try {
                    await window.JEVEXA_SETTINGS.refreshCredits();
                    window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
                } catch {
                    balanceMessage = ' Your displayed balance could not be refreshed.';
                }
            }
            setStatus(`Content generated. ${used} credits charged; ${remaining} remaining.${balanceMessage}`, 'success');
        } catch (error) {
            clearContentProcessing();
            output.textContent = '';
            forgetPendingRequest(session, requestId);
            const msg = error?.name === 'AbortError'
                ? 'The content request timed out. Please check your network and try again.'
                : (error?.message || 'The content request could not be completed.');
            setStatus(`${msg} Reference: ${requestId}`, 'error');
            let retryContainer = document.getElementById('contentRetryAction');
            if (!retryContainer && output?.parentNode) {
                retryContainer = document.createElement('div');
                retryContainer.id = 'contentRetryAction';
                retryContainer.className = 'content-retry-action';
                retryContainer.innerHTML = '<button type="button" class="btn btn-secondary retry-btn"><i class="fas fa-rotate-right"></i> Retry Generation</button>';
                output.parentNode.insertBefore(retryContainer, output.nextSibling);
                bindSafe(retryContainer.querySelector('button'), 'click', () => {
                    retryContainer.remove();
                    form.dispatchEvent(new Event('submit', { cancelable: true }));
                });
            }
        } finally {
            clearContentProcessing();
            requestInFlight = false;
            generateButton.disabled = false;
        }
    });

    bindSafe(copyButton, 'click', async () => {
        const text = output.textContent || '';
        if (!text) return;
        try {
            if (navigator.clipboard?.writeText && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
            } else {
                const temporaryInput = document.createElement('textarea');
                temporaryInput.value = text;
                temporaryInput.setAttribute('readonly', '');
                temporaryInput.style.position = 'fixed';
                temporaryInput.style.opacity = '0';
                document.body.appendChild(temporaryInput);
                let copied = false;
                try {
                    temporaryInput.select();
                    copied = document.execCommand('copy');
                } finally {
                    temporaryInput.remove();
                }
                if (!copied) throw new Error('Clipboard access was denied.');
            }
            setStatus('Content copied to your clipboard.', 'success');
        } catch {
            setStatus('Copy failed. Select the generated text and copy it manually.', 'error');
        }
    });

    bindSafe(downloadButton, 'click', () => {
        const text = output.textContent || '';
        if (!text) return;
        try {
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            link.href = objectUrl;
            link.download = `jevexa-content-${timestamp}.txt`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
            setStatus('Content downloaded as a text file.', 'success');
        } catch {
            setStatus('Download failed. Please copy the generated text instead.', 'error');
        }
    });

    window.JEVEXA_RECONCILE_CONTENT = async () => {
        try {
            const session = await getSession();
            if (session) {
                await reconcilePendingRequest(session);
            }
        } catch (_) {}
    };
})();
