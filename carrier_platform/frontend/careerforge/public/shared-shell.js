import { Clerk } from 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.mjs';

const DEFAULT_BACKEND_URL = 'http://localhost:5000';

window.__SERVER_URL = window.__SERVER_URL || DEFAULT_BACKEND_URL;
window.__CLERK_PUBLISHABLE_KEY = window.__CLERK_PUBLISHABLE_KEY || '';

let runtimeConfigPromise = null;

async function loadRuntimeConfig() {
  if (runtimeConfigPromise) return runtimeConfigPromise;

  runtimeConfigPromise = (async () => {
    try {
      const resp = await fetch('/api/runtime-config', { cache: 'no-store' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.success) {
        console.error(`[Config] Runtime config request failed: ${resp.status} ${resp.statusText}`);
        return;
      }

      if (data.backendUrl) {
        window.__SERVER_URL = data.backendUrl;
      }
      if (data.clerkPublishableKey) {
        window.__CLERK_PUBLISHABLE_KEY = data.clerkPublishableKey;
      }
    } catch (err) {
      console.error('[Config] Runtime config fetch failed:', err?.message || err);
    }
  })();

  return runtimeConfigPromise;
}

window.__loadRuntimeConfig = loadRuntimeConfig;
window.__resolveServerUrl = async () => {
  await loadRuntimeConfig();
  return window.__SERVER_URL || DEFAULT_BACKEND_URL;
};
window.__getBackendUrlSync = () => window.__SERVER_URL || DEFAULT_BACKEND_URL;

const links = [
  { href: '/resume-builder/', label: 'Resume Builder', key: 'resume-builder' },
  { href: '/resume-analyzer/', label: 'Resume Analyzer', key: 'resume-analyzer' },
  { href: '/cover-letter/', label: 'Cover Letter', key: 'cover-letter' },
  { href: '/interviewer/', label: 'Interviewer', key: 'interviewer' },
  { href: '/job-listings/', label: 'Job Listings', key: 'job-listings' },
  { href: '/leaderboard/', label: 'Leaderboard', key: 'leaderboard' },
];

const PLAN_FEATURES = {
  free: [
    '₹0 / month',
    '5 Resume Analyses (per 15 days)',
    '5 Job-Fit Resumes (per 15 days)',
    '1 Interview Prep (per 15 days)',
    '3 Cover Letters (per 15 days)',
    'View up to 10 Jobs at a time',
  ],
  pro: [
    '50 Resume Analyses / month',
    '30 Job-Fit Resumes / month',
    '20 Interview Preps / month',
    '30 Cover Letters / month',
    'View 100 Jobs at a time',
  ],
  max: [
    '₹299 / month',
    '100 Resume Analyses / month',
    '100 Job-Fit Resumes / month',
    '35 Interview Preps / month',
    '60 Cover Letters / month',
    'View ALL Jobs (no limit)',
  ],
};

let clerk = null;
let pendingFeaturePath = null;
let usernamePromptInFlight = false;

// Global auth helpers for feature pages
window.__getAuthToken = async () => {
  for (let i = 0; i < 50; i++) {
    if (clerk && clerk.isSignedIn) {
      try {
        const token = await clerk.session.getToken();
        if (token) return token;
      } catch (e) {
        console.warn("[Auth] getToken attempt", i, e.message);
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.warn("[Auth] Timed out waiting for session token");
  return null;
};
window.__getAuthHeaders = async () => {
  for (let i = 0; i < 50; i++) {
    if (clerk && clerk.isSignedIn) {
      try {
        const token = await clerk.session.getToken();
        if (token) return { Authorization: `Bearer ${token}` };
      } catch (e) {
        console.warn("[Auth] getToken attempt", i, e.message);
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.warn("[Auth] Timed out waiting for session token");
  return {};
};
window.__getClerkUser = () => {
  if (!clerk || !clerk.isSignedIn || !clerk.user) return null;
  const primaryEmail = clerk.user.primaryEmailAddress?.emailAddress || "";
  return {
    id: clerk.user.id,
    email: primaryEmail,
    username: clerk.user.username || "",
    firstName: clerk.user.firstName || "",
    lastName: clerk.user.lastName || "",
    fullName: clerk.user.fullName || "",
    imageUrl: clerk.user.imageUrl || "",
  };
};

async function promptForUsernameIfNeeded() {
  if (!clerk || !clerk.isSignedIn || !clerk.user) return;
  if (sessionStorage.getItem('cf_username_collected') === '1') return;
  if ((clerk.user.username || '').trim()) return;
  if (usernamePromptInFlight) return;

  usernamePromptInFlight = true;
  try {
    const suggested = (
      clerk.user.firstName ||
      clerk.user.username ||
      clerk.user.primaryEmailAddress?.emailAddress?.split('@')[0] ||
      'user'
    )
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'user';

    let username = window.prompt('Choose a username to finish setting up your account:', suggested);
    if (!username) return;

    username = username.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    if (!username) {
      alert('Please enter a valid username using letters, numbers, dots, underscores, or hyphens.');
      return;
    }

    const headers = await window.__getAuthHeaders();
    if (!headers.Authorization) throw new Error('No auth token available yet');

    const user = window.__getClerkUser?.() || {};
    const resp = await fetch(`${window.__getBackendUrlSync()}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        email: user.email || clerk.user.primaryEmailAddress?.emailAddress || '',
        username,
        firstName: user.firstName || clerk.user.firstName || '',
        lastName: user.lastName || clerk.user.lastName || '',
      }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.success) {
      throw new Error(data?.error || `Server error ${resp.status}`);
    }

    try {
      await clerk.user.update?.({ username });
    } catch (err) {
      console.warn('[Auth] Clerk username update skipped:', err?.message || err);
    }

    sessionStorage.setItem('cf_username_collected', '1');
    console.log('[Auth] Username collected:', username);
  } catch (err) {
    console.error('[Auth] Username onboarding failed:', err?.message || err);
  } finally {
    usernamePromptInFlight = false;
  }
}
window.__getSavedResumes = async () => {
  const headers = await window.__getAuthHeaders();
  if (!headers.Authorization) return [];
  try {
    const resp = await fetch(`${window.__getBackendUrlSync()}/api/profile/resumes`, { headers });
    const data = await resp.json();
    return data.success ? (data.resumes || []) : [];
  } catch { return []; }
};
window.__loadSavedResumePdf = async (resumeId) => {
  const headers = await window.__getAuthHeaders();
  if (!headers.Authorization) throw new Error('Please sign in to access saved resumes');

  const resp = await fetch(`${window.__getBackendUrlSync()}/api/profile/resumes/${resumeId}/pdf?dl=0`, { headers });
  if (!resp.ok) throw new Error('Could not load saved resume');
  return await resp.blob();
};
window.__readPdfText = async (source, options = {}) => {
  const pdfLib = window.pdfjsLib || window.__pdfjsLib;
  if (!pdfLib) throw new Error('PDF.js not loaded');

  const includeLinks = Boolean(options.includeLinks);
  const arrayBuffer = source instanceof ArrayBuffer
    ? source
    : source instanceof Blob
      ? await source.arrayBuffer()
      : source?.buffer instanceof ArrayBuffer
        ? source.buffer
        : await source.arrayBuffer();

  const pdf = await pdfLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(' ') + '\n';

    if (includeLinks) {
      const annots = await page.getAnnotations();
      const urls = annots
        .filter((annot) => annot.subtype === 'Link')
        .map((annot) => annot.url || annot.action?.url)
        .filter(Boolean);
      if (urls.length) text += `Links: ${urls.join(', ')}\n`;
    }
  }

  return text.trim();
};

window.__loadPlanUsage = async () => {
  const headers = await window.__getAuthHeaders();
  if (!headers.Authorization) return null;

  try {
    const resp = await fetch(`${window.__getBackendUrlSync()}/api/plans/usage`, { headers });
    const data = await resp.json().catch(() => ({}));
    return data.success ? data : null;
  } catch {
    return null;
  }
};

const featurePathPrefixes = ['/resume-builder', '/resume-analyzer', '/cover-letter', '/interviewer', '/job-listings', '/profile'];

function isFeaturePath(pathname) {
  return featurePathPrefixes.some((prefix) => pathname.startsWith(prefix));
}

function detectPageKey() {
  const first = window.location.pathname.split('/').filter(Boolean)[0] || 'index.html';
  if (first === 'resume-builder' || first === 'resume-analyzer' || first === 'cover-letter' || first === 'interviewer' || first === 'profile' || first === 'leaderboard' || first === 'job-listings') {
    return first;
  }
  return 'home';
}

function shellMarkup(activeKey) {
  const navLinks = links
    .map((link) => {
      const active = link.key === activeKey ? 'active' : '';
      return `<a class="cf-shell-link ${active}" href="${link.href}">${link.label}</a>`;
    })
    .join('');

  return `
    <header class="cf-shell-nav">
      <nav class="cf-shell-inner">
        <a class="cf-shell-brand" href="/" style="position:relative;display:flex;align-items:center;">
          <span style="font-weight:700;font-size:20px;letter-spacing:0.2px;">CareerForge</span>
          <div style="width:112px;"></div>
        </a>
        <div class="cf-shell-links" id="cf-shell-links">${navLinks}</div>
        <div class="cf-shell-actions" id="cf-shell-actions">
          <button class="cf-shell-btn-outline" id="cf-login-btn">Sign In</button>
          <button class="cf-shell-btn-solid" id="cf-register-btn">Get Started</button>
          <a class="cf-shell-btn-outline" id="cf-profile-link" href="/profile/" style="display:none;">Profile</a>
          <div id="cf-user-button" style="display:none;"></div>
        </div>
        <button class="cf-shell-mobile-toggle" id="cf-shell-mobile-toggle" aria-label="Toggle menu" type="button">
          <span class="cf-hamburger-line"></span>
          <span class="cf-hamburger-line"></span>
          <span class="cf-hamburger-line"></span>
        </button>
      </nav>
    </header>
    <div class="cf-shell-mobile-menu" id="cf-shell-mobile-menu">
      <div class="cf-shell-mobile-links">${navLinks}</div>
      <div class="cf-shell-mobile-actions">
        <button class="cf-shell-btn-solid" id="cf-mobile-login-btn">Sign In</button>
        <button class="cf-shell-btn-outline" id="cf-mobile-register-btn">Get Started</button>
        <a class="cf-shell-btn-outline" id="cf-mobile-profile-link" href="/profile/" style="display:none;">Profile</a>
      </div>
    </div>
    <div class="cf-feature-gate" id="cf-feature-gate" aria-hidden="true">
      <div class="cf-feature-gate-card">
        <h3>Login Required</h3>
        <p>Please sign in or create an account to use this feature.</p>
        <div class="cf-feature-gate-actions">
          <button class="cf-shell-btn-outline" id="cf-gate-login">Sign In</button>
          <button class="cf-shell-btn-solid" id="cf-gate-register">Get Started</button>
          <a class="cf-shell-link" href="/">Back to Home</a>
        </div>
      </div>
    </div>
    <div class="cf-plan-modal" id="cf-plan-modal" aria-hidden="true">
      <div class="cf-plan-modal-card" role="dialog" aria-modal="true" aria-labelledby="cf-plan-modal-title">
        <div class="cf-plan-modal-header">
          <div>
            <div class="cf-plan-modal-kicker">Plan Selection</div>
            <h3 id="cf-plan-modal-title">Choose your plan</h3>
          </div>
          <button class="cf-plan-modal-close" id="cf-plan-modal-close" type="button">&times;</button>
        </div>
        <p class="cf-plan-modal-copy" id="cf-plan-modal-copy">Review your current usage and pick a plan to continue.</p>
        <div class="cf-plan-modal-grid">
          <section class="cf-plan-tier cf-plan-tier-current">
            <div class="cf-plan-tier-name">Current Plan</div>
            <div class="cf-plan-tier-price" id="cf-plan-current-name">Free</div>
            <div class="cf-plan-tier-copy" id="cf-plan-current-copy">No usage data loaded yet.</div>
            <div class="cf-plan-current-usage" id="cf-plan-current-usage"></div>
            <ul class="cf-plan-usage-list" id="cf-plan-usage-list"></ul>
            <ul class="cf-plan-features" id="cf-plan-free-features"></ul>
            <div class="cf-plan-actions">
              <button class="cf-shell-btn-outline" id="cf-plan-free-btn" type="button">Select Free Plan</button>
              <a class="cf-shell-link" href="/profile/">Open Dashboard</a>
            </div>
          </section>
          <section class="cf-plan-tier" id="cf-plan-tier-pro">
            <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
              <div class="cf-plan-tier-name">Pro</div>
              <div class="cf-plan-tier-badge">Most Popular</div>
            </div>
            <div class="cf-plan-tier-price" id="cf-plan-pro-price">Loading...</div>
            <div class="cf-plan-tier-copy" id="cf-plan-pro-copy">Plan details loading.</div>
            <ul class="cf-plan-features" id="cf-plan-pro-features"></ul>
            <div class="cf-plan-actions">
              <button class="cf-shell-btn-outline" id="cf-plan-pro-btn" type="button">Upgrade to Pro</button>
            </div>
          </section>
          <section class="cf-plan-tier" id="cf-plan-tier-max">
            <div class="cf-plan-tier-name">Max</div>
            <div class="cf-plan-tier-price" id="cf-plan-max-price">Loading...</div>
            <div class="cf-plan-tier-copy" id="cf-plan-max-copy">Plan details loading.</div>
            <ul class="cf-plan-features" id="cf-plan-max-features"></ul>
            <div class="cf-plan-actions">
              <button class="cf-shell-btn-outline" id="cf-plan-max-btn" type="button">Upgrade to Max</button>
            </div>
          </section>
        </div>
        <p class="cf-plan-payment-status" id="cf-plan-payment-status"></p>
      </div>
    </div>
  `;
}

function footerMarkup() {
  return `
    <footer class="cf-shell-footer">
      <div class="cf-shell-footer-inner">
        <div class="cf-shell-footer-brand-block">
            <a class="cf-shell-footer-brand" href="/">
              <span style="display:flex;align-items:center;gap:8px;"><span style="font-weight:700;">CareerForge</span></span>
            </a>
            <p class="cf-shell-footer-copy">AI-powered career development ecosystem. Build, analyze, and optimize your career journey.</p>
        </div>
        <div class="cf-shell-footer-grid">
          <div class="cf-shell-footer-column">
            <h3>Platform</h3>
            <a href="/">Home</a>
            <a href="/resume-builder/">Resume Builder</a>
            <a href="/resume-analyzer/">Resume Analyzer</a>
            <a href="/cover-letter/">Cover Letter</a>
          </div>
          <div class="cf-shell-footer-column">
            <h3>Tools</h3>
            <a href="/interviewer/">Interviewer</a>
            <a href="/job-listings/">Job Listings</a>
            <a href="/leaderboard/">Leaderboard</a>
            <a href="/profile/">Profile</a>
          </div>
          <div class="cf-shell-footer-column">
            <h3>Support</h3>
            <a href="#">Features</a>
            <a href="#">Pricing</a>
            <a href="#">About</a>
            <a href="#">FAQ</a>
          </div>
        </div>
      </div>
      <div class="cf-shell-footer-bottom">
        <p>&copy; ${new Date().getFullYear()} CareerForge. All rights reserved.</p>
        <p>Built for the next generation of careers.</p>
      </div>
    </footer>
  `;
}

function openPlanSelectionModal() {
  const modal = document.getElementById('cf-plan-modal');
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closePlanSelectionModal() {
  const modal = document.getElementById('cf-plan-modal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function formatPlanUsageLabel(featureKey) {
  const labels = {
    resumeAnalysis: 'Resume Analysis',
    jobFitResume: 'Job Fit Resume',
    interviewPrep: 'Interview Prep',
    coverLetter: 'Cover Letter',
  };
  return labels[featureKey] || featureKey || 'Usage';
}

function formatPlanLabel(plan) {
  return (plan || 'free').charAt(0).toUpperCase() + (plan || 'free').slice(1);
}

let paymentCatalogCache = null;

async function loadPaymentCatalog() {
  if (paymentCatalogCache) return paymentCatalogCache;

  const resp = await fetch(`${window.__getBackendUrlSync()}/api/payment/catalog`);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.success) {
    throw new Error(data.error || `Server error ${resp.status}`);
  }

  paymentCatalogCache = data;
  return data;
}

async function ensureRazorpayCheckoutLoaded() {
  if (window.Razorpay) return;

  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-razorpay="checkout"]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load Razorpay checkout')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.dataset.razorpay = 'checkout';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load Razorpay checkout'));
    document.head.appendChild(script);
  });
}

async function createPlanOrder(planKey) {
  const headers = await window.__getAuthHeaders();
  if (!headers.Authorization) throw new Error('Please sign in first');

  const resp = await fetch(`${window.__getBackendUrlSync()}/api/payment/create-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ plan: planKey }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.success) {
    throw new Error(data.error || `Server error ${resp.status}`);
  }

  return data;
}

async function verifyAndApplyPlan(planKey, payload) {
  const headers = await window.__getAuthHeaders();
  if (!headers.Authorization) throw new Error('Please sign in first');

  const resp = await fetch(`${window.__getBackendUrlSync()}/api/payment/verify-and-apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      plan: planKey,
      razorpay_order_id: payload.razorpay_order_id,
      razorpay_payment_id: payload.razorpay_payment_id,
      razorpay_signature: payload.razorpay_signature,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.success || !data.verified) {
    throw new Error(data.error || `Verification failed (${resp.status})`);
  }

  return data;
}

async function runPlanCheckout(planKey, uiPlan, statusEl) {
  const orderData = await createPlanOrder(planKey);
  await ensureRazorpayCheckoutLoaded();

  const planLabel = uiPlan?.label || formatPlanLabel(planKey);
  const order = orderData.order || {};
  const keyId = orderData.keyId;

  if (!window.Razorpay) throw new Error('Razorpay SDK unavailable');

  const user = window.__getClerkUser ? window.__getClerkUser() : null;

  await new Promise((resolve, reject) => {
    const checkout = new window.Razorpay({
      key: keyId,
      amount: order.amount,
      currency: order.currency || uiPlan?.currency || 'INR',
      name: 'Career Forge',
      description: uiPlan?.description || `Upgrade to ${planLabel}`,
      order_id: order.id,
      prefill: {
        name: user?.fullName || user?.firstName || '',
        email: user?.email || '',
      },
      notes: {
        plan: planKey,
      },
      theme: {
        color: '#57d6ff',
      },
      modal: {
        ondismiss: () => reject(new Error('Payment cancelled')),
      },
      handler: async (payload) => {
        try {
          await verifyAndApplyPlan(planKey, payload);
          resolve();
        } catch (err) {
          reject(err);
        }
      },
    });

    checkout.open();
  });

  if (statusEl) {
    statusEl.textContent = `${planLabel} activated successfully.`;
  }

  paymentCatalogCache = null;
  if (window.__refreshPlanDashboard) {
    await window.__refreshPlanDashboard();
  }
}

async function configurePaidPlanButtons({ currentPlan, catalog, statusEl }) {
  const proPlan = catalog?.plans?.pro;
  const maxPlan = catalog?.plans?.max;

  const proPrice = document.getElementById('cf-plan-pro-price');
  const proCopy = document.getElementById('cf-plan-pro-copy');
  const proBtn = document.getElementById('cf-plan-pro-btn');

  const maxPrice = document.getElementById('cf-plan-max-price');
  const maxCopy = document.getElementById('cf-plan-max-copy');
  const maxBtn = document.getElementById('cf-plan-max-btn');

  if (proPrice) proPrice.textContent = proPlan?.displayPrice || 'Unavailable';
  if (proCopy) proCopy.textContent = proPlan?.description || 'Plan details unavailable.';

  if (maxPrice) maxPrice.textContent = maxPlan?.displayPrice || 'Unavailable';
  if (maxCopy) maxCopy.textContent = maxPlan?.description || 'Plan details unavailable.';

  if (proBtn) {
    proBtn.disabled = !proPlan || currentPlan === 'pro' || currentPlan === 'max';
    proBtn.textContent = currentPlan === 'pro' ? 'Current Plan' : (currentPlan === 'max' ? 'Already on Max' : 'Upgrade to Pro');
    proBtn.onclick = async () => {
      try {
        proBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Opening Razorpay for Pro...';
        await runPlanCheckout('pro', proPlan, statusEl);
        closePlanSelectionModal();
      } catch (err) {
        if (statusEl) statusEl.textContent = err.message;
      } finally {
        if (currentPlan !== 'pro' && currentPlan !== 'max') proBtn.disabled = false;
      }
    };
  }

  if (maxBtn) {
    maxBtn.disabled = !maxPlan || currentPlan === 'max';
    maxBtn.textContent = currentPlan === 'max' ? 'Current Plan' : 'Upgrade to Max';
    maxBtn.onclick = async () => {
      try {
        maxBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Opening Razorpay for Max...';
        await runPlanCheckout('max', maxPlan, statusEl);
        closePlanSelectionModal();
      } catch (err) {
        if (statusEl) statusEl.textContent = err.message;
      } finally {
        if (currentPlan !== 'max') maxBtn.disabled = false;
      }
    };
  }
}

async function populatePlanModal(context = {}) {
  const data = context.usage || await window.__loadPlanUsage();
  const plan = data?.plan || 'free';
  const usageCounters = data?.usageCounters || {};
  const limits = data?.limits || {};
  const featureLabel = formatPlanUsageLabel(context.featureKey);
  const count = context.count ?? usageCounters?.[context.featureKey]?.count;
  const limit = context.limit ?? limits?.[context.featureKey];

  const title = document.getElementById('cf-plan-modal-title');
  const copy = document.getElementById('cf-plan-modal-copy');
  const currentName = document.getElementById('cf-plan-current-name');
  const currentCopy = document.getElementById('cf-plan-current-copy');
  const currentUsage = document.getElementById('cf-plan-current-usage');
  const usageList = document.getElementById('cf-plan-usage-list');
  const freeBtn = document.getElementById('cf-plan-free-btn');
  const statusEl = document.getElementById('cf-plan-payment-status');

  if (statusEl) statusEl.textContent = '';

  if (title) title.textContent = context.reason === 'limit' ? 'Usage limit reached' : 'Choose your plan';
  if (copy) {
    if (context.reason === 'limit' && count !== undefined && limit !== undefined) {
      copy.textContent = `${featureLabel} is at ${count}/${limit} on your current ${plan} plan.`;
    } else {
      copy.textContent = data ? `You are on the ${plan} plan.` : 'Review your plan and usage before continuing.';
    }
  }
  if (currentName) currentName.textContent = formatPlanLabel(plan);
  if (currentCopy) {
    currentCopy.textContent = data?.hasChosenPlan
      ? `Plan selected on ${data.planSelectedAt ? new Date(data.planSelectedAt).toLocaleDateString() : 'an earlier date'}.`
      : 'Default plan, no selection recorded yet.';
  }
  if (currentUsage) {
    currentUsage.textContent = context.reason === 'limit' && count !== undefined && limit !== undefined
      ? `${featureLabel}: ${count}/${limit}`
      : '';
  }

  if (usageList) {
    const order = ['resumeAnalysis', 'jobFitResume', 'interviewPrep', 'coverLetter'];
    usageList.innerHTML = order.map((key) => {
      const item = usageCounters[key] || { count: 0, lastReset: null };
      const itemLimit = limits[key];
      const safeLimit = itemLimit === Infinity ? '∞' : (itemLimit ?? '—');
      return `<li><span>${formatPlanUsageLabel(key)}</span><span>${item.count || 0}/${safeLimit}</span></li>`;
    }).join('');
  }

  if (freeBtn) {
    freeBtn.disabled = plan === 'free' && !!data?.hasChosenPlan;
    freeBtn.textContent = plan === 'free' && !data?.hasChosenPlan ? 'Confirm Free Plan' : 'Select Free Plan';
    freeBtn.onclick = async () => {
      try {
        const headers = await window.__getAuthHeaders();
        if (!headers.Authorization) throw new Error('Please sign in first');
        const resp = await fetch(`${window.__getBackendUrlSync()}/api/plans/select-free`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({}),
        });
        const result = await resp.json().catch(() => ({}));
        if (!resp.ok || !result.success) throw new Error(result.error || `Server error ${resp.status}`);
        closePlanSelectionModal();
        if (window.__refreshPlanDashboard) window.__refreshPlanDashboard();
      } catch (err) {
        console.error('[Plans] select-free failed:', err.message);
        if (statusEl) {
          statusEl.textContent = err.message;
        } else {
          alert(err.message);
        }
      }
    };
  }

  try {
    const catalog = await loadPaymentCatalog();
    await configurePaidPlanButtons({ currentPlan: plan, catalog, statusEl });
  } catch (err) {
    console.error('[Plans] payment catalog load failed:', err.message);
    if (statusEl) statusEl.textContent = err.message;
  }

  // Populate static feature lists for visual clarity
  try {
    const freeFeaturesEl = document.getElementById('cf-plan-free-features');
    const proFeaturesEl = document.getElementById('cf-plan-pro-features');
    const maxFeaturesEl = document.getElementById('cf-plan-max-features');

    if (freeFeaturesEl) {
      freeFeaturesEl.innerHTML = (PLAN_FEATURES.free || []).map(f => `<li>${f}</li>`).join('');
    }
    if (proFeaturesEl) {
      proFeaturesEl.innerHTML = (PLAN_FEATURES.pro || []).map(f => `<li>${f}</li>`).join('');
    }
    if (maxFeaturesEl) {
      maxFeaturesEl.innerHTML = (PLAN_FEATURES.max || []).map(f => `<li>${f}</li>`).join('');
    }
  } catch (e) {
    // non-fatal
  }
}

window.__openPlanSelectionModal = async (context = {}) => {
  openPlanSelectionModal();
  await populatePlanModal(context);
};

window.__closePlanSelectionModal = closePlanSelectionModal;

window.__handlePlanLimitResponse = async (resp, featureLabel, featureKey) => {
  if (!resp || resp.status !== 403) return false;
  const data = await resp.clone().json().catch(() => ({}));
  if (data.error !== 'Usage limit reached') return false;
  await window.__openPlanSelectionModal({
    reason: 'limit',
    featureLabel,
    featureKey,
    plan: data.plan,
    limit: data.limit,
    count: data.count,
    usage: await window.__loadPlanUsage().catch(() => null),
  });
  return true;
};

function mountShell() {
  const activeKey = detectPageKey();
  document.body.dataset.cfPage = activeKey;
  document.body.classList.add('cf-shell-enabled');
  document.body.insertAdjacentHTML('afterbegin', shellMarkup(activeKey));
  document.body.insertAdjacentHTML('beforeend', footerMarkup());
}

async function loadClerkUIBundle(publishableKey) {
  const parts = publishableKey.split('_');
  if (parts.length < 3) throw new Error('Invalid Clerk publishable key');
  const clerkDomain = atob(parts[2]).slice(0, -1);

  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://${clerkDomain}/npm/@clerk/ui@1/dist/ui.browser.js`;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load Clerk UI bundle'));
    document.head.appendChild(script);
  });
}

function closeAuthModal() {
  try {
    clerk.closeSignIn?.();
    clerk.closeSignUp?.();
  } catch (e) {
    // no-op
  }
}

function openAuthModal(view) {
  if (!clerk) return;

  closeAuthModal();

  const clerkAppearance = {
    variables: {
      colorPrimary: '#57d6ff',
      colorBackground: '#0b1222',
      colorInputBackground: '#101a31',
      colorText: '#f1f5f9',
      colorTextSecondary: '#94a3b8',
      colorInputText: '#f1f5f9',
    },
    elements: {
      card: 'border: 1px solid rgba(87, 214, 255, 0.25)',
      headerTitle: 'color: #f1f5f9',
      headerSubtitle: 'color: #94a3b8',
      dividerText: 'color: #64748b',
      footerActionText: 'color: #94a3b8',
      footerActionLink: 'color: #57d6ff',
      formFieldLabel: 'color: #cbd5e1',
      formFieldInput: 'color: #f1f5f9',
      socialButtonsBlockButton: 'color: #f1f5f9; border-color: rgba(148,163,184,0.25)',
      socialButtonsBlockButtonText: 'color: #f1f5f9',
      formButtonPrimary: 'background: linear-gradient(135deg, #57d6ff 0%, #7c3aed 100%); color: #071126; border: none',
      alertText: 'color: #f1f5f9',
      identityPreviewText: 'color: #f1f5f9',
    },
  };

  if (view === 'signUp') {
    clerk.openSignUp({
      signInUrl: '/',
      afterSignInUrl: window.location.href,
      afterSignUpUrl: window.location.href,
      oauthFlow: 'popup',
      appearance: clerkAppearance,
    });
  } else {
    clerk.openSignIn({
      signUpUrl: '/',
      afterSignInUrl: window.location.href,
      afterSignUpUrl: window.location.href,
      oauthFlow: 'popup',
      appearance: clerkAppearance,
    });
  }
}

function attachShellEvents() {
  document.getElementById('cf-login-btn')?.addEventListener('click', () => openAuthModal('signIn'));
  document.getElementById('cf-register-btn')?.addEventListener('click', () => openAuthModal('signUp'));
  document.getElementById('cf-mobile-login-btn')?.addEventListener('click', () => openAuthModal('signIn'));
  document.getElementById('cf-mobile-register-btn')?.addEventListener('click', () => openAuthModal('signUp'));
  document.getElementById('cf-gate-login')?.addEventListener('click', () => openAuthModal('signIn'));
  document.getElementById('cf-gate-register')?.addEventListener('click', () => openAuthModal('signUp'));
  document.getElementById('cf-plan-modal-close')?.addEventListener('click', closePlanSelectionModal);

  const mobileToggle = document.getElementById('cf-shell-mobile-toggle');
  const mobileMenu = document.getElementById('cf-shell-mobile-menu');

  mobileToggle?.addEventListener('click', () => {
    mobileMenu?.classList.toggle('open');
    mobileToggle?.classList.toggle('open');
  });

  // Close mobile menu when any link inside it is clicked
  mobileMenu?.addEventListener('click', (event) => {
    const anchor = event.target.closest('a');
    if (anchor) {
      mobileMenu.classList.remove('open');
      mobileToggle?.classList.remove('open');
    }
  });

  document.addEventListener('click', (event) => {
    const anchor = event.target.closest('a[href]');
    if (!anchor || !clerk || clerk.isSignedIn) return;

    const target = new URL(anchor.getAttribute('href'), window.location.origin);
    if (!isFeaturePath(target.pathname)) return;

    event.preventDefault();
    pendingFeaturePath = `${target.pathname}${target.search}${target.hash}`;
    openAuthModal('signIn');
  });
}

function updateFeatureAccess() {
  const gate = document.getElementById('cf-feature-gate');
  if (!gate || !clerk) return;

  const featurePage = detectPageKey() !== 'home';

  if (!clerk.isSignedIn && featurePage) {
    gate.classList.add('open');
    gate.setAttribute('aria-hidden', 'false');
    openAuthModal('signIn');
    return;
  }

  gate.classList.remove('open');
  gate.setAttribute('aria-hidden', 'true');
}

function updateAuthUI() {
  const loginBtns = ['cf-login-btn', 'cf-mobile-login-btn'].map(id => document.getElementById(id)).filter(Boolean);
  const registerBtns = ['cf-register-btn', 'cf-mobile-register-btn'].map(id => document.getElementById(id)).filter(Boolean);
  const profileLinks = ['cf-profile-link', 'cf-mobile-profile-link'].map(id => document.getElementById(id)).filter(Boolean);
  const userButton = document.getElementById('cf-user-button');

  if (!userButton || !clerk) return;

  if (clerk.isSignedIn) {
    loginBtns.forEach(el => el.style.display = 'none');
    registerBtns.forEach(el => el.style.display = 'none');
    profileLinks.forEach(el => el.style.display = 'inline-flex');
    userButton.style.display = 'block';
    userButton.innerHTML = '';
    clerk.mountUserButton(userButton, {
      userProfileMode: 'modal',
      appearance: {
        variables: {
          colorPrimary: '#57d6ff',
          colorBackground: '#0b1222',
          colorText: '#f1f5f9',
          colorTextSecondary: '#94a3b8',
          colorInputBackground: '#101a31',
          colorInputText: '#f1f5f9',
        },
        elements: {
          card: 'border: 1px solid rgba(87, 214, 255, 0.25)',
          headerTitle: 'color: #f1f5f9',
          headerSubtitle: 'color: #94a3b8',
          formFieldLabel: 'color: #cbd5e1',
          formFieldInput: 'color: #f1f5f9',
          formButtonPrimary: 'background: linear-gradient(135deg, #57d6ff 0%, #7c3aed 100%); color: #071126; border: none',
        },
      },
    });

    if (pendingFeaturePath) {
      const nextPath = pendingFeaturePath;
      pendingFeaturePath = null;
      window.location.href = nextPath;
      return;
    }

    promptForUsernameIfNeeded();
  } else {
    try {
      clerk.unmountUserButton(userButton);
    } catch (e) {
      // no-op
    }
    userButton.style.display = 'none';
    profileLinks.forEach(el => el.style.display = 'none');
    loginBtns.forEach(el => el.style.display = 'inline-flex');
    registerBtns.forEach(el => el.style.display = 'inline-flex');
    sessionStorage.removeItem('cf_username_collected');
  }

  updateFeatureAccess();
}

async function initClerk() {
  await loadRuntimeConfig();

  const clerkPublishableKey = window.__CLERK_PUBLISHABLE_KEY;
  if (!clerkPublishableKey) {
    throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY in runtime config');
  }

  await loadClerkUIBundle(clerkPublishableKey);

  clerk = new Clerk(clerkPublishableKey);
  await clerk.load({
    ui: { ClerkUI: window.__internal_ClerkUICtor },
    signInFallbackRedirectUrl: window.location.href,
    signUpFallbackRedirectUrl: window.location.href,
      afterSignOutUrl: '/',
  });

  clerk.addListener(() => updateAuthUI());
  updateAuthUI();
  promptForUsernameIfNeeded();
  if (typeof window.__resolveClerkReady === 'function') {
    window.__resolveClerkReady();
  }
}

function injectClerkThemeCSS() {
  const style = document.createElement('style');
  style.textContent = `
    :root {
      --clerk-color-text: #f1f5f9;
      --clerk-color-text-secondary: #94a3b8;
      --clerk-color-background: #0b1222;
      --clerk-color-primary: #57d6ff;
      --clerk-color-input-background: #101a31;
      --clerk-color-input-text: #f1f5f9;
    }
    #clerk-modal,
    [class*="cl-"],
    [class*="cl-card"],
    [class*="cl-formFieldLabel"],
    [class*="cl-headerTitle"],
    [class*="cl-headerSubtitle"],
    [class*="cl-footerActionText"],
    [class*="cl-dividerText"],
    [class*="cl-socialButtons"],
    [class*="cl-alertText"],
    [class*="cl-identityPreview"],
    [class*="cl-formHeader"] {
      color: #f1f5f9 !important;
    }
    [class*="cl-formFieldInput"],
    [class*="cl-input"] {
      color: #f1f5f9 !important;
      background-color: #101a31 !important;
    }
    [class*="cl-card"] {
      background: #0b1222 !important;
      border: 1px solid rgba(87, 214, 255, 0.25) !important;
    }
    [class*="cl-formButtonPrimary"],
    [class*="cl-primary"] {
      background: linear-gradient(135deg, #57d6ff 0%, #7c3aed 100%) !important;
      color: #071126 !important;
      border: none !important;
    }
    [class*="cl-footerActionLink"],
    [class*="cl-link"] {
      color: #57d6ff !important;
    }
  `;
  document.head.appendChild(style);
}

async function bootstrap() {
  injectClerkThemeCSS();
  mountShell();
  attachShellEvents();

  try {
    await initClerk();
  } catch (error) {
    console.error('Clerk initialization failed:', error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
