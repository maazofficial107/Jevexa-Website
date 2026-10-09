/* ===== JEVEXA Premium — Smooth Optimized Script ===== */







// ===============================



// Supabase Configuration



// ===============================



const SUPABASE_URL = 'https://byopcuspgnhwsrmsxqvm.supabase.co';



const SUPABASE_KEY = 'sb_publishable_AoElF80JEwzufwdNfrmjqQ_lDGq8kcF';







// Preloader + visible counter timing



let countersReady = false;



let counterObserver = null;







function finishLoading() {







    const pre = document.getElementById('preloader');



    if (pre) pre.classList.add('hidden');



    countersReady = true;



    setupCounterObserver();



}



// ===============================

// ===============================
// JEVEXA Professional Authentication System
// ===============================

const supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_KEY
);
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

function openLogin() {
    const modal = document.getElementById('loginModal');
    if (modal) {
        modal.classList.add('open');
        document.body.classList.add('login-open');
        document.documentElement.classList.add('login-open');
    }
}

function closeLogin() {
    const modal = document.getElementById('loginModal');
    if (modal) {
        modal.classList.remove('open');
        document.body.classList.remove('login-open');
        document.documentElement.classList.remove('login-open');
    }
}

function getFriendlyAuthError(error, action = 'login') {
    const message = String(error?.message || '').toLowerCase();
    const status = Number(error?.status || 0);

    if (status === 429 || message.includes('rate limit') || message.includes('too many')) {
        return 'Too many attempts. Please wait a moment and try again.';
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
    if (!button) return;

    button.disabled = loading;
    button.classList.toggle('loading', loading);

    if (loading) {
        button.innerHTML = `<span class="auth-spinner" aria-hidden="true"></span>${text}`;
    } else {
        button.innerHTML = isSignupMode
            ? 'Create Account <span>→</span>'
            : 'Login to JEVEXA <span>→</span>';
    }
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

    const { error } = await supabaseClient.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: 'https://jevexa.net' }
    });

    if (error) {
        console.error('Google login error:', error);
        showAuthMessage(getFriendlyAuthError(error, 'login'));
    }
}

async function loginWithGithub() {
    if (authBusy) return;
    clearAuthMessage();

    const { error } = await supabaseClient.auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: 'https://jevexa.net' }
    });

    if (error) {
        console.error('GitHub login error:', error);
        showAuthMessage('GitHub login is currently unavailable. Please try another login method.');
    }
}

async function loginWithEmail() {
    if (authBusy) return;

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

        currentUser = data?.user || null;
        closeLogin();
        clearAuthFields();
        showToast(`✓ Welcome back${getUserFirstName(currentUser) ? `, ${getUserFirstName(currentUser)}` : ''}!`);
        renderUserAccount(currentUser);
        updateCreditsHeader(currentUser);
    } finally {
        authBusy = false;
        setAuthButtonLoading(false);
    }
}

async function createAccountWithEmail() {
    if (authBusy) return;

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
                emailRedirectTo: 'https://jevexa.net'
            }
        });

        if (error) {
            console.error('Signup error:', error);
            showAuthMessage(getFriendlyAuthError(error, 'signup'));
            return;
        }

        console.log('Account created:', data);

        // When email confirmation is enabled, Supabase normally returns a user
        // with no active session until the email is verified.
        if (data?.session) {
            currentUser = data.user;
            closeLogin();
            clearAuthFields();
            showToast(`✓ Welcome to JEVEXA, ${name.split(' ')[0]}!`);
            renderUserAccount(currentUser);
        } else {
            showAuthMessage(
                '✓ Account created! Please check your email and click the verification link.',
                'success'
            );
        }
    } finally {
        authBusy = false;
        setAuthButtonLoading(false);
    }
}

function toggleAuthMode() {
    isSignupMode = !isSignupMode;
    clearAuthMessage();

    const nameWrapper = document.getElementById('signupNameWrapper');
    const submitButton = document.getElementById('authSubmitButton');
    const modeToggle = document.getElementById('authModeToggle');
    const footerText = document.getElementById('authFooterText');
    const welcomeText = document.querySelector('.login-welcome p');

    if (isSignupMode) {
        if (nameWrapper) nameWrapper.style.setProperty('display', 'block', 'important');
        if (submitButton) submitButton.innerHTML = 'Create Account <span>→</span>';
        if (footerText) footerText.textContent = 'Already have an account?';
        if (modeToggle) modeToggle.textContent = 'Login →';
        if (welcomeText) welcomeText.textContent = 'Create your JEVEXA account to get started.';
    } else {
        if (nameWrapper) nameWrapper.style.setProperty('display', 'none', 'important');
        if (submitButton) submitButton.innerHTML = 'Login to JEVEXA <span>→</span>';
        if (footerText) footerText.textContent = "Don't have an account?";
        if (modeToggle) modeToggle.textContent = 'Create Account →';
        if (welcomeText) welcomeText.textContent = 'Login to continue your AI automation journey.';
    }
}

        

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
    button.setAttribute('aria-label', 'Open account menu');
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
        <button type="button" data-account-action="profile" style="${accountMenuButtonStyle()}">👤 Profile</button>
        <button type="button" data-account-action="settings" style="${accountMenuButtonStyle()}">⚙ Settings</button>
        <div style="height:1px;background:rgba(255,255,255,.08);margin:8px 0;"></div>
        <button type="button" data-account-action="logout" style="${accountMenuButtonStyle(true)}">↪ Logout</button>
    `;

    account.append(button, menu);
    navActions.appendChild(account);

    button.addEventListener('click', (event) => {
        event.stopPropagation();
        menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
    });

    menu.addEventListener('click', async (event) => {
        const actionButton = event.target.closest('[data-account-action]');
        if (!actionButton) return;

        const action = actionButton.dataset.accountAction;
        menu.style.display = 'none';

        if (action === 'logout') await logoutUser();
        if (action === 'profile') openProfileView(user);
        if (action === 'settings') openSettingsView(user);
    });

    if (!window.__jevexaAccountOutsideClickBound) {
        document.addEventListener('click', event => {
            const liveAccount = document.getElementById('jevexaAccountUI');
            const liveMenu = document.getElementById('jevexaProfilePanel');
            if (liveMenu && liveAccount && !liveAccount.contains(event.target)) {
                liveMenu.style.display = 'none';
            }
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
        backdrop.addEventListener('click', event => {
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
                            Subscription
                        </div>

                        <strong style="font-size:15px;">
                            Trial access
                        </strong>
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
    if (profileCreditsValue) {
        supabaseClient.from('user_credits').select('balance, monthly_allowance')
            .eq('user_id', user.id).maybeSingle()
            .then(({ data, error }) => {
                if (!profileCreditsValue.isConnected) return;
                if (error || !data) profileCreditsValue.textContent = 'Unavailable';
                else profileCreditsValue.textContent = `${data.balance} / ${data.monthly_allowance}`;
            })
            .catch(error => { console.error('Profile credits error:', error); if (profileCreditsValue.isConnected) profileCreditsValue.textContent = 'Unavailable'; });
    }

    // Close profile
    backdrop.querySelector('#profileClose')?.addEventListener('click', () => {
        backdrop.style.display = 'none';
    });

    // Edit Profile
    backdrop.querySelector('#profileEditButton')?.addEventListener('click', () => {
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
      const used = content.querySelector('#settingsUsed');
      if (used) used.textContent = String(Math.max(0, Number(data.monthly_allowance || 0) - Number(data.balance || 0))); 
    }

    async function loadTransactions() {
      const list = content.querySelector('#settingsTransactions');
      if (!list) return;
      list.innerHTML = '<p class="settings-muted">Loading transactions…</p>';
      const { data, error } = await supabaseClient.from('credit_transactions')
        .select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(10);
      if (error) {
        console.error('Credit transaction load error:', error);
        list.innerHTML = '<p class="settings-muted">Transaction history is unavailable right now.</p>';
        return;
      }
      if (!data?.length) {
        list.innerHTML = '<p class="settings-muted">No credit transactions yet.</p>';
        return;
      }
      list.innerHTML = data.map(row => {
        const date = row.created_at ? new Date(row.created_at).toLocaleString() : '—';
        const amount = Number(row.amount ?? row.credits ?? 0);
        const label = escape(row.description || row.reason || row.type || 'Credit activity');
        return `<div class="settings-transaction"><span><strong>${label}</strong><small>${escape(date)}</small></span><b>${amount > 0 ? '+' : ''}${amount}</b></div>`;
      }).join('');
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
            <div class="settings-stats"><div><small>Remaining credits</small><strong id="settingsBalance">…</strong></div><div><small>Monthly allowance</small><strong id="settingsAllowance">…</strong></div><div><small>Used this allowance</small><strong id="settingsUsed">—</strong></div></div>
            <p id="settingsCreditStatus" class="settings-muted">Loading credit balance…</p>
            ${action('Refresh balance','refresh-credits',true)}`)}
          ${card('Recent transactions','Latest credit activity recorded for your account.',`<div id="settingsTransactions"><p class="settings-muted">Loading transactions…</p></div>${action('Refresh transactions','refresh-transactions',true)}`)}`;
        loadCredits();
        loadTransactions();
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

    panel.addEventListener('click', async event => {
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
    });

    if (error) {
        console.error(error);
        showToast('Could not send reset email. Check your Supabase email settings.');
        return;
    }

    showToast('Successfully sent! Password reset link email kar di hai. Apna inbox check karein.');
    return;
}

      if (actionName === 'refresh-credits') { await loadCredits(); return; }
      if (actionName === 'refresh-transactions') { await loadTransactions(); return; }
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
    document.addEventListener('keydown', function closeOnEscape(event) {
      if (event.key === 'Escape' && backdrop.style.display === 'flex') {
        backdrop.style.display = 'none';
        document.removeEventListener('keydown', closeOnEscape);
      }
    });
}

async function logoutUser() {
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
        console.error('Logout error:', error);
        showToast('Could not log out. Please try again.');
        return;
    }
    currentUser = null;
    removeUserAccountUI();
    await updateCreditsHeader(null);
    showToast('You have been logged out.');
}

async function initializeAuthSession() {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) console.error('Session check error:', error);
    currentUser = data?.session?.user || null;
    if (currentUser) renderUserAccount(currentUser);
    await updateCreditsHeader(currentUser);
}

supabaseClient.auth.onAuthStateChange((event, session) => {
    currentUser = session?.user || null;
    if (currentUser) renderUserAccount(currentUser);
    else removeUserAccountUI();
    void updateCreditsHeader(currentUser);
});

async function updateCreditsHeader(user) {
    const creditsBadge = document.getElementById('creditsBadge');
    const getStarted = document.querySelector('.btn.btn-nav');

    if (!creditsBadge) return;

    if (!user) {
        if (getStarted) {
            getStarted.style.display = '';
        }

        creditsBadge.style.display = 'none';
        return;
    }

    if (getStarted) {
        getStarted.style.display = 'none';
    }

    creditsBadge.style.display = 'inline-flex';

    const creditsCount = document.getElementById('creditsCount');

    if (!creditsCount) return;

    const { data, error } = await supabaseClient
        .from('user_credits')
        .select('balance')
        .eq('user_id', user.id)
        .maybeSingle();

    if (error) {
        console.error('Credits fetch error:', error);
        creditsCount.textContent = '—';
        updateCreditsSettingsUI(0, 100);
        return;
    }

    if (!data) {
        // Missing row is a backend provisioning issue, not proof the user has zero credits.
        creditsCount.textContent = 'Setup';
        updateCreditsSettingsUI(0, 100);
        console.warn('No user_credits row found. Run supabase/jevexa_saas_setup.sql.');
        return;
    }

    creditsCount.textContent = String(data.balance);
    updateCreditsSettingsUI(data.balance, data.monthly_allowance ?? 100);
}


// YAHAN PASTE KARO
function updateCreditsSettingsUI(balance, allowance = 100) {
    const total = document.getElementById('settingsTotalCredits');
    const used = document.getElementById('settingsUsedCredits');
    const remaining = document.getElementById('settingsRemainingCredits');
    if (total) total.textContent = String(allowance);
    if (remaining) remaining.textContent = String(balance);
    if (used) used.textContent = String(Math.max(0, Number(allowance) - Number(balance)));
}

initializeAuthSession();

// Don't make the preloader wait for fonts or other external resources.



if (document.readyState === 'loading') {



    document.addEventListener('DOMContentLoaded', finishLoading, { once: true });



} else {



    finishLoading();



}







// AOS — lighter settings for smoothness



if (window.AOS && typeof AOS.init === 'function') {



    AOS.init({



        duration: 700,



        once: true,



        offset: 50,



        easing: 'ease-out-cubic',



        disable: window.matchMedia('(prefers-reduced-motion: reduce)').matches



    });



} else {



    document.querySelectorAll('[data-aos]').forEach(el => el.removeAttribute('data-aos'));



}







// Navbar scroll



const navbar = document.getElementById('navbar');



const navLinks = document.querySelectorAll('.nav-link');







let ticking = false;







window.addEventListener('scroll', () => {



    if (!ticking) {



        requestAnimationFrame(() => {



            if (navbar) {



                if (window.scrollY > 50) navbar.classList.add('scrolled');



                else navbar.classList.remove('scrolled');



            }







            let current = '';







            document.querySelectorAll('section[id]').forEach(section => {



                if (window.scrollY >= section.offsetTop - 120) {



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







        ticking = true;



    }



}, { passive: true });







// Mobile Menu



const mobileToggle = document.getElementById('mobileToggle');



const navLinksEl = document.getElementById('navLinks');







mobileToggle?.addEventListener('click', () => {



    const isOpen = navLinksEl?.classList.toggle('open') ?? false;







    mobileToggle.classList.toggle('active', isOpen);



    mobileToggle.setAttribute('aria-expanded', String(isOpen));



});







navLinks.forEach(link => {



    link.addEventListener('click', () => {



        navLinksEl?.classList.remove('open');



        mobileToggle?.classList.remove('active');



        mobileToggle?.setAttribute('aria-expanded', 'false');



    });



});







// Counter Animation — smooth count-up when each counter becomes visible



function animateValue(el, target, duration = 1800, useComma = false) {



    if (!el || el.dataset.animated === '1') return;







    el.dataset.animated = '1';



    el.textContent = '0';







    const start = performance.now();







    const update = (now) => {



        const progress = Math.min((now - start) / duration, 1);







        const eased = 1 - Math.pow(1 - progress, 3);



        const value = Math.floor(target * eased);







        el.textContent = useComma ? value.toLocaleString() : value;







        if (progress < 1) {



            requestAnimationFrame(update);



        } else {



            el.textContent = useComma ? target.toLocaleString() : target;



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



        isTaskCounter



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







// Pricing Toggle — with number animation



const billingToggle = document.getElementById('billingToggle');







billingToggle?.addEventListener('change', () => {



    const yearly = billingToggle.checked;







    document.querySelectorAll('.amount').forEach(el => {



        const next = +(



            yearly



                ? el.getAttribute('data-yearly')



                : el.getAttribute('data-monthly')



        );







        const current = parseInt(el.textContent, 10) || 0;







        el.dataset.animated = '0';







        const start = performance.now();



        const duration = 450;







        const update = (now) => {



            const progress = Math.min((now - start) / duration, 1);



            const eased = 1 - Math.pow(1 - progress, 3);







            el.textContent = Math.round(



                current + (next - current) * eased



            );







            if (progress < 1) {



                requestAnimationFrame(update);



            } else {



                el.textContent = next;



            }



        };







        requestAnimationFrame(update);



    });



});







// FAQ Accordion



document.querySelectorAll('.faq-question').forEach(btn => {



    btn.addEventListener('click', () => {



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

document.getElementById('contactForm')?.addEventListener('submit', async (e) => {

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



document.querySelectorAll('.coming-soon-link').forEach(link => {



    link.addEventListener('click', (e) => {



        e.preventDefault();







        const page = link.dataset.page || 'This page';







        showToast(`${page} page is not connected yet.`);



    });



});







function showToast(message) {



    const toast = document.getElementById('toast');







    if (!toast) return;







    toast.textContent = message;



    toast.classList.add('show');







    setTimeout(() => {



        toast.classList.remove('show');



    }, 3500);



}







/* ===== Premium AI Chatbot ===== */







const chatbotToggle = document.getElementById('chatbotToggle');



const chatbotWindow = document.getElementById('chatbotWindow');



const chatbotClose = document.getElementById('chatbotClose');



const chatMessages = document.getElementById('chatMessages');



const chatInput = document.getElementById('chatInput');



const chatSend = document.getElementById('chatSend');



const chatSuggestions = document.getElementById('chatSuggestions');







chatbotToggle?.addEventListener('click', () => {



    chatbotWindow?.classList.toggle('open');







    const badge = chatbotToggle.querySelector(



        '.ct-badge, .toggle-badge'



    );







    if (badge) badge.style.display = 'none';



});







chatbotClose?.addEventListener('click', () => {



    chatbotWindow?.classList.remove('open');



});







const knowledge = {



    plans: {



        keywords: [



            'plan',



            'pricing',



            'price',



            'cost',



            'basic',



            'premium',



            'max',



            'package',



            'subscription',



            'how much',



            'fee'



        ],







        response: `We offer three powerful plans:<br><br>



🔹 <strong>Basic</strong> — $19/mo<br>



• 1 AI Chatbot • 5 Workflows • 2,000 credits<br><br>



🔥 <strong>Premium</strong> — $49/mo <em>(was $59 — Save 17%)</em><br>



• 5 Chatbots • 25 Workflows • 15,000 credits • Custom Agents • Priority Support<br><br>



🚀 <strong>Max</strong> — $99/mo <em>(was $129 — Save 23%)</em><br>



• Unlimited everything • White-label • SSO • Dedicated Manager<br><br>



All plans include a <strong>14-day free trial</strong>. Which one interests you?`



    },







    trial: {



        keywords: [



            'trial',



            'free',



            'demo',



            'test',



            'try',



            'start free'



        ],







        response: `Yes! Every plan comes with a <strong>14-day free trial</strong>. No credit card required to start. You get full access to all features of the plan you choose.<br><br>Ready? Click <strong>Start Free Trial</strong> on any plan!`



    },







    features: {



        keywords: [



            'feature',



            'what can',



            'capability',



            'do you offer',



            'automation',



            'workflow',



            'chatbot',



            'what do you',



            'rpa',



            'voice',



            'document'



        ],







        response: `JEVEXA is a complete AI Automation Studio:<br><br>



✨ AI Chatbots & Intelligent Agents<br>



✨ Visual Workflow Builder (300+ integrations)<br>



✨ RPA & Process Automation<br>



✨ Document AI & OCR<br>



✨ Voice AI & Call Agents<br>



✨ Lead Scoring & CRM AI<br>



✨ Content Generation<br>



✨ Email & Outreach Automation<br>



✨ Social Media Automation<br>



✨ Intelligent Analytics<br>



✨ Data Enrichment<br>



✨ Enterprise Security<br><br>



What would you like to automate?`



    },







    email: {



        keywords: [



            'email',



            'outreach',



            'sequence',



            'campaign',



            'cold'



        ],







        response: `Our Email & Outreach AI can:<br>



• Personalize every email at scale<br>



• Smart sequences that adapt to replies<br>



• Auto-reply in your tone<br>



• A/B testing + CRM sync<br><br>



Teams cut outreach time by <strong>80%</strong>. Want details on Premium or Max?`



    },







    security: {



        keywords: [



            'secure',



            'security',



            'data',



            'privacy',



            'gdpr',



            'safe',



            'encrypt',



            'compliance'



        ],







        response: `Security is core to JEVEXA:<br>



• End-to-end encryption<br>



• Never train public models on your data<br>



• GDPR & CCPA compliant<br>



• Private cloud / on-premise on Max<br>



• SSO, SAML, audit logs<br><br>



Your data stays yours. Always. 🔒`



    },







    support: {



        keywords: [



            'support',



            'help',



            'contact',



            'human',



            'team',



            'manager'



        ],







        response: `Support levels:<br>



• <strong>Basic</strong>: Email support<br>



• <strong>Premium</strong>: Priority email + live chat<br>



• <strong>Max</strong>: 24/7 + dedicated Slack + Success Manager<br><br>



Reach us at <strong>hello@jevexa.ai</strong> or keep chatting!`



    },







    how: {



        keywords: [



            'how work',



            'how does',



            'process',



            'get started',



            'start',



            'begin',



            'onboard'



        ],







        response: `Getting started is simple:<br><br>



1️⃣ Choose a plan (or free trial)<br>



2️⃣ Map processes with our team (or DIY)<br>



3️⃣ Build workflows / train agents<br>



4️⃣ Deploy & scale<br><br>



Most launch first automation in <strong>1–3 days</strong>.`



    },







    integration: {



        keywords: [



            'integrat',



            'connect',



            'zapier',



            'slack',



            'hubspot',



            'salesforce',



            'api'



        ],







        response: `We support <strong>300+ integrations</strong>: Slack, HubSpot, Salesforce, Gmail, Notion, Zapier, Make, Shopify, Stripe, and more. Custom webhooks & API on Premium/Max.`



    },







    white: {



        keywords: [



            'white-label',



            'whitelabel',



            'rebrand',



            'agency',



            'client'



        ],







        response: `Full white-label is on the <strong>Max plan</strong>. Brand chatbots, dashboards & portals under your name — perfect for agencies.`



    },







    rpa: {



        keywords: [



            'rpa',



            'robotic',



            'desktop',



            'legacy',



            'erp'



        ],







        response: `Yes — we offer full <strong>RPA & Process Automation</strong>:<br>



• Desktop & web bots<br>



• Screen scraping<br>



• Unattended automation<br>



• Works with legacy systems & ERPs<br><br>



Great for repetitive form filling and back-office tasks.`



    },







    voice: {



        keywords: [



            'voice',



            'call',



            'phone',



            'speech',



            'appointment'



        ],







        response: `Our <strong>Voice AI & Call Agents</strong> can answer calls, book appointments, qualify leads, and handle support in natural speech — with full call analytics.`



    },







    greeting: {



        keywords: [



            'hello',



            'hi',



            'hey',



            'good morning',



            'good afternoon',



            'namaste',



            'salam'



        ],







        response: `Hey! 👋 Welcome to JEVEXA. I can help with pricing, features, RPA, voice AI, security, free trial, or anything about automating your business. What do you need?`



    },







    thanks: {



        keywords: [



            'thank',



            'thanks',



            'appreciate',



            'great',



            'awesome',



            'cool'



        ],







        response: `You're welcome! 😊 Anything else? Plans, features, security — just ask.`



    },







    default: {



        response: `I can help with:<br>



• Plans & pricing<br>



• All features (RPA, Voice, Document AI, etc.)<br>



• Free trial<br>



• Security & compliance<br>



• Integrations<br>



• Getting started<br><br>



What would you like to know?`



    }



};







async function getBotResponse(input) {



    try {



        const response = await fetch('/api/chat', {



            method: 'POST',



            headers: {



                'Content-Type': 'application/json'



            },



            body: JSON.stringify({



                message: input



            })



        });







        if (!response.ok) {



            throw new Error('Chatbot API failed');



        }







        const data = await response.json();







        return data.reply || 'Sorry, I could not generate a response.';



    } catch (error) {



        console.error('Chatbot error:', error);



        return 'Sorry, chatbot is temporarily unavailable. Please try again.';



    }



}











function addMessage(content, isUser = false) {



    if (!chatMessages) return;







    const msg = document.createElement('div');







    msg.className = `message ${isUser ? 'user' : 'bot'}`;







    msg.innerHTML = `



        <div class="msg-avatar">



            <i class="fas fa-${isUser ? 'user' : 'wand-magic-sparkles'}"></i>



        </div>



        <div class="msg-content">



            <p>${content}</p>



        </div>



    `;







    chatMessages.appendChild(msg);



    chatMessages.scrollTop = chatMessages.scrollHeight;



}







function showTyping() {



    if (!chatMessages) return;







    const typing = document.createElement('div');







    typing.className = 'message bot';



    typing.id = 'typingMsg';







    typing.innerHTML = `



        <div class="msg-avatar">



            <i class="fas fa-wand-magic-sparkles"></i>



        </div>



        <div class="typing-indicator">



            <span></span>



            <span></span>



            <span></span>



        </div>



    `;







    chatMessages.appendChild(typing);



    chatMessages.scrollTop = chatMessages.scrollHeight;



}







function hideTyping() {



    document.getElementById('typingMsg')?.remove();



}







async function handleSend() {



    const text = chatInput?.value.trim();



    if (!text) return;







    addMessage(text, true);



    chatInput.value = '';



    showTyping();







    try {



        const reply = await getBotResponse(text);



        hideTyping();



        addMessage(reply);



    } catch (error) {



        hideTyping();



        addMessage('Sorry, chatbot is temporarily unavailable. Please try again.');



    }



}







chatSend?.addEventListener('click', handleSend);







chatInput?.addEventListener('keypress', (e) => {



    if (e.key === 'Enter') {



        handleSend();



    }



});







chatSuggestions?.addEventListener('click', (e) => {



    if (e.target.classList.contains('suggestion')) {



        if (chatInput) {



            chatInput.value = e.target.textContent;



        }







        handleSend();



    }



});







// ===== Lightweight Particles (optimized) =====



const canvas = document.getElementById('particles-canvas');







if (



    canvas &&



    !window.matchMedia('(prefers-reduced-motion: reduce)').matches



) {



    const ctx = canvas.getContext('2d');







    let particles = [];



    let w, h;







    const COUNT = 35;







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







    function animate(t) {



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







        requestAnimationFrame(animate);



    }







    requestAnimationFrame(animate);



}

// ===============================
// JEVEXA Protected CTA System
// ===============================
document.addEventListener('click', async function (event) {

    const button = event.target.closest('a, button');

    if (!button) return;

    const text = button.textContent.trim().toLowerCase();

    const protectedCTA =
        text.includes('get started') ||
        text.includes('start free trial') ||
        text.includes('contact sales') ||
        text.includes('custom sales');

    // Not a protected CTA
    if (!protectedCTA) return;

    // Check the REAL Supabase login session
    const { data } = await supabaseClient.auth.getSession();

    const loggedInUser = data?.session?.user || null;

    // ===============================
    // USER IS ALREADY LOGGED IN
    // ===============================
    if (loggedInUser) {

        currentUser = loggedInUser;

        // Do NOT show login page.
        // Allow the original button action to continue.
        return;
    }

    // ===============================
    // USER IS NOT LOGGED IN
    // ===============================
    event.preventDefault();
    event.stopPropagation();

    openLogin();

});
// ===== JEVEXA PRICING PLANS =====
const JEVEXA_PLANS = {
    starter: {
        name: 'Starter',
        monthly: 19,
        yearly: 15,
        credits: 2000
    },
    pro: {
        name: 'Pro',
        monthly: 49,
        yearly: 39,
        credits: 10000
    },
    business: {
        name: 'Business',
        monthly: 99,
        yearly: 79,
        credits: 30000
    }
};
// ============================================================
// JEVEXA CONSOLIDATED SETTINGS + PRICING CONTROLLER
// Core account controls are real; billing checkout and AI providers
// must be configured server-side before subscription/AI execution.
// ============================================================
(function () {
    const toast = message => {
        if (typeof showToast === 'function') showToast(message);
        else console.info('[JEVEXA]', message);
    };
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

    document.addEventListener('click', async event => {
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
            const plan = JEVEXA_PLANS?.[planButton.dataset.plan];
            const cycle = document.getElementById('billingToggle')?.checked ? 'yearly' : 'monthly';
            if (!plan) { toast('This plan is not available.'); return; }
            if (!currentUser) { openLogin(); return; }
            // Do not claim a purchase or grant credits until a verified provider checkout/webhook exists.
            toast('Secure checkout is not configured yet. No payment was taken and your plan has not changed.');
            console.warn('Billing requires a payment provider account, server-side checkout, and signed webhook.');
            return;
        }
    }, true);

    document.addEventListener('change', event => {
        const toggle = event.target;
        if (toggle.id === 'settingsReduceMotion') {
            document.documentElement.classList.toggle('jevexa-reduce-motion', toggle.checked);
        }
        if (toggle.id === 'settingsCompact') {
            document.documentElement.classList.toggle('jevexa-compact', toggle.checked);
        }
    });

    // Apply persisted interface preferences when a user session is available.
    function applyUserPreferences(user) {
        if (!user) {
            document.documentElement.classList.remove('jevexa-reduce-motion', 'jevexa-compact');
            return;
        }
        const prefix = `jevexa_${user.id}_`;
        const theme = localStorage.getItem(prefix + 'theme');
        if (theme) applyJevexaTheme(safeTheme(theme));
        document.documentElement.classList.toggle('jevexa-reduce-motion', localStorage.getItem(prefix + 'reduce_motion') === 'true');
        document.documentElement.classList.toggle('jevexa-compact', localStorage.getItem(prefix + 'compact') === 'true');
    }

    const priorRender = window.renderUserAccount;
    if (typeof priorRender === 'function') {
        // Existing global function is retained; the auth state handler below reapplies preferences.
        window.renderUserAccount = priorRender;
    }
    supabaseClient.auth.onAuthStateChange((_event, session) => applyUserPreferences(session?.user || null));
    setTimeout(() => applyUserPreferences(currentUser), 0);

    window.JEVEXA_SETTINGS = {
        open: () => currentUser ? openSettingsView(currentUser) : openLogin(),
        refreshCredits: async () => {
            if (!currentUser) return null;
            const { data, error } = await supabaseClient.from('user_credits')
                .select('balance, monthly_allowance').eq('user_id', currentUser.id).maybeSingle();
            if (error) { console.error(error); toast('Could not refresh credits.'); return null; }
            if (data) {
                const count = document.getElementById('creditsCount');
                if (count) count.textContent = String(data.balance);
                updateCreditsSettingsUI(data.balance, data.monthly_allowance ?? 100);
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
