/* ===== JEVEXA Premium — Smooth Optimized Script ===== */

function reportInteractionError(error, message = 'That action could not be completed. Please try again.') {
    console.error('JEVEXA interaction failed:', error);
    try {
        if (typeof showToast === 'function') showToast(message);
    } catch (toastError) {
        console.error('Could not display the interaction error:', toastError);
    }
}

window.JEVEXA_SAFE_INTERACTION = {
    bind(target, type, handler, options = {}) {
        if (!target || typeof handler !== 'function') return;
        const states = new WeakMap();
        const debounceMs = Number.isFinite(options.debounceMs)
            ? Math.max(0, options.debounceMs)
            : type === 'click' || type === 'submit' ? 320 : 0;

        target.addEventListener(type, function (event) {
            let key;
            try {
                if (options.matches && !options.matches(event)) return;
                key = options.getKey?.(event)
                    || event.target?.closest?.('button, a, [role="button"], input[type="submit"]')
                    || event.currentTarget;
            } catch (error) {
                reportInteractionError(error, options.errorMessage);
                return;
            }
            if (!key || (typeof key !== 'object' && typeof key !== 'function')) key = target;

            const state = states.get(key) || { busy: false, lastStarted: 0 };
            const now = Date.now();
            if (state.busy || now - state.lastStarted < debounceMs) {
                if ((type === 'click' || type === 'submit') && options.preventDefaultOnDebounce !== false) {
                    event.preventDefault();
                }
                return;
            }

            state.busy = true;
            state.lastStarted = now;
            states.set(key, state);
            const release = () => { state.busy = false; };
            let result;
            try {
                result = handler.call(this, event);
            } catch (error) {
                release();
                reportInteractionError(error, options.errorMessage);
                return;
            }

            if (result && typeof result.then === 'function') {
                Promise.resolve(result)
                    .catch(error => reportInteractionError(error, options.errorMessage))
                    .finally(release);
            } else {
                release();
            }
        }, options.listenerOptions);
    }
};

let userInteracted = false;
window.addEventListener('pointerdown', () => { userInteracted = true; }, { once: true, passive: true });
window.addEventListener('keydown', () => { userInteracted = true; }, { once: true, passive: true });

window.addEventListener('error', event => {
    if (event?.error?.name === 'AbortError' || /ResizeObserver|aborted/i.test(event?.message || '')) return;
    if (userInteracted && event.error) reportInteractionError(event.error, 'Something went wrong. Please refresh and try again.');
    else console.warn('Unhandled runtime error:', event.error || event.message);
});
window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    if (reason?.name === 'AbortError' || /ResizeObserver|aborted/i.test(reason?.message || '')) return;
    if (userInteracted && event.reason) reportInteractionError(event.reason, 'Something went wrong. Please try that action again.');
    else console.warn('Unhandled promise rejection:', event.reason);
});
window.JEVEXA_SAFE_INTERACTION.bind(document, 'click', event => {
    const action = event.target instanceof Element
        ? event.target.closest('[data-jevexa-action]')?.dataset.jevexaAction
        : null;
    if (!action) return;
    event.preventDefault();
    if (action === 'close-login') closeLogin();
    else if (action === 'login-google') return loginWithGoogle();
    else if (action === 'login-github') return loginWithGithub();
    else if (action === 'toggle-auth-mode') toggleAuthMode();
}, {
    matches: event => event.target instanceof Element
        && Boolean(event.target.closest('[data-jevexa-action]')),
    getKey: event => event.target instanceof Element
        ? event.target.closest('[data-jevexa-action]') || document
        : document
});

function closeAllWorkspacesAndModals() {
    if (typeof closeChatbot === 'function') {
        closeChatbot();
    } else {
        const chatWin = document.getElementById('chatbotWindow');
        if (chatWin) {
            chatWin.classList.remove('open', 'chat-history-open');
            chatWin.setAttribute('aria-hidden', 'true');
        }
        const chatToggle = document.getElementById('chatbotToggle');
        if (chatToggle) {
            chatToggle.classList.remove('hidden');
            chatToggle.setAttribute('aria-hidden', 'false');
            chatToggle.setAttribute('aria-expanded', 'false');
            chatToggle.setAttribute('aria-label', 'Open Jevexa AI');
        }
        document.body.classList.remove('chat-modal-open');
    }
    const chatSidebar = document.getElementById('chatSidebar');
    if (chatSidebar) chatSidebar.classList.remove('open');

    const upgradeModal = document.getElementById('upgradeModal');
    if (upgradeModal) {
        upgradeModal.classList.remove('is-open');
        upgradeModal.hidden = true;
    }

    const supportModal = document.getElementById('supportModal');
    if (supportModal) supportModal.hidden = true;

    if (typeof closeLogin === 'function') {
        closeLogin();
    } else {
        const loginModal = document.getElementById('loginModal');
        if (loginModal) loginModal.classList.remove('open');
    }

    const accountBackdrop = document.getElementById('jevexaAccountBackdrop');
    if (accountBackdrop) accountBackdrop.style.display = 'none';

    if (typeof closeMobileMenu === 'function') closeMobileMenu();

    document.body.classList.remove('chat-modal-open', 'login-open', 'modal-open', 'menu-open');
    document.documentElement.classList.remove('login-open', 'menu-open');
    document.body.style.removeProperty('overflow');
    document.body.style.removeProperty('top');
    document.documentElement.style.removeProperty('overflow');
}
window.JEVEXA_CLOSE_ALL_WORKSPACES = closeAllWorkspacesAndModals;

function navigateToPricingAndHighlight(plan) {
    closeAllWorkspacesAndModals();
    const pricingSection = document.getElementById('pricing');
    if (!pricingSection) return;
    pricingSection.scrollIntoView({ behavior: 'smooth' });

    const normalized = String(plan || 'pro').toLowerCase().trim();
    const planKeyMap = {
        free: 'starter',
        welcome: 'starter',
        lite: 'starter',
        starter: 'starter',
        pro: 'pro',
        max: 'business',
        business: 'business',
        ultra: 'ultra'
    };
    const planKey = planKeyMap[normalized] || 'pro';
    setTimeout(() => {
        const card = document.querySelector(`.price-card[data-pricing-plan="${planKey}"]`);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.remove('pricing-card-highlight');
            void card.offsetWidth;
            card.classList.add('pricing-card-highlight');
            setTimeout(() => card.classList.remove('pricing-card-highlight'), 2600);
            card.querySelector('button')?.focus({ preventScroll: true });
        }
    }, 350);
}
window.JEVEXA_SCROLL_TO_PRICING = navigateToPricingAndHighlight;

function openUpgradeModal(plan, feature, returnFocusElement = document.activeElement) {
    const modal = document.getElementById('upgradeModal');
    if (!modal) {
        showToast(`Upgrade to ${plan} to unlock ${feature}.`);
        return;
    }
    const title = document.getElementById('upgradeModalTitle');
    const message = document.getElementById('upgradeModalMessage');
    const planLabel = document.getElementById('upgradeModalPlan');
    modal.returnFocusElement = returnFocusElement;
    modal.dataset.requiredPlan = (plan || 'pro').toLowerCase();
    if (title) title.textContent = `Unlock ${feature}`;
    if (message) message.textContent = `Upgrade to Jevexa ${plan} to unlock this feature and get more from your AI workspace.`;
    if (planLabel) planLabel.textContent = `JEVEXA ${plan.toUpperCase()}`;
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('is-open'));
    document.getElementById('upgradeModalClose')?.focus({ preventScroll: true });
}

function initializeUpgradeModal() {
    const modal = document.getElementById('upgradeModal');
    if (!modal) return;
    let closeTimer = null;
    const close = () => {
        modal.classList.remove('is-open');
        if (closeTimer !== null) window.clearTimeout(closeTimer);
        closeTimer = window.setTimeout(() => {
            modal.hidden = true;
            closeTimer = null;
            modal.returnFocusElement?.focus?.({ preventScroll: true });
            modal.returnFocusElement = null;
        }, 220);
    };
    window.JEVEXA_SAFE_INTERACTION.bind(
        document.getElementById('upgradeModalClose'),
        'click',
        close
    );
    window.JEVEXA_SAFE_INTERACTION.bind(
        document.getElementById('upgradeModalCloseSecondary'),
        'click',
        close
    );
    window.JEVEXA_SAFE_INTERACTION.bind(
        document.getElementById('upgradeModalPlans'),
        'click',
        (event) => {
            event.preventDefault();
            const requiredPlan = (modal.dataset.requiredPlan || 'pro').toLowerCase();
            close();
            navigateToPricingAndHighlight(requiredPlan);
        }
    );
    window.JEVEXA_SAFE_INTERACTION.bind(modal, 'click', event => {
        if (event.target === modal) close();
    }, { matches: event => event.target === modal, getKey: () => modal });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !modal.hidden) {
            event.preventDefault();
            close();
            return;
        }
        if (event.key !== 'Tab' || modal.hidden) return;
        const focusable = Array.from(modal.querySelectorAll('button:not(:disabled), a[href]'))
            .filter(element => element.getClientRects().length);
        if (!focusable.length) return;
        if (event.shiftKey && document.activeElement === focusable[0]) {
            event.preventDefault();
            focusable[focusable.length - 1].focus();
        } else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
            event.preventDefault();
            focusable[0].focus();
        }
    });
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeUpgradeModal, { once: true });
} else {
    initializeUpgradeModal();
}

window.JEVEXA_SAFE_INTERACTION.bind(document, 'click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href="#pricing"]') : null;
    if (!link) return;
    if (link.closest('#chatbotWindow, #upgradeModal, #supportModal, #jevexaAccountBackdrop') || document.body.classList.contains('chat-modal-open')) {
        event.preventDefault();
        const plan = link.dataset.plan || link.getAttribute('data-pricing-plan') || 'pro';
        navigateToPricingAndHighlight(plan);
    }
}, {
    matches: event => event.target instanceof Element && Boolean(event.target.closest('a[href="#pricing"]')),
    getKey: event => event.target instanceof Element ? event.target.closest('a[href="#pricing"]') || document : document
});

// ===============================



// Supabase Configuration



// ===============================



// Preloader + visible counter timing



let countersReady = false;

let counterObserver = null;

let loadingFinished = false;



function finishLoading() {

    if (loadingFinished) return;
    loadingFinished = true;



    const pre = document.getElementById('preloader');



    if (pre) pre.classList.add('hidden');



    countersReady = true;



    setupCounterObserver();


}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', finishLoading, { once: true });
} else {
    finishLoading();
}
window.setTimeout(finishLoading, 8000);

// ===============================
// ===============================
// JEVEXA Professional Authentication System
// ===============================

const supabaseConfig = window.JEVEXA_SUPABASE_CONFIG;
const SUPABASE_URL = supabaseConfig?.url;
const SUPABASE_KEY = supabaseConfig?.anonKey;
const hasSupabaseConfig = Boolean(supabaseConfig?.url && supabaseConfig?.anonKey);
const isStaticPreview = location.port !== '8788' && !hasSupabaseConfig;
const hasSupabaseSdk = typeof window.supabase?.createClient === 'function';
let supabaseClient = null;
if (hasSupabaseConfig && hasSupabaseSdk) {
    try {
        supabaseClient = window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey);
    } catch {
        console.error('Supabase client initialization failed.');
    }
}
window.JEVEXA_SUPABASE_READY = Boolean(supabaseClient);
if (!window.JEVEXA_SUPABASE_READY) {
    if (isStaticPreview) {
        const previewNotice = document.getElementById('staticPreviewNotice');
        if (previewNotice) previewNotice.hidden = false;
    } else {
        const configError = document.getElementById('appConfigError');
        if (configError) {
            configError.textContent = !hasSupabaseConfig
                ? 'JEVEXA account features could not load because this Worker is missing its environment-specific public Supabase configuration. Please try again later.'
                : !hasSupabaseSdk
                    ? 'JEVEXA account features could not load because the Supabase browser library is unavailable. Please try again later.'
                    : 'JEVEXA account features could not load because the Worker Supabase configuration could not be initialized. Please try again later.';
            configError.hidden = false;
        }
        console.error('JEVEXA account features are unavailable; public Supabase configuration or browser library is missing.');
    }
}

function showSupabaseUnavailable() {
    if (isStaticPreview) {
        const previewNotice = document.getElementById('staticPreviewNotice');
        if (previewNotice) previewNotice.hidden = false;
    } else {
        const configError = document.getElementById('appConfigError');
        if (configError) configError.hidden = false;
    }
    showAuthMessage('Account features are temporarily unavailable. Please try again later.');
}
// ===== JEVEXA THEME SYSTEM =====

function applyJevexaTheme(theme) {
    const root = document.documentElement;

    let resolvedTheme = theme;

    if (theme === 'system') {
        resolvedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light';
    }

    root.setAttribute('data-jevexa-theme', resolvedTheme);
    localStorage.setItem('jevexaTheme', theme);
}

function initializeJevexaTheme() {
    const savedTheme = localStorage.getItem('jevexaTheme') || 'dark';
    applyJevexaTheme(savedTheme);
}

initializeJevexaTheme();
let isSignupMode = false;
let authBusy = false;
let currentUser = null;
let authStateRevision = 0;
let previousLoginFocus = null;

function showLoginModal() {
    const modal = document.getElementById('loginModal');
    if (!modal) return;
    if (!modal.classList.contains('open')) {
        previousLoginFocus = document.activeElement;
        window.__jevexaScrollY = window.scrollY;
    }
    modal.classList.add('open');
    document.body.classList.add('login-open');
    document.documentElement.classList.add('login-open');
    document.body.style.top = `-${window.__jevexaScrollY || 0}px`;
    window.requestAnimationFrame(() => {
        document.getElementById(isSignupMode ? 'signupName' : 'loginEmail')?.focus({ preventScroll: true });
    });
}

function openLogin() {
    if (currentUser) {
        closeLogin();
        return;
    }
    if (isSignupMode) {
        isSignupMode = false;
        syncAuthModeUI();
    }
    clearAuthMessage();
    showLoginModal();
}

function closeLogin() {
    const modal = document.getElementById('loginModal');
    if (!modal) return;
    modal.classList.remove('open');
    document.body.classList.remove('login-open');
    document.documentElement.classList.remove('login-open');
    document.body.style.top = '';
    window.scrollTo(0, window.__jevexaScrollY || 0);
    const pw = document.getElementById('loginPassword');
    if (pw) pw.value = '';
    if (previousLoginFocus instanceof HTMLElement) previousLoginFocus.focus({ preventScroll: true });
    previousLoginFocus = null;
}

const loginModalBackdropTarget = document.getElementById('loginModal');
if (loginModalBackdropTarget) {
    window.JEVEXA_SAFE_INTERACTION.bind(loginModalBackdropTarget, 'click', event => {
        if (event.target === loginModalBackdropTarget) {
            closeLogin();
        }
    }, { matches: event => event.target === loginModalBackdropTarget, getKey: () => loginModalBackdropTarget });
}

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        const accountBackdrop = document.getElementById('jevexaAccountBackdrop');
        if (accountBackdrop && accountBackdrop.style.display !== 'none') {
            accountBackdrop.style.display = 'none';
        }
        const profilePanel = document.getElementById('jevexaProfilePanel');
        if (profilePanel && profilePanel.style.display !== 'none') {
            profilePanel.style.display = 'none';
            document.getElementById('jevexaAccountUI')?.querySelector('button')?.setAttribute('aria-expanded', 'false');
        }
    }
    const modal = document.getElementById('loginModal');
    if (!modal?.classList.contains('open')) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closeLogin();
        return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled)')]
        .filter(element => element.getClientRects().length > 0);
    if (!focusable.length) {
        event.preventDefault();
        modal.focus();
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
});

document.addEventListener('submit', event => {
    if (event.target.matches('#authForm')) {
        event.preventDefault();
        void handleAuthSubmit();
    }
});

function getFriendlyAuthError(error, action = 'login') {
    const message = String(error?.message || '').toLowerCase();
    const status = Number(error?.status || 0);

    if (status === 429 || message.includes('rate limit') || message.includes('too many')) {
        return 'Too many attempts. Please wait a moment and try again.';
    }
    if (message.includes('provider is not enabled') || message.includes('validation_failed')) {
        return 'This sign-in method is not enabled yet. Please use email login.';
    }

    if (message.includes('invalid login credentials')) {
        return 'Incorrect email or password. Please try again.';
    }

    if (message.includes('email not confirmed')) {
        return 'Please verify your email before logging in.';
    }

    if (message.includes('user already registered') || message.includes('already registered')) {
        return 'An account with this email already exists. Try logging in.';
    }

    if (message.includes('invalid email')) {
        return 'Please enter a valid email address.';
    }

    if (message.includes('password should be at least') || message.includes('password')) {
        if (action === 'signup') return 'Password must be at least 6 characters.';
    }

    if (message.includes('network') || message.includes('fetch')) {
        return 'Connection problem. Please check your internet and try again.';
    }

    if (action === 'signup') {
        return 'We could not create your account. Please try again later.';
    }

    return 'Something went wrong. Please try again later.';
}

function setAuthButtonLoading(loading, text = '') {
    const button = document.getElementById('authSubmitButton');
    if (button) {
        button.disabled = loading;
        button.classList.toggle('loading', loading);
        button.setAttribute('aria-busy', String(loading));
        button.innerHTML = loading
            ? `<span class="auth-spinner" aria-hidden="true"></span>${text}`
            : (isSignupMode ? 'Create Account <span>→</span>' : 'Login to JEVEXA <span>→</span>');
    }
    document.querySelectorAll('.social-login').forEach(b => {
        b.disabled = loading;
        b.classList.toggle('disabled', loading);
    });
    const modeToggle = document.getElementById('authModeToggle');
    if (modeToggle) modeToggle.style.pointerEvents = loading ? 'none' : '';
}

function clearAuthFields() {
    const name = document.getElementById('signupName');
    const email = document.getElementById('loginEmail');
    const password = document.getElementById('loginPassword');

    if (name) name.value = '';
    if (email) email.value = '';
    if (password) password.value = '';
}

function showAuthMessage(message, type = 'error') {
    showToast(message);

    const formArea = document.querySelector('.login-form-area');
    if (!formArea) return;

    let box = document.getElementById('authInlineMessage');
    if (!box) {
        box = document.createElement('div');
        box.id = 'authInlineMessage';
        box.setAttribute('role', 'alert');
        box.style.cssText = `
            margin: 12px 0 0;
            padding: 11px 13px;
            border-radius: 12px;
            font-size: 13px;
            line-height: 1.45;
            border: 1px solid rgba(255,255,255,.12);
            background: rgba(255,255,255,.05);
        `;
        const submit = document.getElementById('authSubmitButton');
        submit?.insertAdjacentElement('afterend', box);
    }

    box.textContent = message;
    box.dataset.type = type;
    box.style.borderColor = type === 'success'
        ? 'rgba(52,211,153,.35)'
        : 'rgba(248,113,113,.35)';
    box.style.color = type === 'success' ? '#6ee7b7' : '#fca5a5';
}

function clearAuthMessage() {
    document.getElementById('authInlineMessage')?.remove();
}

async function loginWithGoogle() {
    if (authBusy) return;
    clearAuthMessage();
    if (!supabaseClient) return showSupabaseUnavailable();
    authBusy = true;
    try {
        const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin }
        });
        if (error) {
            console.error('Google login error:', error);
            showAuthMessage(getFriendlyAuthError(error, 'login'));
        }
    } catch (error) {
        console.error('Google login request failed:', error);
        showAuthMessage('Google login could not be started. Please try again.');
    } finally {
        authBusy = false;
    }
}

async function loginWithGithub() {
    if (authBusy) return;
    clearAuthMessage();
    if (!supabaseClient) return showSupabaseUnavailable();
    authBusy = true;
    try {
        const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'github',
            options: { redirectTo: window.location.origin }
        });
        if (error) {
            console.error('GitHub login error:', error);
            showAuthMessage(getFriendlyAuthError(error, 'login'));
        }
    } catch (error) {
        console.error('GitHub login request failed:', error);
        showAuthMessage('GitHub login could not be started. Please try again.');
    } finally {
        authBusy = false;
    }
}

async function loginWithEmail() {
    if (authBusy) return;
    if (!supabaseClient) return showSupabaseUnavailable();

    const email = document.getElementById('loginEmail')?.value.trim() || '';
    const password = document.getElementById('loginPassword')?.value || '';

    clearAuthMessage();

    if (!email) {
        showAuthMessage('Please enter your email address.');
        document.getElementById('loginEmail')?.focus();
        return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showAuthMessage('Please enter a valid email address.');
        document.getElementById('loginEmail')?.focus();
        return;
    }

    if (!password) {
        showAuthMessage('Please enter your password.');
        document.getElementById('loginPassword')?.focus();
        return;
    }

    authBusy = true;
    setAuthButtonLoading(true, 'Signing in...');

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            console.error('Email login error:', error);
            showAuthMessage(getFriendlyAuthError(error, 'login'));
            return;
        }

        closeLogin();
        clearAuthFields();
        showToast(`✓ Welcome back${getUserFirstName(data?.user) ? `, ${getUserFirstName(data.user)}` : ''}!`);
    } catch (error) {
        console.error('Email login request failed:', error);
        showAuthMessage(getFriendlyAuthError(error, 'login'));
    } finally {
        authBusy = false;
        setAuthButtonLoading(false);
    }
}

async function createAccountWithEmail() {
    if (authBusy) return;
    if (!supabaseClient) return showSupabaseUnavailable();

    const name = document.getElementById('signupName')?.value.trim() || '';
    const email = document.getElementById('loginEmail')?.value.trim() || '';
    const password = document.getElementById('loginPassword')?.value || '';

    clearAuthMessage();

    if (!name) {
        showAuthMessage('Please enter your full name.');
        document.getElementById('signupName')?.focus();
        return;
    }

    if (name.length < 2) {
        showAuthMessage('Please enter your full name.');
        return;
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showAuthMessage('Please enter a valid email address.');
        document.getElementById('loginEmail')?.focus();
        return;
    }

    if (!password) {
        showAuthMessage('Please create a password.');
        document.getElementById('loginPassword')?.focus();
        return;
    }

    if (password.length < 6) {
        showAuthMessage('Password must be at least 6 characters.');
        return;
    }

    authBusy = true;
    setAuthButtonLoading(true, 'Creating account...');

    try {
        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: {
                data: {
                    full_name: name,
                    name: name
                },
                emailRedirectTo: window.location.origin
            }
        });

        if (error) {
            console.error('Signup error:', error);
            showAuthMessage(getFriendlyAuthError(error, 'signup'));
            return;
        }

        // When email confirmation is enabled, Supabase normally returns a user
        // with no active session until the email is verified.
        if (data?.session) {
            closeLogin();
            clearAuthFields();
            showToast(`✓ Welcome to JEVEXA, ${name.split(' ')[0]}!`);
        } else {
            showAuthMessage(
                '✓ Account created! Please check your email and click the verification link.',
                'success'
            );
        }
    } catch (error) {
        console.error('Signup request failed:', error);
        showAuthMessage(getFriendlyAuthError(error, 'signup'));
    } finally {
        authBusy = false;
        setAuthButtonLoading(false);
    }
}

function syncAuthModeUI() {
    const nameWrapper = document.getElementById('signupNameWrapper');
    const nameInput = document.getElementById('signupName');
    const submitButton = document.getElementById('authSubmitButton');
    const modeToggle = document.getElementById('authModeToggle');
    const footerText = document.getElementById('authFooterText');
    const welcomeText = document.querySelector('.login-welcome p');
    const passwordInput = document.getElementById('loginPassword');

    if (isSignupMode) {
        if (nameWrapper) nameWrapper.style.setProperty('display', 'block', 'important');
        if (nameInput) nameInput.required = true;
        if (passwordInput) passwordInput.autocomplete = 'new-password';
        if (submitButton) submitButton.innerHTML = 'Create Account <span>→</span>';
        if (footerText) footerText.textContent = 'Already have an account?';
        if (modeToggle) modeToggle.textContent = 'Login →';
        if (welcomeText) welcomeText.textContent = 'Create your JEVEXA account to get started.';
    } else {
        if (nameWrapper) nameWrapper.style.setProperty('display', 'none', 'important');
        if (nameInput) nameInput.required = false;
        if (passwordInput) passwordInput.autocomplete = 'current-password';
        if (submitButton) submitButton.innerHTML = 'Login to JEVEXA <span>→</span>';
        if (footerText) footerText.textContent = "Don't have an account?";
        if (modeToggle) modeToggle.textContent = 'Create Account →';
        if (welcomeText) welcomeText.textContent = 'Login to continue your AI automation journey.';
    }
}

function toggleAuthMode() {
    isSignupMode = !isSignupMode;
    clearAuthMessage();
    syncAuthModeUI();
}

function openAuthModal(mode = 'login') {
    if (currentUser) {
        closeLogin();
        return;
    }
    const targetMode = mode === 'signup';
    isSignupMode = targetMode;
    clearAuthMessage();
    syncAuthModeUI();
    showLoginModal();
}

function openSignup() {
    if (currentUser) {
        closeLogin();
        return;
    }
    openAuthModal('signup');
}

window.openLogin = openLogin;
window.openSignup = openSignup;
window.openAuthModal = openAuthModal;
window.showLoginModal = showLoginModal;
window.closeLogin = closeLogin;

async function handleAuthSubmit() {
    if (isSignupMode) {
        await createAccountWithEmail();
    } else {
        await loginWithEmail();
    }
}

function getUserName(user) {
    return user?.user_metadata?.full_name ||
           user?.user_metadata?.name ||
           user?.email?.split('@')[0] ||
           'User';
}

function getUserFirstName(user) {
    return getUserName(user).split(' ')[0];
}

function getUserInitials(user) {
    const name = getUserName(user).trim();
    return name
        .split(/\s+/)
        .slice(0, 2)
        .map(part => part[0])
        .join('')
        .toUpperCase() || 'U';
}

function openJevexaSupport() {
    if (typeof window.JEVEXA_SUPPORT_MODAL_OPEN === 'function') {
        window.JEVEXA_SUPPORT_MODAL_OPEN();
        return;
    }
    const body = [`Page URL: ${window.location.href}`];
    if (currentUser?.email) body.push(`Account email: ${currentUser.email}`);
    body.push('Describe your issue:');

    const query = new URLSearchParams({
        bcc: 'maazofficial107@gmail.com',
        subject: '[JEVEXA Support] ',
        body: body.join('\n\n')
    });
    window.location.href = `mailto:hello@jevexa.ai?${query.toString()}`;
}

window.JEVEXA_OPEN_SUPPORT = openJevexaSupport;

function removeUserAccountUI() {
    document.getElementById('jevexaAccountUI')?.remove();
    document.getElementById('jevexaProfilePanel')?.remove();
    document.getElementById('jevexaAccountBackdrop')?.remove();
}

function renderUserAccount(user) {
    if (!user) return;

    removeUserAccountUI();

    const navActions = document.querySelector('.nav-actions');
    if (!navActions) return;

    const name = getUserName(user);
    const email = user.email || '';
    const initials = getUserInitials(user);

    const account = document.createElement('div');
    account.id = 'jevexaAccountUI';
    account.style.cssText = 'position:relative;display:flex;align-items:center;margin-left:12px;';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jevexa-account-toggle';
    button.setAttribute('aria-label', 'Open account menu');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', 'jevexaProfilePanel');
    button.setAttribute('aria-expanded', 'false');
    button.style.cssText = `
        display:flex;align-items:center;gap:9px;padding:6px 10px 6px 6px;
        border:1px solid rgba(139,92,246,.35);border-radius:999px;
        background:rgba(12,12,30,.78);color:#fff;cursor:pointer;
        backdrop-filter:blur(16px);font:inherit;
    `;
    button.innerHTML = `
        <span style="width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#8b5cf6,#22d3ee);font-weight:800;font-size:12px;">${escapeHtml(initials)}</span>
        <span style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:700;">${escapeHtml(name)}</span>
        <span style="font-size:11px;opacity:.7;">⌄</span>
    `;

    const menu = document.createElement('div');
    menu.id = 'jevexaProfilePanel';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Account menu');
    menu.style.cssText = `
        display:none;position:absolute;right:0;top:calc(100% + 10px);width:290px;
        padding:14px;border:1px solid rgba(139,92,246,.28);border-radius:18px;
        background:rgba(8,8,24,.97);box-shadow:0 24px 60px rgba(0,0,0,.45);
        backdrop-filter:blur(22px);z-index:99999;color:#fff;
    `;
    menu.innerHTML = `
        <div style="display:flex;gap:12px;align-items:center;padding:8px 6px 14px;border-bottom:1px solid rgba(255,255,255,.08);">
            <div style="width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#8b5cf6,#22d3ee);font-weight:800;">${escapeHtml(initials)}</div>
            <div style="min-width:0;">
                <div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(name)}</div>
                <div style="font-size:12px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(email)}</div>
            </div>
        </div>
        <div style="padding:12px 6px 6px;font-size:12px;opacity:.6;text-transform:uppercase;letter-spacing:.08em;">Account</div>
        <button type="button" role="menuitem" data-account-action="profile" style="${accountMenuButtonStyle()}">👤 Profile</button>
        <button type="button" role="menuitem" data-account-action="settings" style="${accountMenuButtonStyle()}">⚙ Settings</button>
        <div style="height:1px;background:rgba(255,255,255,.08);margin:8px 0;"></div>
        <button type="button" role="menuitem" data-account-action="logout" style="${accountMenuButtonStyle(true)}">↪ Logout</button>
    `;

    account.append(button, menu);
    navActions.appendChild(account);

    window.JEVEXA_SAFE_INTERACTION.bind(button, 'click', (event) => {
        event.stopPropagation();
        const isOpen = menu.style.display !== 'block';
        menu.style.display = isOpen ? 'block' : 'none';
        button.setAttribute('aria-expanded', String(isOpen));
    });

    window.JEVEXA_SAFE_INTERACTION.bind(menu, 'click', async (event) => {
        const actionButton = event.target.closest('[data-account-action]');
        if (!actionButton) return;

        const action = actionButton.dataset.accountAction;
        menu.style.display = 'none';
        button.setAttribute('aria-expanded', 'false');

        if (action === 'logout') await logoutUser();
        if (action === 'profile') openProfileView(user);
        if (action === 'settings') openSettingsView(user);
    }, { getKey: event => event.target instanceof Element ? event.target.closest('[data-account-action]') || menu : menu });

    menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            menu.style.display = 'none';
            button.setAttribute('aria-expanded', 'false');
            button.focus();
        }
    });

    if (!window.__jevexaAccountOutsideClickBound) {
        window.JEVEXA_SAFE_INTERACTION.bind(document, 'click', event => {
            const liveAccount = document.getElementById('jevexaAccountUI');
            const liveMenu = document.getElementById('jevexaProfilePanel');
            if (liveMenu && liveAccount && !liveAccount.contains(event.target)) {
                liveMenu.style.display = 'none';
                liveAccount.querySelector('.jevexa-account-toggle')?.setAttribute('aria-expanded', 'false');
            }
        }, {
            getKey: event => event.target instanceof Element ? event.target.closest('#jevexaAccountUI') || event.target : document,
            preventDefaultOnDebounce: false
        });
        window.__jevexaAccountOutsideClickBound = true;
    }
}

function accountMenuButtonStyle(danger = false) {
    return `width:100%;text-align:left;padding:10px 11px;border:0;border-radius:10px;background:transparent;color:${danger ? '#fca5a5' : '#fff'};cursor:pointer;font:inherit;font-size:13px;`;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function ensureAccountOverlay() {
    let backdrop = document.getElementById('jevexaAccountBackdrop');
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'jevexaAccountBackdrop';
        backdrop.style.cssText = `
            position:fixed;inset:0;display:none;align-items:center;justify-content:center;
            padding:20px;background:rgba(0,0,0,.62);backdrop-filter:blur(8px);z-index:100000;
        `;
        document.body.appendChild(backdrop);
        window.JEVEXA_SAFE_INTERACTION.bind(backdrop, 'click', event => {
            if (event.target === backdrop) backdrop.style.display = 'none';
        });
    }
    return backdrop;
}

function openProfileView(user) {
    const backdrop = ensureAccountOverlay();

    const name = getUserName(user);
    const email = user?.email || '';
    const initials = getUserInitials(user);
    const created = user?.created_at
        ? new Date(user.created_at).toLocaleDateString()
        : '—';

    const avatarUrl = user?.user_metadata?.avatar_url || '';

    const avatarContent = avatarUrl
        ? `<img src="${escapeHtml(avatarUrl)}"
                alt="Profile"
                style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
        : escapeHtml(initials);

    backdrop.innerHTML = `
        <div style="
            width:min(520px,100%);
            max-height:90vh;
            overflow-y:auto;
            border:1px solid rgba(139,92,246,.30);
            border-radius:26px;
            padding:28px;
            background:
                radial-gradient(circle at top right, rgba(139,92,246,.16), transparent 35%),
                radial-gradient(circle at bottom left, rgba(34,211,238,.10), transparent 35%),
                rgba(9,9,28,.98);
            color:#fff;
            box-shadow:0 30px 100px rgba(0,0,0,.65);
        ">

            <!-- Header -->
            <div style="
                display:flex;
                justify-content:space-between;
                align-items:center;
                margin-bottom:24px;
            ">
                <div>
                    <div style="
                        font-size:12px;
                        color:#a78bfa;
                        font-weight:700;
                        letter-spacing:1.2px;
                        text-transform:uppercase;
                        margin-bottom:5px;
                    ">
                        Account
                    </div>

                    <h3 style="
                        margin:0;
                        font-size:25px;
                        font-weight:800;
                    ">
                        Your Profile
                    </h3>
                </div>

                <button
                    id="profileClose"
                    type="button"
                    style="
                        width:38px;
                        height:38px;
                        border:1px solid rgba(255,255,255,.10);
                        border-radius:12px;
                        background:rgba(255,255,255,.05);
                        color:#aaa;
                        font-size:22px;
                        cursor:pointer;
                    "
                >
                    ×
                </button>
            </div>

            <!-- Avatar -->
            <div style="
                text-align:center;
                padding:8px 0 25px;
            ">

                <div style="
                    position:relative;
                    margin:auto;
                    width:104px;
                    height:104px;
                ">

                    <div
                        id="profileAvatar"
                        style="
                            width:104px;
                            height:104px;
                            border-radius:50%;
                            display:grid;
                            place-items:center;
                            overflow:hidden;
                            background:linear-gradient(135deg,#8b5cf6,#22d3ee);
                            border:3px solid rgba(255,255,255,.14);
                            box-shadow:
                                0 0 0 6px rgba(139,92,246,.08),
                                0 15px 45px rgba(34,211,238,.18);
                            font-size:30px;
                            font-weight:900;
                        "
                    >
                        ${avatarContent}
                    </div>
                </div>

                <h4 style="
                    margin:15px 0 4px;
                    font-size:21px;
                    font-weight:800;
                ">
                    ${escapeHtml(name)}
                </h4>

                <p style="
                    margin:0;
                    color:#9ca3af;
                    font-size:13px;
                ">
                    ${escapeHtml(email)}
                </p>

                <div style="
                    display:inline-flex;
                    align-items:center;
                    gap:6px;
                    margin-top:12px;
                    padding:6px 12px;
                    border-radius:999px;
                    background:rgba(139,92,246,.12);
                    border:1px solid rgba(139,92,246,.22);
                    color:#c4b5fd;
                    font-size:12px;
                    font-weight:700;
                ">
                    ✦ Free Trial
                </div>
            </div>

            <!-- Account Information -->
            <div style="
                display:grid;
                gap:10px;
            ">

                <div style="
                    padding:15px;
                    border-radius:15px;
                    background:rgba(255,255,255,.045);
                    border:1px solid rgba(255,255,255,.06);
                ">
                    <div style="
                        color:#8b92a7;
                        font-size:11px;
                        text-transform:uppercase;
                        letter-spacing:.8px;
                        margin-bottom:5px;
                    ">
                        Account Name
                    </div>

                    <strong style="font-size:14px;">
                        ${escapeHtml(name)}
                    </strong>
                </div>

                <div style="
                    padding:15px;
                    border-radius:15px;
                    background:rgba(255,255,255,.045);
                    border:1px solid rgba(255,255,255,.06);
                ">
                    <div style="
                        color:#8b92a7;
                        font-size:11px;
                        text-transform:uppercase;
                        letter-spacing:.8px;
                        margin-bottom:5px;
                    ">
                        Email Address
                    </div>

                    <strong style="
                        font-size:14px;
                        word-break:break-word;
                    ">
                        ${escapeHtml(email)}
                    </strong>
                </div>

                <div style="
                    display:grid;
                    grid-template-columns:1fr 1fr;
                    gap:10px;
                ">

                    <div style="
                        padding:15px;
                        border-radius:15px;
                        background:rgba(139,92,246,.08);
                        border:1px solid rgba(139,92,246,.15);
                    ">
                        <div style="
                            color:#a78bfa;
                            font-size:11px;
                            text-transform:uppercase;
                            margin-bottom:5px;
                        ">
                            Credit package
                        </div>

                        <strong id="profilePlanValue" style="font-size:15px;">Loading…</strong>
                    </div>

                    <div style="
                        padding:15px;
                        border-radius:15px;
                        background:rgba(34,211,238,.07);
                        border:1px solid rgba(34,211,238,.14);
                    ">
                        <div style="
                            color:#67e8f9;
                            font-size:11px;
                            text-transform:uppercase;
                            margin-bottom:5px;
                        ">
                            Credits
                        </div>

                        <strong id="profileCreditsValue" style="font-size:15px;">Loading…</strong>
                    </div>

                </div>

                <div style="
                    padding:15px;
                    border-radius:15px;
                    background:rgba(255,255,255,.045);
                    border:1px solid rgba(255,255,255,.06);
                ">
                    <div style="
                        color:#8b92a7;
                        font-size:11px;
                        text-transform:uppercase;
                        letter-spacing:.8px;
                        margin-bottom:5px;
                    ">
                        Member Since
                    </div>

                    <strong style="font-size:14px;">
                        ${escapeHtml(created)}
                    </strong>
                </div>

            </div>

            <!-- Edit Profile Button -->
            <button
                id="profileEditButton"
                type="button"
                style="
                    width:100%;
                    margin-top:18px;
                    padding:13px 16px;
                    border:0;
                    border-radius:13px;
                    background:linear-gradient(135deg,#8b5cf6,#06b6d4);
                    color:#fff;
                    font-weight:800;
                    font-size:14px;
                    cursor:pointer;
                    box-shadow:0 12px 30px rgba(99,102,241,.22);
                "
            >
                ✦ Edit Profile
            </button>

        </div>
    `;

    backdrop.style.display = 'flex';

    const profileCreditsValue = backdrop.querySelector('#profileCreditsValue');
    const profilePlanValue = backdrop.querySelector('#profilePlanValue');
    if (profileCreditsValue || profilePlanValue) {
        supabaseClient.from('user_credits').select('balance, plan')
            .eq('user_id', user.id).maybeSingle()
            .then(({ data, error }) => {
                if (error || !data) {
                    if (profileCreditsValue?.isConnected) profileCreditsValue.textContent = 'Unavailable';
                    if (profilePlanValue?.isConnected) profilePlanValue.textContent = 'Unavailable';
                    return;
                }
                if (profileCreditsValue?.isConnected) profileCreditsValue.textContent = String(data.balance);
                if (profilePlanValue?.isConnected) {
                    const planKey = String(data.plan || '').trim().toLowerCase();
                    const planLabels = { free: 'Free', starter: 'Lite', lite: 'Lite', pro: 'Pro', business: 'Max', max: 'Max', ultra: 'Ultra' };
                    profilePlanValue.textContent = planLabels[planKey]
                        || (planKey ? planKey.replace(/[_-]+/g, ' ') : 'Unavailable');
                }
            })
            .catch(error => {
                console.error('Profile account summary error:', error);
                if (profileCreditsValue?.isConnected) profileCreditsValue.textContent = 'Unavailable';
                if (profilePlanValue?.isConnected) profilePlanValue.textContent = 'Unavailable';
            });
    }

    // Close profile
    window.JEVEXA_SAFE_INTERACTION.bind(backdrop.querySelector('#profileClose'), 'click', () => {
        backdrop.style.display = 'none';
    });

    // Edit Profile
    window.JEVEXA_SAFE_INTERACTION.bind(backdrop.querySelector('#profileEditButton'), 'click', () => {
        backdrop.style.display = 'none';
        openSettingsView(user);
    });
}
    
function openSettingsView(user) {
    if (!user) {
        openLogin();
        return;
    }

    const backdrop = ensureAccountOverlay();
    let name = getUserName(user);
    const email = user.email || '';
    const sections = [
        ['account', '👤', 'Account', 'Profile details'],
        ['security', '🔐', 'Security', 'Password and sessions'],
        ['appearance', '🎨', 'Appearance', 'Theme and display'],
        ['preferences', '⚙️', 'Preferences', 'Saved interface choices'],
        ['credits', '⚡', 'Credits & Usage', 'Balance and transactions'],
        ['support', '✉️', 'Help & Support', 'Contact JEVEXA']
    ];

    backdrop.style.display = 'flex';
    backdrop.innerHTML = `
      <section id="settingsPanel" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <aside>
          <div class="settings-brand"><span>JEVEXA</span><strong>Settings</strong><small>Manage your account</small></div>
          <nav id="settingsNav" aria-label="Settings sections">
            ${sections.map(([id, icon, title, desc], i) => `
              <button type="button" class="jevexa-settings-nav ${i === 0 ? 'active' : ''}" data-settings-section="${id}" aria-current="${i === 0 ? 'page' : 'false'}">
                <span class="settings-nav-icon">${icon}</span><span><strong>${title}</strong><small>${desc}</small></span>
              </button>`).join('')}
          </nav>
          <button type="button" class="settings-logout-btn" data-settings-action="logout">Log out</button>
        </aside>
        <main>
          <header class="settings-topbar">
            <div><span class="settings-eyebrow">ACCOUNT WORKSPACE</span><h2 id="settingsTitle">Settings</h2></div>
            <button type="button" id="settingsClose" class="settings-close" aria-label="Close settings">×</button>
          </header>
          <div id="settingsContent" aria-live="polite"></div>
        </main>
      </section>`;

    const content = backdrop.querySelector('#settingsContent');
    const panel = backdrop.querySelector('#settingsPanel');
    const userKey = `jevexa_${user.id}_`;
    const stored = (key, fallback='') => localStorage.getItem(userKey + key) ?? fallback;
    const escape = value => escapeHtml(String(value ?? ''));
    const card = (title, description, body) => `
      <section class="settings-card"><div class="settings-card-heading"><h3>${title}</h3><p>${description}</p></div>${body}</section>`;
    const action = (label, actionName, secondary=false) => `<button type="button" class="${secondary ? 'settings-secondary-btn' : 'settings-action-btn'}" data-settings-action="${actionName}">${label}</button>`;

    async function loadCredits() {
      const balanceNode = content.querySelector('#settingsBalance');
      const allowanceNode = content.querySelector('#settingsAllowance');
      const statusNode = content.querySelector('#settingsCreditStatus');
      if (!balanceNode) return;
      balanceNode.textContent = '…';
      const { data, error } = await supabaseClient.from('user_credits')
        .select('balance, monthly_allowance').eq('user_id', user.id).maybeSingle();
      if (error) {
        console.error('Credits load error:', error);
        balanceNode.textContent = 'Unavailable';
        statusNode.textContent = 'Could not load credits. Please refresh and try again.';
        return;
      }
      if (!data) {
        balanceNode.textContent = 'Not set up';
        allowanceNode.textContent = '—';
        statusNode.textContent = 'No credit account exists for this user yet. Configure the Supabase user-credit trigger before launch.';
        return;
      }
      balanceNode.textContent = String(data.balance);
      allowanceNode.textContent = String(data.monthly_allowance ?? '—');
      statusNode.textContent = 'Balance loaded from your account.';
      const headerCount = document.getElementById('creditsCount');
      if (headerCount) headerCount.textContent = String(data.balance);
      window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
    }

    function render(section) {
      panel.dataset.activeSection = section;
      panel.querySelectorAll('[data-settings-section]').forEach(button => {
        const active = button.dataset.settingsSection === section;
        button.classList.toggle('active', active);
        button.setAttribute('aria-current', active ? 'page' : 'false');
      });
      const titles = {account:'Account',security:'Security',appearance:'Appearance',preferences:'Preferences',credits:'Credits & Usage',support:'Help & Support'};
      panel.querySelector('#settingsTitle').textContent = titles[section] || 'Settings';

      if (section === 'account') {
        content.innerHTML = `
          ${card('Profile information','Update the name shown on your JEVEXA account.',`
            <form id="settingsProfileForm" class="settings-form">
              <label>Full name<input id="settingsFullName" name="full_name" value="${escape(name)}" minlength="2" maxlength="80" required autocomplete="name"></label>
              <label>Email address<input value="${escape(email)}" readonly disabled></label>
              <button class="settings-action-btn" type="submit">Save profile</button>
            </form>
            <p class="settings-muted">Your email is managed by your sign-in provider.</p>`)}
          ${card('Account status','Your account identity and session.',`
            <div class="settings-info-row"><span>Account</span><strong>Active session</strong></div>
            <div class="settings-info-row"><span>Member since</span><strong>${escape(user.created_at ? new Date(user.created_at).toLocaleDateString() : '—')}</strong></div>
            ${action('Log out of this device','logout',true)}`)}`;
      } else if (section === 'security') {
        content.innerHTML = `
          ${card('Change password','Choose a strong password you do not use elsewhere.',`
            <form id="settingsPasswordForm" class="settings-form">
              <label>New password<input id="settingsNewPassword" type="password" minlength="6" autocomplete="new-password" required></label>
              <label>Confirm new password<input id="settingsConfirmPassword" type="password" minlength="6" autocomplete="new-password" required></label>
              <button class="settings-action-btn" type="submit">Update password</button>
            </form>`)}
          ${card('Password recovery','Send a secure password reset link to your account email.',action('Send password reset email','reset-password',true))}
          ${card('Sessions','Sign out on this device or revoke sessions for this account.',action('Log out all devices','logout-all',true))}`;
      } else if (section === 'appearance') {
        const theme = stored('theme', localStorage.getItem('jevexaTheme') || 'dark');
        content.innerHTML = `
          ${card('Color theme','Choose how JEVEXA looks on this device.',`
            <div class="settings-choice-grid">
              <button type="button" class="settings-choice ${theme==='dark'?'active':''}" data-theme-choice="dark">🌙 Dark</button>
              <button type="button" class="settings-choice ${theme==='light'?'active':''}" data-theme-choice="light">☀️ Light</button>
              <button type="button" class="settings-choice ${theme==='system'?'active':''}" data-theme-choice="system">🖥️ System</button>
            </div>`)}
          ${card('Motion','Reduce non-essential animation for a calmer interface.',`
            <label class="settings-toggle-row"><span><strong>Reduce motion</strong><small>Applies to this browser only.</small></span><input type="checkbox" id="settingsReduceMotion" ${stored('reduce_motion','false')==='true'?'checked':''}></label>`)}`;
      } else if (section === 'preferences') {
        content.innerHTML = `
          ${card('Interface preferences','These preferences are saved in this browser for your account.',`
            <label class="settings-toggle-row"><span><strong>Compact layout</strong><small>Reduce spacing in supported panels.</small></span><input type="checkbox" id="settingsCompact" ${stored('compact','false')==='true'?'checked':''}></label>
            <label class="settings-toggle-row"><span><strong>Helpful confirmations</strong><small>Show a message after settings are saved.</small></span><input type="checkbox" id="settingsConfirmations" ${stored('confirmations','true')==='true'?'checked':''}></label>
            <p class="settings-muted">These settings affect the current browser. They are not cloud-synced yet.</p>`)}
          ${card('Reset preferences','Restore the interface preferences to their defaults.',action('Reset appearance and preferences','reset-preferences',true))}`;
      } else if (section === 'credits') {
        content.innerHTML = `
          ${card('Credit balance','Live values are loaded from your Supabase account.',`
            <div class="settings-stats"><div><small>Current balance</small><strong id="settingsBalance">…</strong></div><div><small>Plan allocation</small><strong id="settingsAllowance">…</strong></div></div>
            <p id="settingsCreditStatus" class="settings-muted">Loading credit balance…</p>
            ${action('Refresh balance','refresh-credits',true)}`)}
          ${card('Recent transactions','Latest credit activity recorded for your account.',`<div id="settingsTransactions"><p class="settings-muted">Loading transactions…</p></div>${action('Refresh transactions','refresh-transactions',true)}`)}`;
        loadCredits();
        if (window.JEVEXA_CREDITS?.refreshHistory) {
          void window.JEVEXA_CREDITS.refreshHistory();
        } else {
          content.querySelector('#settingsTransactions').textContent = 'Transaction history is unavailable right now.';
        }
      } else if (section === 'support') {
        content.innerHTML = `
          ${card('Contact support','Send a message to the JEVEXA support mailbox.',`
            <form id="settingsSupportForm" class="settings-form">
              <label>Topic<select id="settingsSupportTopic"><option>General support</option><option>Login or account issue</option><option>Credits issue</option><option>Bug report</option><option>Feature request</option></select></label>
              <label>Message<textarea id="settingsSupportMessage" rows="4" maxlength="2000" placeholder="Describe what you need help with…" required></textarea></label>
              <button class="settings-action-btn" type="submit">Prepare support email</button>
            </form>
            <p class="settings-muted">This opens your email app; it does not send anything automatically.</p>`)}
          ${card('Account data','Download a copy of the account profile data available in this browser.',action('Download account data','download-data',true))}`;
      }
    }

    window.JEVEXA_SAFE_INTERACTION.bind(panel, 'click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.matches('[data-settings-section]')) { render(button.dataset.settingsSection); return; }
      if (button.id === 'settingsClose') { backdrop.style.display = 'none'; return; }
      const actionName = button.dataset.settingsAction;
      if (!actionName) return;
      if (actionName === 'logout') { await logoutUser(); backdrop.style.display = 'none'; return; }
      if (actionName === 'logout-all') {
        if (!confirm('This will sign out all active sessions for this account. Continue?')) return;
        const { error } = await supabaseClient.auth.signOut({ scope: 'global' });
        if (error) { console.error(error); showToast('Could not sign out all devices.'); }
        else { backdrop.style.display = 'none'; showToast('Signed out of all devices.'); }
        return;
      }
      if (actionName === 'reset-password') {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin
    }, { getKey: event => event.target instanceof Element ? event.target.closest('button') || panel : panel });

    if (error) {
        console.error(error);
        showToast('Could not send reset email. Check your Supabase email settings.');
        return;
    }

    showToast('Successfully sent! Password reset link email kar di hai. Apna inbox check karein.');
    return;
}

      if (actionName === 'refresh-credits') { await loadCredits(); return; }
      if (actionName === 'refresh-transactions') {
        if (window.JEVEXA_CREDITS?.refreshHistory) await window.JEVEXA_CREDITS.refreshHistory();
        else showToast('Transaction history is unavailable right now.');
        return;
      }
      if (actionName === 'reset-preferences') {
        ['compact','confirmations','reduce_motion'].forEach(key => localStorage.removeItem(userKey + key));
        document.documentElement.classList.remove('jevexa-reduce-motion','jevexa-compact');
        render('preferences');
        showToast('Preferences reset.');
        return;
      }
      if (actionName === 'download-data') {
        const payload = { account: { id: user.id, email, name: getUserName(user), created_at: user.created_at }, preferences: Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith(userKey)).map(key => [key.slice(userKey.length), localStorage.getItem(key)])), exported_at: new Date().toISOString() };
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'}));
        const a = document.createElement('a'); a.href = url; a.download = 'jevexa-account-data.json'; a.click(); URL.revokeObjectURL(url);
        showToast('Account data downloaded.');
      }
    });

    panel.addEventListener('submit', async event => {
      event.preventDefault();
      if (event.target.id === 'settingsProfileForm') {
        const input = panel.querySelector('#settingsFullName');
        const cleanName = input.value.trim();
        if (cleanName.length < 2) { showToast('Enter a name with at least 2 characters.'); return; }
        const submit = event.target.querySelector('[type="submit"]'); submit.disabled = true; submit.textContent = 'Saving…';
        const { data, error } = await supabaseClient.auth.updateUser({ data: { full_name: cleanName, name: cleanName } });
        submit.disabled = false; submit.textContent = 'Save profile';
        if (error) { console.error(error); showToast('Profile could not be saved.'); return; }
        currentUser = data.user || currentUser;
        name = cleanName;
        renderUserAccount(currentUser);
        showToast('Profile saved.');
        render('account');
        return;
      }
      if (event.target.id === 'settingsPasswordForm') {
        const password = panel.querySelector('#settingsNewPassword').value;
        const confirmPassword = panel.querySelector('#settingsConfirmPassword').value;
        if (password.length < 6) { showToast('Password must be at least 6 characters.'); return; }
        if (password !== confirmPassword) { showToast('Passwords do not match.'); return; }
        const submit = event.target.querySelector('[type="submit"]'); submit.disabled = true; submit.textContent = 'Updating…';
        const { error } = await supabaseClient.auth.updateUser({ password });
        submit.disabled = false; submit.textContent = 'Update password';
        if (error) { console.error(error); showToast('Password could not be updated.'); return; }
        event.target.reset(); showToast('Password updated successfully.');
        return;
      }
      if (event.target.id === 'settingsSupportForm') {
        const topic = panel.querySelector('#settingsSupportTopic').value;
        const message = panel.querySelector('#settingsSupportMessage').value.trim();
        if (!message) { showToast('Please enter a message.'); return; }
        const subject = encodeURIComponent(`[JEVEXA] ${topic}`);
        const body = encodeURIComponent(`Account: ${email}\n\n${message}`);
        window.location.href = `mailto:support@jevexa.net?subject=${subject}&body=${body}`;
      }
    });

    panel.addEventListener('change', event => {
      const target = event.target;
      if (target.matches('[data-theme-choice]')) return;
      if (target.id === 'settingsReduceMotion') {
        localStorage.setItem(userKey + 'reduce_motion', String(target.checked));
        document.documentElement.classList.toggle('jevexa-reduce-motion', target.checked);
      } else if (target.id === 'settingsCompact') {
        localStorage.setItem(userKey + 'compact', String(target.checked));
        document.documentElement.classList.toggle('jevexa-compact', target.checked);
      } else if (target.id === 'settingsConfirmations') {
        localStorage.setItem(userKey + 'confirmations', String(target.checked));
      }
    });

    render('account');
    if (!backdrop._escBound) {
        backdrop._escBound = true;
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && backdrop.style.display === 'flex') {
                backdrop.style.display = 'none';
            }
        });
    }
}

async function logoutUser() {
    if (!supabaseClient) return showSupabaseUnavailable();
    try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) throw error;
    } catch (error) {
        console.error('Logout error:', error);
        showToast('Could not log out. Please try again.');
        return;
    }
    showToast('You have been logged out.');
}

function syncAuthNavigation(user) {
    const signedIn = Boolean(user);
    const authEntryPoints = document.querySelectorAll(
        '[data-auth-action="signup"], [data-auth-action="login"], .nav-cta-group, .nav-link-mobile'
    );
    authEntryPoints.forEach(entry => {
        entry.hidden = signedIn;
        if (signedIn) {
            entry.setAttribute('aria-hidden', 'true');
            entry.setAttribute('tabindex', '-1');
            entry.style.setProperty('display', 'none', 'important');
            entry.style.setProperty('pointer-events', 'none', 'important');
        } else {
            entry.removeAttribute('aria-hidden');
            entry.removeAttribute('tabindex');
            entry.style.removeProperty('display');
            entry.style.removeProperty('pointer-events');
        }
    });

    const creditsBadge = document.getElementById('creditsBadge');
    const creditsCount = document.getElementById('creditsCount');
    if (creditsBadge) creditsBadge.style.display = signedIn ? 'inline-flex' : 'none';
    if (creditsCount && !signedIn) creditsCount.textContent = '—';
    const chatSignInPrompt = document.getElementById('chatSignInPrompt');
    if (chatSignInPrompt) chatSignInPrompt.hidden = signedIn;
    const chatStatusText = document.getElementById('chatbotStatusText') || document.querySelector('.chatbot-info .status');
    if (chatStatusText) chatStatusText.textContent = signedIn ? 'AI chat • Online' : 'AI chat • Sign-in required';
    closeMobileMenu();
}

function applyAuthState(user) {
    currentUser = user || null;
    const revision = ++authStateRevision;
    syncAuthNavigation(currentUser);

    if (currentUser) renderUserAccount(currentUser);
    else removeUserAccountUI();

    window.setTimeout(() => {
        if (revision === authStateRevision) {
            void updateCreditsHeader(currentUser, revision);
        }
    }, 0);
}

if (supabaseClient) {
    if (supabaseClient.auth?.getSession) {
        supabaseClient.auth.getSession().then(({ data, error }) => {
            if (!error && data?.session?.user) {
                applyAuthState(data.session.user);
            }
        }).catch(err => {
            console.warn('Initial session restore notice:', err);
        });
    }
    supabaseClient.auth.onAuthStateChange((event, session) => {
        applyAuthState(session?.user || null);
        if (event === 'SIGNED_IN') closeLogin();
    });
}

window.addEventListener('load', () => {
    if (currentUser) syncAuthNavigation(currentUser);
}, { once: true });

setTimeout(() => {
    if (currentUser) syncAuthNavigation(currentUser);
}, 700);

async function updateCreditsHeader(user, revision = authStateRevision) {
    const creditsBadge = document.getElementById('creditsBadge');
    const creditsCount = document.getElementById('creditsCount');
    if (!creditsBadge) return;

    if (!user) {
        creditsBadge.style.display = 'none';
        if (creditsCount) creditsCount.textContent = '—';
        window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
        return;
    }

    creditsBadge.style.display = 'inline-flex';
    if (!creditsCount) return;

    creditsCount.textContent = '—';
    window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
    let data;
    try {
        const result = await supabaseClient
            .from('user_credits')
            .select('balance')
            .eq('user_id', user.id)
            .maybeSingle();
        if (result.error) throw result.error;
        data = result.data;
    } catch (error) {
        if (revision !== authStateRevision || currentUser?.id !== user.id) return;
        console.error('Credits fetch error:', error);
        creditsCount.textContent = '—';
        window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
        return;
    }

    if (revision !== authStateRevision || currentUser?.id !== user.id) return;

    if (!data) {
        // Missing row is a backend provisioning issue, not proof the user has zero credits.
        creditsCount.textContent = '—';
        console.warn('No user_credits row found. Run supabase/jevexa_saas_setup.sql.');
        window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
        return;
    }

    creditsCount.textContent = String(data.balance);
    window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
}

function initHeroFeatureOrbit() {
    const stage = document.getElementById('heroFeatureOrbit');
    const hoverTarget = document.querySelector('.ai-core-container');
    if (!stage || !hoverTarget) return;

    const featureGroups = [
        [
            { title: 'AI Chat', state: 'Live' },
            { title: 'Content Generation', state: 'Live' },
            { title: 'Credit Wallet', state: 'Live' }
        ],
        [
            { title: 'Document AI & OCR', state: 'Planned' },
            { title: 'Mini CRM', state: 'Planned' },
            { title: 'Email & Outreach AI', state: 'Planned' }
        ],
        [
            { title: 'Workflow Automation', state: 'Planned' },
            { title: 'Social Media Assistant', state: 'Planned' },
            { title: 'Business Analytics', state: 'Planned' }
        ]
    ];
    const cards = Array.from(stage.querySelectorAll('[data-hero-feature-card]'));
    if (cards.length !== featureGroups.length) return;

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timerId = null;
    const transitionIds = new Set();
    let hovered = false;
    const featureIndexes = [0, 0, 0];

    const reducedMotionEnabled = () => motionPreference.matches
        || document.documentElement.classList.contains('jevexa-reduce-motion');
    const clearTimers = () => {
        if (timerId !== null) window.clearTimeout(timerId);
        transitionIds.forEach(id => window.clearTimeout(id));
        timerId = null;
        transitionIds.clear();
    };
    const renderFeature = (card, feature, animate = false) => {
        const title = card.querySelector('.hero-orbit-title');
        const state = card.querySelector('.hero-orbit-state');
        if (!title || !state) return;
        const update = () => {
            title.textContent = feature.title;
            state.textContent = feature.state;
            card.setAttribute('aria-label', `${feature.title}: ${feature.state}`);
            card.classList.remove('is-changing');
        };
        if (!animate) {
            update();
            return;
        }
        card.classList.add('is-changing');
        let transitionId;
        transitionId = window.setTimeout(() => {
            transitionIds.delete(transitionId);
            update();
        }, 160);
        transitionIds.add(transitionId);
    };
    const resetToFirst = (reduced) => {
        clearTimers();
        stage.classList.toggle('is-reduced-motion', reduced);
        featureIndexes.fill(0);
        cards.forEach((card, index) => {
            card.classList.remove('is-changing');
            renderFeature(card, featureGroups[index][0]);
        });
    };
    const schedule = () => {
        if (hovered || reducedMotionEnabled() || document.hidden || timerId !== null) return;
        timerId = window.setTimeout(() => {
            timerId = null;
            cards.forEach((card, index) => {
                featureIndexes[index] = (featureIndexes[index] + 1) % featureGroups[index].length;
                renderFeature(card, featureGroups[index][featureIndexes[index]], true);
            });
            schedule();
        }, 2600);
    };
    const updateMotionPreference = () => {
        const reduced = reducedMotionEnabled();
        resetToFirst(reduced);
        schedule();
    };

    hoverTarget.addEventListener('mouseenter', () => {
        hovered = true;
        if (timerId !== null) window.clearTimeout(timerId);
        timerId = null;
        stage.classList.add('is-paused');
    });
    hoverTarget.addEventListener('mouseleave', () => {
        hovered = false;
        stage.classList.remove('is-paused');
        schedule();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (timerId !== null) window.clearTimeout(timerId);
            timerId = null;
            stage.classList.add('is-paused');
        } else {
            stage.classList.toggle('is-paused', hovered);
            schedule();
        }
    });
    window.addEventListener('jevexa-motion-change', updateMotionPreference);
    if (motionPreference.addEventListener) motionPreference.addEventListener('change', updateMotionPreference);
    else motionPreference.addListener?.(updateMotionPreference);

    updateMotionPreference();
}

initHeroFeatureOrbit();

// Optional animations are initialized only after the library loads successfully.
function initializeJevexaAnimations() {
    if (typeof window.AOS?.init !== 'function') return;

    if (!document.getElementById('jevexa-aos-styles')) {
        const stylesheet = document.createElement('link');
        stylesheet.id = 'jevexa-aos-styles';
        stylesheet.rel = 'stylesheet';
        stylesheet.href = 'https://unpkg.com/aos@2.3.1/dist/aos.css';
        stylesheet.media = 'print';
        stylesheet.addEventListener('load', () => { stylesheet.media = 'all'; }, { once: true });
        document.head.appendChild(stylesheet);
    }

    window.AOS.init({
        duration: 700,
        once: true,
        offset: 50,
        easing: 'ease-out-cubic',
        disable: window.matchMedia('(prefers-reduced-motion: reduce)').matches
    });
}
window.JEVEXA_INIT_AOS = initializeJevexaAnimations;
initializeJevexaAnimations();







// Navbar scroll



const navbar = document.getElementById('navbar');



const navLinks = document.querySelectorAll('.nav-link');
const scrollSections = document.querySelectorAll('section[id]');







let ticking = false;







window.addEventListener('scroll', () => {
    if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
            if (navbar) {
                if (window.scrollY > 50) navbar.classList.add('scrolled');
                else navbar.classList.remove('scrolled');
            }
            let current = '';
            const scrollY = window.scrollY;
            scrollSections.forEach(section => {
                if (scrollY >= section.offsetTop - 120) {
                    current = section.getAttribute('id');
                }
            });
            navLinks.forEach(link => {
                link.classList.remove('active');
                if (link.getAttribute('href') === `#${current}`) {
                    link.classList.add('active');
                }
            });
            ticking = false;
        });
    }
}, { passive: true });

// Mobile Menu



const mobileToggle = document.getElementById('mobileToggle');

const navLinksEl = document.getElementById('navLinks');

function closeMobileMenu() {
    document.getElementById('navLinks')?.classList.remove('open');
    const toggle = document.getElementById('mobileToggle');
    toggle?.classList.remove('active');
    toggle?.setAttribute('aria-expanded', 'false');
    toggle?.setAttribute('aria-label', 'Open navigation menu');
}

window.JEVEXA_SAFE_INTERACTION.bind(mobileToggle, 'click', () => {
    const isOpen = navLinksEl?.classList.toggle('open') ?? false;
    mobileToggle.classList.toggle('active', isOpen);
    mobileToggle.setAttribute('aria-expanded', String(isOpen));
    mobileToggle.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
});

window.JEVEXA_SAFE_INTERACTION.bind(document, 'click', (event) => {
    if (!navLinksEl?.classList.contains('open')) return;
    const clickInsideNav = navLinksEl.contains(event.target);
    const clickToggle = mobileToggle?.contains(event.target);
    if (!clickInsideNav && !clickToggle) {
          closeMobileMenu();
    }
}, {
    getKey: event => event.target instanceof Element ? event.target.closest('#mobileToggle, #navLinks') || event.target : document,
    preventDefaultOnDebounce: false
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && navLinksEl?.classList.contains('open')) {
          closeMobileMenu();
          mobileToggle?.focus();
    }
});

let mobileMenuResizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(mobileMenuResizeTimer);
    mobileMenuResizeTimer = window.setTimeout(() => {
        if (window.innerWidth > 768) closeMobileMenu();
    }, 150);
}, { passive: true });

function handleAuthNavigation(event) {
    if (currentUser) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
    const action = event.currentTarget.dataset.authAction;
    if (action !== 'login' && action !== 'signup') return;
    event.preventDefault();

    if (navLinksEl?.contains(event.currentTarget)) {
        closeMobileMenu();
        mobileToggle?.focus({ preventScroll: true });
    }
    openAuthModal(action);
}

navLinks.forEach(link => {

    window.JEVEXA_SAFE_INTERACTION.bind(link, 'click', (event) => {

          if (event.currentTarget.dataset.authAction) {
              handleAuthNavigation(event);
              return;
          }

          closeMobileMenu();

    });

});

document.querySelectorAll('.nav-actions [data-auth-action], .hero-ctas [data-auth-action]')
    .forEach(link => window.JEVEXA_SAFE_INTERACTION.bind(link, 'click', handleAuthNavigation));

window.JEVEXA_SAFE_INTERACTION.bind(document, 'click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const supportButton = target?.closest('#jevexaSupportBtn');
    if (!supportButton) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openJevexaSupport();
}, {
    matches: event => event.target instanceof Element && Boolean(event.target.closest('#jevexaSupportBtn')),
    getKey: event => event.target instanceof Element ? event.target.closest('#jevexaSupportBtn') || document : document,
    listenerOptions: true
});


// Counter Animation — smooth count-up when each counter becomes visible

function animateValue(el, target, duration = 1800, useComma = false, suffix = '') {



    if (!el || el.dataset.animated === '1') return;







    el.dataset.animated = '1';



    el.textContent = '0' + suffix;







    const start = performance.now();







    const update = (now) => {



        const progress = Math.min((now - start) / duration, 1);







        const eased = 1 - Math.pow(1 - progress, 3);



        const value = Math.floor(target * eased);







        el.textContent = (useComma ? value.toLocaleString() : value) + suffix;







        if (progress < 1) {



            requestAnimationFrame(update);



        } else {



            el.textContent = (useComma ? target.toLocaleString() : target) + suffix;



        }



    };







    requestAnimationFrame(update);



}







function animateCounterElement(el) {



    if (!el || !countersReady || el.dataset.animated === '1') return;







    const target = Number(el.getAttribute('data-count'));







    if (!Number.isFinite(target)) return;







    const isTaskCounter = el.classList.contains('count');







    animateValue(



        el,



        target,



        isTaskCounter ? 2200 : 1800,



        isTaskCounter,
        el.getAttribute('data-suffix') || ''



    );



}







function setupCounterObserver() {



    const counters = document.querySelectorAll('.stat-number, .status-value.count');







    if (!counters.length) return;







    if (!('IntersectionObserver' in window)) {



        counters.forEach(animateCounterElement);



        return;



    }







    counterObserver?.disconnect();







    counterObserver = new IntersectionObserver((entries) => {



        entries.forEach(entry => {



            if (entry.isIntersecting) {



                animateCounterElement(entry.target);



                counterObserver.unobserve(entry.target);



            }



        });



    }, {



        threshold: 0,



        rootMargin: '0px'



    });







    counters.forEach(counter => {



        counter.textContent = '0';



        counter.dataset.animated = '0';



        counterObserver.observe(counter);



    });



}







// Pricing Toggle — prices are configured once and annual equivalents are derived.
const PRICING_CONFIG = Object.freeze({
    annualDiscountRate: 0.2,
    plans: Object.freeze({
        starter: Object.freeze({ monthlyPrice: 5, annualEligible: true }),
        pro: Object.freeze({ monthlyPrice: 12, annualEligible: true }),
        business: Object.freeze({ monthlyPrice: 25, annualEligible: true }),
        ultra: Object.freeze({ monthlyPrice: 49, annualEligible: true })
    })
});

const packagePriceFormatters = [
    new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }),
    new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
];
const formatPackagePrice = (value, showCents = false) => packagePriceFormatters[Number(showCents)].format(value);

function initializePackagePricing() {
    Object.entries(PRICING_CONFIG.plans).forEach(([planName, plan]) => {
        const card = document.querySelector(`.price-card[data-pricing-plan="${planName}"]`);
        const amount = card?.querySelector('[data-plan-amount]');
        const period = card?.querySelector('[data-plan-period]');
        const original = card?.querySelector('[data-original-monthly]');
        const annualNote = card?.querySelector('[data-annual-price]');
        if (!card || !amount || !period) {
            console.error(`Pricing card markup is incomplete for "${planName}".`);
            return;
        }

        const annualEquivalent = plan.monthlyPrice * (1 - PRICING_CONFIG.annualDiscountRate);
        amount.dataset.monthly = String(plan.monthlyPrice);
        amount.dataset.yearly = String(plan.annualEligible ? annualEquivalent : plan.monthlyPrice);
        amount.dataset.annualEligible = String(plan.annualEligible);
        amount.textContent = formatPackagePrice(plan.monthlyPrice);
        period.dataset.monthlyLabel = plan.annualEligible ? 'monthly credit package' : 'credit package';
        period.dataset.yearlyLabel = plan.annualEligible ? 'per month (annual equivalent)' : 'credit package';
        if (!plan.annualEligible) return;
        if (!original || !annualNote) {
            console.error(`Annual pricing markup is incomplete for "${planName}".`);
            return;
        }
        original.textContent = `$${formatPackagePrice(plan.monthlyPrice)} / mo`;
        original.hidden = true;
        annualNote.textContent = `${formatPackagePrice(annualEquivalent * 12, true)} for 12 months, paid once`;
        annualNote.hidden = true;
        const badge20 = card.querySelector('[data-badge-20-off]');
        if (badge20) badge20.hidden = true;
        const discountTag = card.querySelector('[data-annual-discount]');
        if (discountTag) {
            discountTag.textContent = `Save ${formatPackagePrice(PRICING_CONFIG.annualDiscountRate * 100)}% with the annual package · paid once`;
        }
    });
}

initializePackagePricing();

function initializeLockedFeatureInteractions() {
    document.querySelectorAll('.feature-card').forEach(card => {
        if (card.querySelector('.service-chip.soon')) {
            card.style.cursor = 'pointer';
            window.JEVEXA_SAFE_INTERACTION.bind(card, 'click', (event) => {
                if (event.target.closest('a, button')) return;
                const featureName = card.querySelector('h3')?.textContent || 'this feature';
                const number = card.querySelector('.feature-number')?.textContent || '';
                const requiredPlan = ['06', '07'].includes(number) ? 'Pro' : ['08', '09', '10'].includes(number) ? 'Max' : 'Lite';
                openUpgradeModal(requiredPlan, featureName, card);
            });
        }
    });

    document.querySelectorAll('.hero-orbit-card').forEach(card => {
        window.JEVEXA_SAFE_INTERACTION.bind(card, 'click', (event) => {
            if (event.target.closest('a, button')) return;
            const state = card.querySelector('.hero-orbit-state')?.textContent || '';
            const title = card.querySelector('.hero-orbit-title')?.textContent || 'this feature';
            if (/planned|coming soon|locked/i.test(state)) {
                openUpgradeModal('Pro', title, card);
            }
        });
    });
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeLockedFeatureInteractions, { once: true });
} else {
    initializeLockedFeatureInteractions();
}


const billingToggle = document.getElementById('billingToggle');
const priceAnimationFrames = new WeakMap();







billingToggle?.addEventListener('change', () => {



    const yearly = billingToggle.checked;

    document.querySelectorAll('.price-card[data-pricing-plan]').forEach(card => {
        const plan = PRICING_CONFIG.plans[card.dataset.pricingPlan];
        const original = card.querySelector('[data-original-monthly]');
        const annualNote = card.querySelector('[data-annual-price]');
        if (!plan || !original || !annualNote) return;
        const showAnnual = yearly && plan.annualEligible;
        original.hidden = !showAnnual;
        annualNote.hidden = !showAnnual;
        const badge20 = card.querySelector('[data-badge-20-off]');
        if (badge20) badge20.hidden = !showAnnual;
    });







    document.querySelectorAll('.price-card .period[data-monthly-label][data-yearly-label]').forEach(el => {
        el.textContent = yearly ? el.dataset.yearlyLabel : el.dataset.monthlyLabel;
    });

    document.querySelectorAll('.price-card .amount[data-monthly][data-yearly]').forEach(el => {

        const previousFrame = priceAnimationFrames.get(el);
        if (previousFrame !== undefined) cancelAnimationFrame(previousFrame);

        const next = +(



            yearly



                ? el.getAttribute('data-yearly')



                : el.getAttribute('data-monthly')



        );







        const current = Number.parseFloat(el.textContent.replace(/,/g, '')) || 0;
        const showCents = yearly && el.dataset.annualEligible === 'true';







        el.dataset.animated = '0';







        const start = performance.now();



        const duration = 450;







        const update = (now) => {



            const progress = Math.min((now - start) / duration, 1);



            const eased = 1 - Math.pow(1 - progress, 3);







            el.textContent = formatPackagePrice(current + (next - current) * eased, showCents);







            if (progress < 1) {



                priceAnimationFrames.set(el, requestAnimationFrame(update));



            } else {



                el.textContent = formatPackagePrice(next, showCents);
                priceAnimationFrames.delete(el);



            }



        };







        priceAnimationFrames.set(el, requestAnimationFrame(update));



    });



});







// FAQ Accordion



document.querySelectorAll('.faq-question').forEach(btn => {



    window.JEVEXA_SAFE_INTERACTION.bind(btn, 'click', () => {



        const item = btn.parentElement;



        const isActive = item.classList.contains('active');







        document.querySelectorAll('.faq-item').forEach(i => {



            i.classList.remove('active');



            i.querySelector('.faq-question')?.setAttribute(



                'aria-expanded',



                'false'



            );



        });







        if (!isActive) {



            item.classList.add('active');



            btn.setAttribute('aria-expanded', 'true');



        }



    });



});







// ==========================================

// Contact Form — Supabase + Resend Email

// ==========================================

window.JEVEXA_SAFE_INTERACTION.bind(document.getElementById('contactForm'), 'submit', async (e) => {

    e.preventDefault();



    const form = e.target;



    const name = form.elements.name?.value.trim() || '';

    const email = form.elements.email?.value.trim() || '';

    const company = form.elements.company?.value.trim() || '';

    const message = form.elements.message?.value.trim() || '';



    if (!name || !email || !message) {

        showToast('⚠ Please fill in all required fields.');

        return;

    }



    const submitButton = form.querySelector('button[type="submit"]');

    const originalButtonText = submitButton?.innerHTML;



    if (submitButton) {

        submitButton.disabled = true;

        submitButton.innerHTML = 'Sending...';

    }



    const finalMessage =

        `Company: ${company || 'N/A'}\n\n` +

        `Automation request:\n${message}`;



    try {

        // 1. Save lead to Supabase

        const response = await fetch(

            `${SUPABASE_URL}/rest/v1/Contacts`,

            {

                method: 'POST',

                headers: {

                    'Content-Type': 'application/json',

                    'apikey': SUPABASE_KEY,

                    'Authorization': `Bearer ${SUPABASE_KEY}`,

                    'Prefer': 'return=minimal'

                },

                body: JSON.stringify({

                    name: name,

                    email: email,

                    message: finalMessage

                })

            }

        );



        if (!response.ok) {

            const errorText = await response.text();

            console.error('Supabase error:', errorText);

            throw new Error('Submission failed');

        }



        // 2. Send email notification through Cloudflare Worker + Resend

        try {

            const emailResponse = await fetch('/api/contact', {

                method: 'POST',

                headers: {

                    'Content-Type': 'application/json'

                },

                body: JSON.stringify({

                    name: name,

                    email: email,

                    company: company,

                    message: message

                })

            });



            if (!emailResponse.ok) {

                const emailError = await emailResponse.text();

                console.error('Resend notification error:', emailError);

            }

        } catch (emailError) {

            console.error('Email notification failed:', emailError);

        }



        showToast('✓ Your inquiry has been submitted successfully!');

        form.reset();



    } catch (error) {

        console.error('Contact form error:', error);

        showToast('✕ Something went wrong. Please try again.');



    } finally {

        if (submitButton) {

            submitButton.disabled = false;



            if (originalButtonText) {

                submitButton.innerHTML = originalButtonText;

            }

        }

    }

});





// Footer links that do not have live destination pages yet



document.querySelectorAll('.social, .coming-soon-link').forEach(link => {
    window.JEVEXA_SAFE_INTERACTION.bind(link, 'click', event => {
        event.preventDefault();
        event.stopPropagation();
        const page = link.dataset.page || 'This page';
        showToast(`${page} coming soon!`);
    });
});







let toastTimer = null;
function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        toastTimer = null;
    }, 3500);
}
window.JEVEXA_SHOW_UPGRADE_MODAL = openUpgradeModal;







/* ===== Premium AI Chatbot ===== */







const chatbotToggle = document.getElementById('chatbotToggle');



const chatbotWindow = document.getElementById('chatbotWindow');



const chatbotClose = document.getElementById('chatbotClose');
const chatSignInButton = document.getElementById('chatSignInButton');

function setChatbotToggleHidden(hidden) {
    if (!chatbotToggle) return;
    chatbotToggle.classList.toggle('hidden', hidden);
    chatbotToggle.setAttribute('aria-hidden', String(hidden));
    chatbotToggle.tabIndex = hidden ? -1 : 0;
}

function closeChatbot() {
    window.abortChatRequest?.();
    window.removeChatTyping?.();
    chatbotWindow?.classList.remove('open', 'chat-history-open');
    chatbotWindow?.setAttribute('aria-hidden', 'true');
    setChatbotToggleHidden(false);
    chatbotToggle?.setAttribute('aria-expanded', 'false');
    chatbotToggle?.setAttribute('aria-label', 'Open Jevexa AI');
    document.body.classList.remove('chat-modal-open');
    chatbotToggle?.focus();
}

window.JEVEXA_SAFE_INTERACTION.bind(chatbotToggle, 'click', () => {
    const isOpen = chatbotWindow?.classList.toggle('open') || false;
    setChatbotToggleHidden(isOpen);
    chatbotToggle.setAttribute('aria-expanded', String(isOpen));
    chatbotToggle.setAttribute('aria-label', isOpen ? 'Close Jevexa AI' : 'Open Jevexa AI');
    chatbotWindow?.setAttribute('aria-hidden', String(!isOpen));
    document.body.classList.toggle('chat-modal-open', isOpen);

    const badge = chatbotToggle.querySelector(
        '.ct-badge, .toggle-badge'
    );
    if (badge) badge.style.display = 'none';
    if (isOpen) document.getElementById('chatInput')?.focus();
    else chatbotToggle.focus();
});

window.JEVEXA_SAFE_INTERACTION.bind(chatbotClose, 'click', () => {
    closeChatbot();
});

document.addEventListener('keydown', event => {
    if (!chatbotWindow?.classList.contains('open')) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closeChatbot();
        return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(chatbotWindow.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary'
    )).filter(element => !element.hidden && element.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
});

window.JEVEXA_SAFE_INTERACTION.bind(chatSignInButton, 'click', () => openLogin());







// ===== Lightweight Particles (optimized) =====



const canvas = document.getElementById('particles-canvas');
const particleMotionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');







if (



    canvas &&

    window.innerWidth >= 768



) {



    const ctx = canvas.getContext('2d');







    let particles = [];



    let w, h;







    const COUNT = 24;







    function resize() {



        w = canvas.width = window.innerWidth;



        h = canvas.height = window.innerHeight;



    }







    resize();







    let resizeTimer;







    window.addEventListener('resize', () => {



        clearTimeout(resizeTimer);







        resizeTimer = setTimeout(resize, 150);



    }, { passive: true });







    class Particle {



        constructor() {



            this.reset();



        }







        reset() {



            this.x = Math.random() * w;



            this.y = Math.random() * h;



            this.size = Math.random() * 1.8 + 0.4;



            this.speedX = (Math.random() - 0.5) * 0.3;



            this.speedY = (Math.random() - 0.5) * 0.3;



            this.opacity = Math.random() * 0.4 + 0.1;







            const colors = [



                '139,92,246',



                '34,211,238',



                '232,121,249'



            ];







            this.color =



                colors[Math.floor(Math.random() * colors.length)];



        }







        update() {



            this.x += this.speedX;



            this.y += this.speedY;







            if (



                this.x < 0 ||



                this.x > w ||



                this.y < 0 ||



                this.y > h



            ) {



                this.reset();



            }



        }







        draw() {



            ctx.beginPath();







            ctx.arc(



                this.x,



                this.y,



                this.size,



                0,



                Math.PI * 2



            );







            ctx.fillStyle =



                `rgba(${this.color},${this.opacity})`;







            ctx.fill();



        }



    }







    for (let i = 0; i < COUNT; i++) {



        particles.push(new Particle());



    }







    function connect() {



        for (let i = 0; i < particles.length; i++) {



            for (



                let j = i + 1;



                j < Math.min(i + 8, particles.length);



                j++



            ) {



                const dx =



                    particles[i].x - particles[j].x;







                const dy =



                    particles[i].y - particles[j].y;







                const dist =



                    dx * dx + dy * dy;







                if (dist < 10000) {



                    ctx.beginPath();







                    ctx.strokeStyle =



                        `rgba(139,92,246,${0.06 * (1 - dist / 10000)})`;







                    ctx.lineWidth = 0.4;







                    ctx.moveTo(



                        particles[i].x,



                        particles[i].y



                    );







                    ctx.lineTo(



                        particles[j].x,



                        particles[j].y



                    );







                    ctx.stroke();



                }



            }



        }



    }







    let last = 0;
    let animationFrame = 0;

    function shouldAnimate() {
        return !document.hidden
            && !particleMotionPreference.matches
            && !document.documentElement.classList.contains('jevexa-reduce-motion')
            && window.innerWidth >= 768;
    }



    function animate(t) {

        animationFrame = 0;
        if (!shouldAnimate()) return;

        if (t - last > 32) {



            last = t;







            ctx.clearRect(



                0,



                0,



                w,



                h



            );







            particles.forEach(p => {



                p.update();



                p.draw();



            });







            connect();



        }







        animationFrame = requestAnimationFrame(animate);



    }

    function updateParticleLoop() {
        if (shouldAnimate()) {
            if (!animationFrame) animationFrame = requestAnimationFrame(animate);
        } else if (animationFrame) {
            cancelAnimationFrame(animationFrame);
            animationFrame = 0;
        }
    }

    document.addEventListener('visibilitychange', updateParticleLoop);
    particleMotionPreference.addEventListener?.('change', updateParticleLoop);
    window.addEventListener('jevexa-motion-change', updateParticleLoop);
    window.addEventListener('resize', updateParticleLoop, { passive: true });
    updateParticleLoop();



}

// ===== JEVEXA PRICING PLANS =====
const JEVEXA_PLANS = {
    starter: { name: 'Lite' },
    pro: { name: 'Pro' },
    business: { name: 'Max' },
    ultra: { name: 'Ultra' }
};
// ============================================================
// JEVEXA CONSOLIDATED SETTINGS + PRICING CONTROLLER
// Core account controls are real; billing checkout and AI providers
// must be configured server-side before checkout/AI execution.
// ============================================================
(function () {
    const toast = message => {
        if (typeof showToast === 'function') showToast(message);
        else console.info('[JEVEXA]', message);
    };
    const sandboxCheckoutAvailable = window.JEVEXA_SUPABASE_CONFIG?.safepaySandboxEnabled === true;
    const checkoutNotice = document.getElementById('pricingCheckoutNotice');
    if (checkoutNotice && sandboxCheckoutAvailable) {
        checkoutNotice.textContent = 'Safepay sandbox checkout is enabled for staging tests only. Purchases are one-time and do not auto-renew.';
    }
    document.querySelectorAll('[data-plan]').forEach(button => {
        const plan = JEVEXA_PLANS[button.dataset.plan];
        if (!plan) return;
        button.disabled = !sandboxCheckoutAvailable;
        button.textContent = sandboxCheckoutAvailable ? `Choose ${plan.name} (staging)` : 'Coming Soon';
    });
    const safeTheme = theme => ['dark', 'light', 'system'].includes(theme) ? theme : 'dark';

    function applyThemeChoice(theme, button) {
        theme = safeTheme(theme);
        applyJevexaTheme(theme);
        document.querySelectorAll('#settingsPanel [data-theme-choice]').forEach(item => {
            item.classList.toggle('active', item.dataset.themeChoice === theme);
        });
        if (currentUser) localStorage.setItem(`jevexa_${currentUser.id}_theme`, theme);
        toast(`${theme.charAt(0).toUpperCase() + theme.slice(1)} theme applied.`);
    }

    window.JEVEXA_SAFE_INTERACTION.bind(document, 'click', async event => {
        const themeButton = event.target.closest('#settingsPanel [data-theme-choice]');
        if (themeButton) {
            event.preventDefault();
            applyThemeChoice(themeButton.dataset.themeChoice, themeButton);
            return;
        }

        const planButton = event.target.closest('[data-plan]');
        if (planButton) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!sandboxCheckoutAvailable) {
                toast('Paid checkout is not available yet. Live payments require merchant approval, production credentials and a verified signed webhook.');
                const planKey = planButton.dataset.plan;
                const planInfo = JEVEXA_PLANS?.[planKey] || { name: 'Pro' };
                openUpgradeModal(planInfo.name, `${planInfo.name} Plan`, planButton);
                return;
            }
            const plan = JEVEXA_PLANS?.[planButton.dataset.plan];
            const cycle = document.getElementById('billingToggle')?.checked ? 'yearly' : 'monthly';
            if (!plan) { toast('This plan is not available.'); return; }
            if (!currentUser) { openLogin(); return; }
            if (!supabaseClient) {
                showSupabaseUnavailable();
                return;
            }
            let sessionData;
            try {
                ({ data: sessionData } = await supabaseClient.auth.getSession());
            } catch (error) {
                console.error('Checkout session verification failed:', error);
                toast('Could not verify your session. Please sign in again.');
                openLogin();
                return;
            }
            const accessToken = sessionData?.session?.access_token;
            if (!accessToken) { toast('Your session expired. Please sign in again.'); openLogin(); return; }
            const originalText = planButton.textContent;
            planButton.disabled = true;
            planButton.textContent = 'Opening secure checkout…';
            try {
                const response = await fetch('/api/billing/checkout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
                    body: JSON.stringify({ plan: planButton.dataset.plan, cycle })
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || !result.checkoutUrl) throw new Error(result.error || 'Could not start checkout.');
                window.location.assign(result.checkoutUrl);
            } catch (error) {
                toast(error?.message || 'Checkout is temporarily unavailable.');
                planButton.disabled = false;
                planButton.textContent = originalText;
            }
            return;
        }
    }, {
        matches: event => event.target instanceof Element
            && Boolean(event.target.closest('#settingsPanel [data-theme-choice], [data-plan]')),
        getKey: event => event.target instanceof Element
            ? event.target.closest('#settingsPanel [data-theme-choice], [data-plan]') || document
            : document,
        listenerOptions: true
    });

    document.addEventListener('change', event => {
        const toggle = event.target;
        if (toggle.id === 'settingsReduceMotion') {
            document.documentElement.classList.toggle('jevexa-reduce-motion', toggle.checked);
            window.dispatchEvent(new Event('jevexa-motion-change'));
        }
        if (toggle.id === 'settingsCompact') {
            document.documentElement.classList.toggle('jevexa-compact', toggle.checked);
        }
    });

    // Apply persisted interface preferences when a user session is available.
    function applyUserPreferences(user) {
        if (!user) {
            document.documentElement.classList.remove('jevexa-reduce-motion', 'jevexa-compact');
            window.dispatchEvent(new Event('jevexa-motion-change'));
            return;
        }
        const prefix = `jevexa_${user.id}_`;
        const theme = localStorage.getItem(prefix + 'theme');
        if (theme) applyJevexaTheme(safeTheme(theme));
        document.documentElement.classList.toggle('jevexa-reduce-motion', localStorage.getItem(prefix + 'reduce_motion') === 'true');
        document.documentElement.classList.toggle('jevexa-compact', localStorage.getItem(prefix + 'compact') === 'true');
        window.dispatchEvent(new Event('jevexa-motion-change'));
    }

    const priorRender = window.renderUserAccount;
    if (typeof priorRender === 'function') {
        // Existing global function is retained; the auth state handler below reapplies preferences.
        window.renderUserAccount = priorRender;
    }
    if (supabaseClient) {
        supabaseClient.auth.onAuthStateChange((_event, session) => applyUserPreferences(session?.user || null));
    }
    setTimeout(() => applyUserPreferences(currentUser), 0);

    window.JEVEXA_SETTINGS = {
        open: () => currentUser ? openSettingsView(currentUser) : openLogin(),
        refreshCredits: async () => {
            if (!currentUser || !supabaseClient) return null;
            const { data, error } = await supabaseClient.from('user_credits')
                .select('balance, monthly_allowance').eq('user_id', currentUser.id).maybeSingle();
            if (error) {
                console.error('Credits refresh error:', error);
                const count = document.getElementById('creditsCount');
                if (count) count.textContent = '—';
                const status = document.getElementById('settingsCreditStatus');
                if (status) status.textContent = 'Could not refresh credits. Please try again.';
                toast('Could not refresh credits.');
                return null;
            }
            if (data) {
                const count = document.getElementById('creditsCount');
                if (count) count.textContent = String(data.balance);
                const balance = document.getElementById('settingsBalance');
                const allowance = document.getElementById('settingsAllowance');
                const status = document.getElementById('settingsCreditStatus');
                if (balance) balance.textContent = String(data.balance);
                if (allowance) allowance.textContent = String(data.monthly_allowance ?? '—');
                if (status) status.textContent = 'Balance loaded from your account.';
                window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();
            } else {
                const balance = document.getElementById('settingsBalance');
                const status = document.getElementById('settingsCreditStatus');
                if (balance) balance.textContent = 'Not set up';
                if (status) status.textContent = 'No credit account exists for this user yet.';
            }
            return data;
        }
    };
})();

/* Settings-only styling: responsive, restrained and accessible. */
(function () {
    if (document.getElementById('jevexaSettingsStyle')) return;
    const style = document.createElement('style');
    style.id = 'jevexaSettingsStyle';
    style.textContent = `
      #settingsPanel{width:min(1040px,96vw);height:min(740px,90vh);display:flex;overflow:hidden;border:1px solid rgba(139,92,246,.28);border-radius:22px;background:radial-gradient(circle at top right,rgba(139,92,246,.12),transparent 35%),var(--bg-2,#0a0a1a);color:var(--text,#f0f0ff);box-shadow:0 30px 100px rgba(0,0,0,.55)}
      #settingsPanel>aside{width:260px;flex-shrink:0;padding:22px 14px;border-right:1px solid var(--border,rgba(255,255,255,.1));display:flex;flex-direction:column;overflow-y:auto}
      #settingsPanel .settings-brand{display:grid;gap:4px;padding:4px 10px 20px}.settings-brand span,.settings-eyebrow{font-size:10px;letter-spacing:1.5px;font-weight:800;color:var(--primary-light,#a78bfa)}.settings-brand strong{font-size:21px}.settings-brand small,.jevexa-settings-nav small{font-size:11px;color:var(--text-muted,#a0a0c0)}
      #settingsPanel #settingsNav{display:grid;gap:5px}.jevexa-settings-nav{display:flex;align-items:center;gap:11px;width:100%;padding:11px 10px;text-align:left;border:1px solid transparent;border-radius:12px;background:transparent;color:var(--text-muted,#a0a0c0);cursor:pointer}.jevexa-settings-nav.active{background:rgba(139,92,246,.14);border-color:var(--border,rgba(139,92,246,.25));color:var(--text,#fff)}.jevexa-settings-nav>span:last-child{display:grid;gap:3px}.jevexa-settings-nav strong{font-size:13px}.settings-nav-icon{font-size:18px;width:25px;text-align:center}.settings-logout-btn{margin-top:auto;margin-top:22px;padding:11px;border-radius:11px;border:1px solid rgba(248,113,113,.25);background:rgba(248,113,113,.06);color:#fca5a5;cursor:pointer}
      #settingsPanel>main{flex:1;min-width:0;overflow-y:auto;padding:26px}.settings-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.settings-topbar h2{font-size:26px;margin:5px 0 0}.settings-close{width:38px;height:38px;border-radius:11px;border:1px solid var(--border,rgba(255,255,255,.12));background:rgba(255,255,255,.04);color:inherit;font-size:24px;cursor:pointer}
      .settings-card{padding:20px;margin-bottom:15px;border:1px solid var(--border,rgba(139,92,246,.2));border-radius:16px;background:rgba(255,255,255,.025)}.settings-card-heading h3{font-size:15px;margin:0 0 4px}.settings-card-heading p,.settings-muted{font-size:12px;line-height:1.6;color:var(--text-muted,#a0a0c0);margin:0 0 16px}.settings-form{display:grid;gap:13px}.settings-form label{display:grid;gap:7px;font-size:12px;color:var(--text-muted,#a0a0c0)}#settingsPanel input:not([type=checkbox]),#settingsPanel select,#settingsPanel textarea{width:100%;padding:11px 12px;border:1px solid var(--border,rgba(139,92,246,.25));border-radius:10px;background:rgba(0,0,0,.15);color:var(--text,#f0f0ff);outline:none}#settingsPanel input:focus,#settingsPanel select:focus,#settingsPanel textarea:focus{border-color:var(--primary,#8b5cf6)}#settingsPanel input:disabled{opacity:.65}.settings-action-btn,.settings-secondary-btn{padding:10px 13px;border-radius:10px;border:1px solid rgba(139,92,246,.35);background:rgba(139,92,246,.16);color:inherit;font-size:12px;font-weight:700;cursor:pointer}.settings-secondary-btn{background:transparent;border-color:var(--border,rgba(255,255,255,.15))}.settings-action-btn:disabled{opacity:.6;cursor:wait}.settings-info-row,.settings-transaction{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.07);font-size:12px}.settings-info-row:last-child,.settings-transaction:last-child{border-bottom:0}.settings-info-row span,.settings-transaction small{color:var(--text-muted,#a0a0c0)}.settings-choice-grid{display:flex;gap:8px;flex-wrap:wrap}.settings-choice{padding:10px 13px;border:1px solid var(--border,rgba(255,255,255,.15));border-radius:10px;background:transparent;color:inherit;cursor:pointer}.settings-choice.active{background:rgba(139,92,246,.18);border-color:var(--primary,#8b5cf6)}.settings-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.07)}.settings-toggle-row:last-of-type{border-bottom:0}.settings-toggle-row span{display:grid;gap:3px}.settings-toggle-row strong{font-size:13px}.settings-toggle-row small{font-size:11px;color:var(--text-muted,#a0a0c0)}.settings-toggle-row input{width:18px;height:18px;accent-color:var(--primary,#8b5cf6)}.settings-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.settings-stats>div{padding:13px;border-radius:12px;background:rgba(139,92,246,.08);display:grid;gap:7px}.settings-stats small{font-size:11px;color:var(--text-muted,#a0a0c0)}.settings-stats strong{font-size:21px;overflow-wrap:anywhere}.settings-transaction>span{display:grid;gap:4px}.settings-transaction strong{font-size:12px}.settings-transaction b{font-size:13px}
      html.jevexa-reduce-motion *,html.jevexa-reduce-motion *::before,html.jevexa-reduce-motion *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.01ms!important}html.jevexa-compact .settings-card{padding:14px}html.jevexa-compact #settingsPanel>main{padding:20px}
      @media(max-width:700px){#settingsPanel{width:100%;height:100dvh;max-height:100dvh;border-radius:0;flex-direction:column}#settingsPanel>aside{width:100%;max-height:220px;padding:12px;border-right:0;border-bottom:1px solid var(--border,rgba(255,255,255,.1))}#settingsPanel .settings-brand{padding:3px 6px 10px}.settings-brand strong{font-size:17px}#settingsPanel #settingsNav{display:flex;overflow-x:auto;padding-bottom:4px}.jevexa-settings-nav{min-width:150px;padding:8px}.settings-logout-btn{position:absolute;right:64px;top:12px;margin:0;padding:8px 10px}#settingsPanel>main{padding:17px}.settings-stats{grid-template-columns:1fr}.settings-topbar h2{font-size:22px}}
    `;
    document.head.appendChild(style);
})();


// Safepay return pages are informational only. Credits are granted by the signed server webhook.
(function handleSafepayReturn() {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get('payment');
    if (!payment) return;
    if (payment === 'cancelled') {
        if (typeof showToast === 'function') showToast('Payment cancelled. No credits were added. You can try again anytime.');
        params.delete('payment');
        const clean = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}${window.location.hash}`;
        history.replaceState({}, '', clean);
        return;
    }
    if (payment !== 'return') return;
    const tracker = params.get('tracker');
    if (typeof showToast === 'function') showToast('Payment returned from Safepay. Verifying securely…');
    (async () => {
        const { data } = await supabaseClient.auth.getSession();
        const token = data?.session?.access_token;
        if (!token || !tracker) {
            if (typeof showToast === 'function') showToast('Payment is awaiting server verification. Sign in and refresh Credits & Usage shortly.');
            return;
        }
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                const response = await fetch(`/api/billing/status?tracker=${encodeURIComponent(tracker)}`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                const status = await response.json().catch(() => ({}));
                if (status.status === 'paid') {
                    if (typeof showToast === 'function') showToast('Payment verified! Your credits have been added.');
                    if (window.JEVEXA_SETTINGS?.refreshCredits) await window.JEVEXA_SETTINGS.refreshCredits();
                    break;
                }
                if (status.status === 'failed' || status.status === 'cancelled') {
                    if (typeof showToast === 'function') showToast('Payment was not completed. No paid credits were added.');
                    break;
                }
            } catch (error) { console.warn('Payment status check failed.'); }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        params.delete('payment');
        const clean = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}${window.location.hash}`;
        history.replaceState({}, '', clean);
    })();
})();

// ==========================================================================
// JEVEXA AI STUDIO 2.0 — LAUNCHER & WORKSPACE ROUTING ARCHITECTURE
// ==========================================================================
(function initJevexaStudioWorkspaces() {
    // 1. Single Scalable Configuration Array for AI Tools
    const toolsConfig = [
        {
            id: 'chatbot',
            name: 'AI Chatbot (Jevexa AI)',
            shortName: 'AI Chatbot',
            tagline: 'Multi-model reasoning assistant with real-time web intelligence and file analysis.',
            icon: 'fas fa-comments',
            status: 'live',
            route: '/tools/chatbot',
            badge: 'LIVE NOW',
            badgeType: 'live',
            actionText: 'Open Workspace'
        },
        {
            id: 'content-generator',
            name: 'Content Generation',
            shortName: 'Content AI',
            tagline: 'High-converting business copy, articles, social captions, and email campaigns.',
            icon: 'fas fa-pen-nib',
            status: 'live',
            route: '/tools/content-generator',
            badge: 'LIVE NOW',
            badgeType: 'live',
            actionText: 'Open Workspace'
        },
        {
            id: 'email-outreach',
            name: 'Email & Outreach AI',
            shortName: 'Outreach AI',
            tagline: 'Personalized cold outreach sequences, follow-ups, and inbox automation.',
            icon: 'fas fa-envelope-open-text',
            status: 'coming_soon',
            route: '/tools/email-outreach',
            badge: 'COMING SOON',
            badgeType: 'locked',
            actionText: 'Click for release info'
        },
        {
            id: 'crm',
            name: 'Mini CRM',
            shortName: 'Mini CRM',
            tagline: 'Pipeline deal tracking, contact timeline history, and lead scoring.',
            icon: 'fas fa-address-book',
            status: 'coming_soon',
            route: '/tools/crm',
            badge: 'COMING SOON',
            badgeType: 'locked',
            actionText: 'Click for release info'
        },
        {
            id: 'ocr',
            name: 'Document AI & OCR',
            shortName: 'Doc OCR',
            tagline: 'Automated data extraction from invoices, receipts, and PDF contracts.',
            icon: 'fas fa-file-lines',
            status: 'coming_soon',
            route: '/tools/ocr',
            badge: 'COMING SOON',
            badgeType: 'locked',
            actionText: 'Click for release info'
        },
        {
            id: 'social',
            name: 'Social Media Assistant',
            shortName: 'Social AI',
            tagline: 'Viral caption drafting, platform scheduling, and engagement analytics.',
            icon: 'fas fa-hashtag',
            status: 'coming_soon',
            route: '/tools/social',
            badge: 'COMING SOON',
            badgeType: 'locked',
            actionText: 'Click for release info'
        },
        {
            id: 'analytics',
            name: 'Business Analytics',
            shortName: 'Analytics AI',
            tagline: 'Real-time KPI dashboards, revenue forecasting, and growth metrics.',
            icon: 'fas fa-chart-line',
            status: 'coming_soon',
            route: '/tools/analytics',
            badge: 'COMING SOON',
            badgeType: 'locked',
            actionText: 'Click for release info'
        },
        {
            id: 'admin',
            name: 'User & Admin Management',
            shortName: 'Team Admin',
            tagline: 'Granular team permissions, seat provisioning, and enterprise audit logs.',
            icon: 'fas fa-users-gear',
            status: 'coming_soon',
            route: '/tools/admin',
            badge: 'COMING SOON',
            badgeType: 'locked',
            actionText: 'Click for release info'
        },
        {
            id: 'workflows',
            name: 'Workflow Automation',
            shortName: 'Workflows',
            tagline: 'Autonomous multi-step sequence builder connecting your entire tool stack.',
            icon: 'fas fa-diagram-project',
            status: 'coming_soon',
            route: '/tools/workflows',
            badge: 'COMING SOON',
            badgeType: 'locked',
            actionText: 'Click for release info'
        },
        {
            id: 'data',
            name: 'Data Management',
            shortName: 'Data AI',
            tagline: 'Automated data cleaning, deduplication, and schema synchronization.',
            icon: 'fas fa-database',
            status: 'coming_soon',
            route: '/tools/data',
            badge: 'COMING SOON',
            badgeType: 'locked',
            actionText: 'Click for release info'
        }
    ];
    window.JEVEXA_TOOLS_CONFIG = toolsConfig;

    // DOM Elements
    const contentWorkspace = document.getElementById('contentWorkspace');
    const chatbotWindow = document.getElementById('chatbotWindow');
    const comingSoonModal = document.getElementById('comingSoonModal');
    const topicTextarea = document.getElementById('contentTopic');
    const charCountDisplay = document.getElementById('contentCharCount');

    // Helper: Safely bind interactions using JEVEXA_SAFE_INTERACTION
    function bindAction(element, eventType, handler) {
        if (!element) return;
        if (window.JEVEXA_SAFE_INTERACTION?.bind) {
            window.JEVEXA_SAFE_INTERACTION.bind(element, eventType, handler);
        } else {
            element.addEventListener(eventType, handler);
        }
    }

    // Synchronize workspace credit badges
    function syncWorkspaceCredits() {
        const countEl = document.getElementById('creditsCount');
        const raw = countEl ? countEl.textContent.trim() : '';
        const count = raw && raw !== '—' && raw !== '…' && raw !== '...' ? raw : (currentUser ? '…' : '—');
        document.querySelectorAll('.workspace-credits-val').forEach(el => {
            el.textContent = count;
        });
    }
    window.JEVEXA_SYNC_WORKSPACE_CREDITS = syncWorkspaceCredits;

    // Coming Soon Notification / Modal
    function showComingSoonPopup(toolName) {
        const message = '🔒 Coming Soon! This AI tool is currently under development and will be unlocked soon.';
        if (typeof showToast === 'function') {
            showToast(message);
        }
        if (comingSoonModal) {
            const titleEl = document.getElementById('comingSoonToolTitle');
            const descEl = document.getElementById('comingSoonToolDesc');
            if (titleEl) titleEl.textContent = toolName ? `🔒 ${toolName}` : '🔒 Coming Soon';
            if (descEl) descEl.textContent = message;
            comingSoonModal.hidden = false;
            comingSoonModal.removeAttribute('hidden');
            comingSoonModal.classList.add('is-open', 'open');
            comingSoonModal.style.setProperty('display', 'flex', 'important');
            comingSoonModal.setAttribute('aria-hidden', 'false');
            document.body.classList.add('coming-soon-open');
        }
    }

    function closeComingSoonModal() {
        if (!comingSoonModal) return;
        comingSoonModal.classList.remove('is-open', 'open');
        comingSoonModal.setAttribute('aria-hidden', 'true');
        comingSoonModal.setAttribute('hidden', '');
        comingSoonModal.hidden = true;
        comingSoonModal.style.setProperty('display', 'none', 'important');
        document.body.classList.remove('coming-soon-open');
    }

    window.closeComingSoonModal = closeComingSoonModal;
    window.showComingSoonPopup = showComingSoonPopup;

    // Workspaces Control
    function openChatWorkspace(pushState = true) {
        closeContentWorkspace(false);
        closeComingSoonModal();
        if (chatbotWindow) {
            chatbotWindow.classList.add('open');
            chatbotWindow.setAttribute('aria-hidden', 'false');
            document.body.classList.add('chat-modal-open');
            if (typeof setChatbotToggleHidden === 'function') setChatbotToggleHidden(true);
            syncWorkspaceCredits();
            document.getElementById('chatInput')?.focus();
        }
        if (pushState) {
            navigateToRoute('/tools/chatbot');
        }
    }

    function closeChatWorkspace(pushState = true) {
        window.abortChatRequest?.();
        window.removeChatTyping?.();
        if (chatbotWindow) {
            chatbotWindow.classList.remove('open', 'chat-history-open');
            chatbotWindow.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('chat-modal-open');
            if (typeof setChatbotToggleHidden === 'function') setChatbotToggleHidden(false);
        }
        if (pushState) {
            returnToStudio();
        }
    }

    function openContentWorkspace(pushState = true) {
        closeChatWorkspace(false);
        closeComingSoonModal();
        if (contentWorkspace) {
            contentWorkspace.hidden = false;
            contentWorkspace.classList.add('open');
            contentWorkspace.setAttribute('aria-hidden', 'false');
            document.body.classList.add('workspace-open');
            syncWorkspaceCredits();
            topicTextarea?.focus();
        }
        if (pushState) {
            navigateToRoute('/tools/content-generator');
        }
    }

    function closeContentWorkspace(pushState = true) {
        window.clearContentProcessing?.();
        if (contentWorkspace) {
            contentWorkspace.classList.remove('open');
            contentWorkspace.setAttribute('aria-hidden', 'true');
            contentWorkspace.hidden = true;
            document.body.classList.remove('workspace-open');
        }
        if (pushState) {
            returnToStudio();
        }
    }

    function returnToStudio() {
        closeChatWorkspace(false);
        closeContentWorkspace(false);
        closeComingSoonModal();
        const currentPath = window.location.pathname;
        const currentHash = window.location.hash;
        if (currentPath.startsWith('/tools') || currentHash.startsWith('#/tools')) {
            try {
                window.history.pushState(null, '', '/');
            } catch (_) {
                window.location.hash = '';
            }
        }
    }

    // Routing Manager
    function navigateToRoute(route) {
        const currentPath = window.location.pathname;
        const currentHash = window.location.hash;
        if (currentPath !== route && currentHash !== '#' + route) {
            try {
                window.history.pushState({ route }, '', route);
            } catch (_) {
                window.location.hash = '#' + route;
            }
        }
    }

    function handleCurrentRoute() {
        const path = window.location.pathname;
        const hash = window.location.hash;
        if (path === '/tools/chatbot' || hash === '#/tools/chatbot') {
            openChatWorkspace(false);
        } else if (path === '/tools/content-generator' || hash === '#/tools/content-generator') {
            openContentWorkspace(false);
        } else if (path.startsWith('/tools/') || hash.startsWith('#/tools/')) {
            const toolId = path.replace(/^\/tools\//, '') || hash.replace(/^#\/tools\//, '');
            const tool = toolsConfig.find(t => t.id === toolId || t.route === path || t.route === hash.replace(/^#/, ''));
            if (tool && tool.status === 'live') {
                if (tool.id === 'chatbot') openChatWorkspace(false);
                else if (tool.id === 'content-generator') openContentWorkspace(false);
            } else if (tool && tool.status === 'coming_soon') {
                returnToStudio();
                showComingSoonPopup(tool.name);
            } else {
                returnToStudio();
            }
        }
    }

    // Expose Global Studio API
    window.JEVEXA_STUDIO = {
        openChat: () => openChatWorkspace(true),
        openContent: () => openContentWorkspace(true),
        closeWorkspaces: returnToStudio,
        showComingSoon: showComingSoonPopup,
        closeComingSoon: closeComingSoonModal,
        tools: toolsConfig
    };

    // Card Interactivity in AI Tools Launcher
    document.querySelectorAll('.tool-launcher-card').forEach(card => {
        const toolId = card.dataset.toolId;
        const status = card.dataset.status;
        const tool = toolsConfig.find(t => t.id === toolId);

        const handleCardAction = () => {
            if (status === 'live' || tool?.status === 'live') {
                if (toolId === 'chatbot') {
                    openChatWorkspace(true);
                } else if (toolId === 'content-generator') {
                    openContentWorkspace(true);
                }
            } else {
                showComingSoonPopup(tool?.name || card.querySelector('.tool-card-title')?.textContent?.trim());
            }
        };

        bindAction(card, 'click', handleCardAction);

        card.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleCardAction();
            }
        });
    });

    // Launcher Filter Tabs
    document.querySelectorAll('.launcher-tab').forEach(tab => {
        bindAction(tab, 'click', () => {
            const filter = tab.dataset.toolFilter;
            document.querySelectorAll('.launcher-tab').forEach(t => {
                t.classList.toggle('active', t === tab);
                t.setAttribute('aria-selected', String(t === tab));
            });

            document.querySelectorAll('.tool-launcher-card').forEach(card => {
                const status = card.dataset.status;
                const shouldShow = filter === 'all' || status === filter;
                card.classList.toggle('is-filtered-out', !shouldShow);
            });
        });
    });

    // Content Topic Character Count
    if (topicTextarea && charCountDisplay) {
        topicTextarea.addEventListener('input', () => {
            charCountDisplay.textContent = `${topicTextarea.value.length} / 1000`;
        });
    }

    // "← Back to Studio" and Close buttons
    bindAction(document.getElementById('chatBackToStudio'), 'click', () => returnToStudio());
    bindAction(document.getElementById('contentBackToStudio'), 'click', () => returnToStudio());
    bindAction(document.getElementById('contentWorkspaceClose'), 'click', () => returnToStudio());
    document.querySelectorAll('.content-tool-link').forEach(link => {
        bindAction(link, 'click', (event) => {
            event.preventDefault();
            openContentWorkspace(true);
        });
    });

    // Coming Soon Modal buttons
    bindAction(document.getElementById('comingSoonCloseBtn'), 'click', closeComingSoonModal);
    bindAction(document.getElementById('comingSoonConfirmBtn'), 'click', closeComingSoonModal);
    bindAction(document.getElementById('comingSoonBackdrop'), 'click', closeComingSoonModal);
    bindAction(document.getElementById('comingSoonExploreBtn'), 'click', (event) => {
        if (event) event.preventDefault();
        closeComingSoonModal();
        returnToStudio();
        const roadmapTab = document.querySelector('.launcher-tab[data-tool-filter="coming_soon"]');
        if (roadmapTab) {
            roadmapTab.click();
        }
        const featuresSec = document.getElementById('features') || document.querySelector('.hero-tools-launcher');
        if (featuresSec) {
            featuresSec.scrollIntoView({ behavior: 'smooth' });
        }
    });

    // Outer modal container click fallback
    if (comingSoonModal) {
        bindAction(comingSoonModal, 'click', (event) => {
            if (event.target === comingSoonModal) {
                closeComingSoonModal();
            }
        });
    }

    // Delegated safe click handler on document to guarantee dismissibility
    bindAction(document, 'click', (event) => {
        const target = event.target;
        if (!target || !(target instanceof Element)) return;

        if (target.closest('#comingSoonCloseBtn, #comingSoonConfirmBtn, [data-action="close-coming-soon"], .coming-soon-close')) {
            closeComingSoonModal();
        } else if (target.closest('#comingSoonExploreBtn, [data-action="explore-roadmap"]')) {
            if (event) event.preventDefault();
            closeComingSoonModal();
            returnToStudio();
            const roadmapTab = document.querySelector('.launcher-tab[data-tool-filter="coming_soon"]');
            if (roadmapTab) {
                roadmapTab.click();
            }
            const featuresSec = document.getElementById('features') || document.querySelector('.hero-tools-launcher');
            if (featuresSec) {
                featuresSec.scrollIntoView({ behavior: 'smooth' });
            }
        } else if (target.id === 'comingSoonBackdrop' || target === comingSoonModal || target.classList?.contains('coming-soon-backdrop')) {
            closeComingSoonModal();
        }
    });

    // Keyboard ESC handler
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            if (comingSoonModal && (!comingSoonModal.hidden || comingSoonModal.classList.contains('is-open') || comingSoonModal.classList.contains('open') || comingSoonModal.style.display === 'flex')) {
                event.preventDefault();
                closeComingSoonModal();
            } else if (contentWorkspace?.classList.contains('open') || chatbotWindow?.classList.contains('open')) {
                event.preventDefault();
                returnToStudio();
            }
        }
    });

    // Browser History Navigation (popstate / hashchange)
    window.addEventListener('popstate', handleCurrentRoute);
    window.addEventListener('hashchange', handleCurrentRoute);

    // Initial Route Check on Page Load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', handleCurrentRoute, { once: true });
    } else {
        handleCurrentRoute();
    }
})();
