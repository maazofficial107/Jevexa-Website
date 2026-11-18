/* JEVEXA PREMIUM JS v2.0 (guarded, reduced-motion aware) */
(function () {
    'use strict';
    const $ = (s, c) => (c || document).querySelector(s);
    const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));
    const motionOK = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches
        && !document.documentElement.classList.contains('jevexa-reduce-motion');
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const toast = (m) => { if (typeof showToast === 'function') showToast(m); };
    const bindSafe = (target, type, handler, options) => {
        if (window.JEVEXA_SAFE_INTERACTION?.bind) {
            window.JEVEXA_SAFE_INTERACTION.bind(target, type, handler, options);
        } else {
            target?.addEventListener(type, handler, options?.listenerOptions);
        }
    };
    const progress = $('#scrollProgress');
    const backTop = $('#backToTop');
    const orb = $('#aiOrb');
    let scrollTicking = false;
    function onScroll() {
        if (scrollTicking) return;
        scrollTicking = true;
        requestAnimationFrame(() => {
            const y = window.scrollY;
            const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
            if (progress) progress.style.width = (Math.min(1, y / max) * 100).toFixed(2) + '%';
            if (backTop) backTop.classList.toggle('visible', y > 600);
            if (orb && motionOK() && y < window.innerHeight * 1.5) orb.style.transform = 'translate3d(0,' + (y * 0.06).toFixed(1) + 'px,0)';
            scrollTicking = false;
        });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    bindSafe(backTop, 'click', () => window.scrollTo({ top: 0, behavior: motionOK() ? 'smooth' : 'auto' }));
    const glow = $('#cursorGlow');
    if (glow && finePointer && motionOK()) {
        let gx = innerWidth / 2, gy = innerHeight / 2, tx = gx, ty = gy, glowRaf = null;
        const loop = () => {
            gx += (tx - gx) * 0.12; gy += (ty - gy) * 0.12;
            glow.style.transform = 'translate(' + (gx - 170) + 'px,' + (gy - 170) + 'px)';
            if (Math.abs(tx - gx) > 0.5 || Math.abs(ty - gy) > 0.5) glowRaf = requestAnimationFrame(loop); else glowRaf = null;
        };
        document.addEventListener('mousemove', (e) => { tx = e.clientX; ty = e.clientY; glow.classList.add('visible'); if (!glowRaf) glowRaf = requestAnimationFrame(loop); }, { passive: true });
        document.addEventListener('mouseleave', () => glow.classList.remove('visible'));
    }
    if (finePointer && motionOK()) {
        $$('.tilt-card').forEach(card => {
            let raf = null;
            let r = null;
            card.addEventListener('pointerenter', () => {
                r = card.getBoundingClientRect();
            }, { passive: true });
            card.addEventListener('pointermove', (e) => {
                if (e.pointerType !== 'mouse' || raf) return;
                raf = requestAnimationFrame(() => {
                    if (!r) r = card.getBoundingClientRect();
                    const px = (e.clientX - r.left) / r.width - 0.5;
                    const py = (e.clientY - r.top) / r.height - 0.5;
                    card.style.transform = 'perspective(900px) rotateX(' + (-py * 5).toFixed(2) + 'deg) rotateY(' + (px * 5).toFixed(2) + 'deg) translateY(-4px)';
                    raf = null;
                });
            }, { passive: true });
            card.addEventListener('pointerleave', () => {
                r = null;
                if (raf) { cancelAnimationFrame(raf); raf = null; }
                card.style.transform = '';
            }, { passive: true });
        });
        $$('.btn-magnetic').forEach(btn => {
            let r = null;
            let raf = null;
            btn.addEventListener('pointerenter', () => {
                r = btn.getBoundingClientRect();
            }, { passive: true });
            btn.addEventListener('pointermove', (e) => {
                if (e.pointerType !== 'mouse' || raf) return;
                raf = requestAnimationFrame(() => {
                    if (!r) r = btn.getBoundingClientRect();
                    const dx = (e.clientX - r.left - r.width / 2) * 0.12;
                    const dy = (e.clientY - r.top - r.height / 2) * 0.25;
                    btn.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
                    raf = null;
                });
            }, { passive: true });
            btn.addEventListener('pointerleave', () => {
                r = null;
                if (raf) { cancelAnimationFrame(raf); raf = null; }
                btn.style.transform = '';
            }, { passive: true });
        });
    }
    bindSafe(document, 'click', (e) => {
        const btn = e.target.closest('.btn');
        if (!btn || !motionOK()) return;
        const r = btn.getBoundingClientRect();
        const span = document.createElement('span');
        const size = Math.max(r.width, r.height);
        span.className = 'px-ripple';
        span.style.width = span.style.height = size + 'px';
        span.style.left = (e.clientX - r.left - size / 2) + 'px';
        span.style.top = (e.clientY - r.top - size / 2) + 'px';
        btn.appendChild(span);
        setTimeout(() => span.remove(), 700);
    }, {
        matches: e => e.target instanceof Element && Boolean(e.target.closest('.btn')),
        getKey: e => e.target instanceof Element ? e.target.closest('.btn') || document : document,
        preventDefaultOnDebounce: false
    });
    setTimeout(() => { if (!window.AOS) document.documentElement.classList.add('aos-fallback'); }, 2500);
    const toastEl = $('#toast');
    if (toastEl && 'MutationObserver' in window) {
        new MutationObserver(() => {
            const t = (toastEl.textContent || '').trim();
            toastEl.classList.remove('toast-success', 'toast-error', 'toast-warning');
            if (/^[✓✔]/.test(t) || /success|saved|updated|sent|welcome|downloaded|subscribed/i.test(t)) toastEl.classList.add('toast-success');
            else if (/^[✕✖×]/.test(t) || /could not|failed|error|unavailable|went wrong/i.test(t)) toastEl.classList.add('toast-error');
            else if (/^[⚠]/.test(t) || /please|coming soon|launching soon/i.test(t)) toastEl.classList.add('toast-warning');
        }).observe(toastEl, { childList: true, characterData: true, subtree: true });
    }
    const pwToggle = $('#passwordToggle');
    const pwInput = $('#loginPassword');
    bindSafe(pwToggle, 'click', () => {
        if (!pwInput) return;
        const show = pwInput.type === 'password';
        pwInput.type = show ? 'text' : 'password';
        pwToggle.setAttribute('aria-pressed', String(show));
        pwToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        pwToggle.innerHTML = show ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
        pwInput.focus({ preventScroll: true });
    });
    bindSafe($('#forgotPasswordLink'), 'click', async (e) => {
        e.preventDefault();
        if (typeof supabaseClient === 'undefined' || !supabaseClient) { toast('Account features are temporarily unavailable.'); return; }
        const email = ($('#loginEmail')?.value || '').trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            if (typeof showAuthMessage === 'function') showAuthMessage('Enter your email address above first, then click "Forgot password".');
            $('#loginEmail')?.focus();
            return;
        }
        const link = e.currentTarget;
        link.style.pointerEvents = 'none'; link.textContent = 'Sending reset link…';
        try {
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
            if (error) { if (typeof showAuthMessage === 'function') showAuthMessage('Could not send the reset email. Please try again in a moment.'); }
            else if (typeof showAuthMessage === 'function') showAuthMessage('✓ Reset link sent! Check your inbox (and spam folder).', 'success');
        } catch { if (typeof showAuthMessage === 'function') showAuthMessage('Connection problem. Please try again.'); }
        finally { setTimeout(() => { link.style.pointerEvents = ''; link.textContent = 'Forgot password?'; }, 4000); }
    });
    $('#newsletterForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = $('#newsletterEmail');
        const email = (input?.value || '').trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('⚠ Please enter a valid email address.'); input?.focus(); return; }
        const btn = e.target.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try {
            if (typeof SUPABASE_URL === 'undefined' || !SUPABASE_URL || !SUPABASE_KEY) throw new Error('config');
            const res = await fetch(SUPABASE_URL + '/rest/v1/Contacts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, Prefer: 'return=minimal' },
                body: JSON.stringify({ name: 'Newsletter Subscriber', email, message: 'NEWSLETTER SIGNUP — please add me to product updates.' })
            });
            if (!res.ok) throw new Error('save');
            toast('✓ Subscribed! Welcome to the JEVEXA insider list.');
            if (input) input.value = '';
        } catch { toast('✕ Could not subscribe right now. Please try again later.'); }
        finally { if (btn) btn.disabled = false; }
    });
    try {
        const params = new URLSearchParams(window.location.search);
        const payment = params.get('payment');
        if (payment === 'return') {
            toast('✓ Payment return received. Credits appear automatically once the payment is confirmed.');
            setTimeout(() => { window.JEVEXA_SETTINGS?.refreshCredits?.(); }, 2500);
            params.delete('payment');
            history.replaceState(null, '', window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash);
        } else if (payment === 'cancelled') {
            toast('⚠ Checkout was cancelled. No charge was made.');
            params.delete('payment');
            history.replaceState(null, '', window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash);
        }
    } catch { /* noop */ }
    $('#contactForm')?.addEventListener('submit', (e) => {
        const hp = $('#contactWebsite');
        if (hp && hp.value) { e.stopImmediatePropagation(); e.preventDefault(); }
    }, true);
    const chatWin = $('#chatbotWindow');
    if (chatWin && 'MutationObserver' in window) {
        new MutationObserver(() => { if (chatWin.classList.contains('open')) setTimeout(() => $('#chatInput')?.focus({ preventScroll: true }), 250); }).observe(chatWin, { attributes: true, attributeFilter: ['class'] });
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && chatWin?.classList.contains('open')) chatWin.classList.remove('open'); });
    const yearEl = $('#year');
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();
