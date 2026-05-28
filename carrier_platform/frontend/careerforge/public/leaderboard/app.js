const DEFAULT_SERVER_URL = 'http://localhost:5000';
let SERVER_URL = window.__SERVER_URL || DEFAULT_SERVER_URL;

async function resolveServerUrl() {
  if (typeof window.__resolveServerUrl === 'function') {
    try {
      SERVER_URL = await window.__resolveServerUrl();
    } catch (err) {
      console.error('[Leaderboard] Failed to resolve backend URL:', err?.message || err);
    }
  }
  return SERVER_URL;
}

let activeCategory = '';
let clerk = null;
let authHeaders = {};

const MEDALS = ['🥇', '🥈', '🥉'];

function qs(sel, parent) { return (parent || document).querySelector(sel); }
function qsa(sel, parent) { return (parent || document).querySelectorAll(sel); }

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatDate(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleDateString(); } catch { return '-'; }
}

function getRankColor(rank) {
  if (rank <= 10) return 'gold';
  if (rank <= 25) return 'silver';
  if (rank <= 50) return 'bronze';
  return '';
}

async function loadAuth() {
  const h = await window.__getAuthHeaders();
  authHeaders = h;
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { ...authHeaders } });
  if (!resp.ok) {
    console.error(`[Leaderboard] API failed: ${resp.status} ${resp.statusText} for ${url}`);
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Render Your Rankings ──
function renderMyRankings(rankings) {
  const container = document.getElementById('lbMyRankings');
  const cards = document.getElementById('lbMyCards');
  if (!rankings || rankings.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  cards.innerHTML = rankings.map(r => {
    const resumeColor = getRankColor(r.resumeRank);
    const interviewColor = getRankColor(r.interviewRank);

    const resumeHtml = r.resumeRank
      ? `🏅 <strong>#${r.resumeRank}</strong> of ${r.resumeTotal}`
      : 'Analyze a resume to join';

    const interviewHtml = r.interviewRank
      ? `🏅 <strong>#${r.interviewRank}</strong> of ${r.interviewTotal}`
      : 'Complete an interview to join';

    return `
      <div class="lb-my-card">
        <div class="lb-my-category">${esc(r.category)}</div>
        <div class="lb-my-stats">
          <div class="lb-my-stat">
            <span class="lb-my-label">Resume</span>
            <span class="lb-my-value ${resumeColor}">${resumeHtml}</span>
          </div>
          <div class="lb-my-stat">
            <span class="lb-my-label">Interview</span>
            <span class="lb-my-value ${interviewColor}">${interviewHtml}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ── Render Category Tabs ──
function renderTabs(categories) {
  const container = document.getElementById('lbTabs');
  if (!categories || categories.length === 0) {
    container.innerHTML = '<div class="lb-empty">No categories available yet.</div>';
    return;
  }

  container.innerHTML = categories.map(c => {
    const total = (c.resumeCount || 0) + (c.interviewCount || 0);
    return `<button class="lb-tab ${c.category === activeCategory ? 'active' : ''}" data-category="${esc(c.category)}">
      ${esc(c.category)}
      <span class="lb-tab-count">${total}</span>
    </button>`;
  }).join('');

  qsa('.lb-tab', container).forEach(btn => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.category;
      loadCategoryData(activeCategory);
      qsa('.lb-tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

// ── Render Resume Table ──
function renderResumeTable(entries) {
  const body = document.getElementById('lbResumeBody');
  const empty = document.getElementById('lbResumeEmpty');
  const wrap = document.getElementById('lbResumeWrap');

  if (!entries || entries.length === 0) {
    wrap.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  wrap.style.display = 'block';

  body.innerHTML = entries.map(e => {
    const medal = e.rank <= 3 ? MEDALS[e.rank - 1] + ' ' : '';
    const cls = e.rank <= 3 ? 'class="medal-row"' : '';
    return `<tr ${cls}>
      <td class="col-rank">${medal}${e.rank}</td>
      <td class="col-name">${esc(e.userName)}</td>
      <td class="col-score"><span class="lb-score-badge">${e.resumeScore}</span></td>
      <td class="col-title">${esc(e.jobTitle) || '-'}</td>
      <td class="col-date">${formatDate(e.analyzedAt)}</td>
    </tr>`;
  }).join('');
}

// ── Render Interview Table ──
function renderInterviewTable(entries) {
  const body = document.getElementById('lbInterviewBody');
  const empty = document.getElementById('lbInterviewEmpty');
  const wrap = document.getElementById('lbInterviewWrap');

  if (!entries || entries.length === 0) {
    wrap.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  wrap.style.display = 'block';

  body.innerHTML = entries.map(e => {
    const medal = e.rank <= 3 ? MEDALS[e.rank - 1] + ' ' : '';
    return `<tr>
      <td class="col-rank">${medal}${e.rank}</td>
      <td class="col-name">${esc(e.userName)}</td>
      <td class="col-score"><span class="lb-score-badge">${e.interviewScore}</span></td>
      <td class="col-title">${esc(e.jobTitle) || '-'}</td>
      <td class="col-type">${esc(e.interviewType) || '-'}</td>
      <td class="col-diff">${esc(e.difficulty) || '-'}</td>
      <td class="col-date">${formatDate(e.completedAt)}</td>
    </tr>`;
  }).join('');
}

// ── Load category data ──
async function loadCategoryData(category) {
  document.getElementById('lbSkeleton').style.display = 'block';
  document.getElementById('lbTables').style.display = 'none';

  try {
    const [resumeData, interviewData] = await Promise.all([
      fetchJson(`${SERVER_URL}/api/leaderboard/resume/${encodeURIComponent(category)}`),
      fetchJson(`${SERVER_URL}/api/leaderboard/interview/${encodeURIComponent(category)}`),
    ]);

    renderResumeTable(resumeData.entries);
    renderInterviewTable(interviewData.entries);
  } catch (err) {
    console.error('Failed to load category data:', err);
    document.getElementById('lbResumeBody').innerHTML = '<tr><td colspan="5" style="text-align:center;color:#6b7280;">Failed to load data</td></tr>';
    document.getElementById('lbInterviewBody').innerHTML = '<tr><td colspan="7" style="text-align:center;color:#6b7280;">Failed to load data</td></tr>';
  }

  document.getElementById('lbSkeleton').style.display = 'none';
  document.getElementById('lbTables').style.display = 'grid';
}

// ── Bootstrap ──
async function bootstrap() {
  await resolveServerUrl();
  await loadAuth();

  const categoryPromise = fetchJson(`${SERVER_URL}/api/leaderboard/categories`);
  const mePromise = authHeaders.Authorization ? fetchJson(`${SERVER_URL}/api/leaderboard/me`) : Promise.resolve(null);

  // Load categories
  try {
    const catData = await categoryPromise;
    const categories = catData.categories || [];
    if (categories.length > 0) {
      activeCategory = categories[0].category;
    }
    renderTabs(categories);
  } catch (err) {
    console.error('Failed to load categories:', err);
    document.getElementById('lbTabs').innerHTML = '<div class="lb-empty">Failed to load categories.</div>';
  }

  // Load user rankings if logged in
  try {
    if (authHeaders.Authorization) {
      const meData = await mePromise;
      if (meData) renderMyRankings(meData.rankings);
    }
  } catch (err) {
    console.error('Failed to load my rankings:', err);
  }

  // Load first category
  if (activeCategory) {
    await loadCategoryData(activeCategory);
  }
}

// Wait for Clerk ready
window.__clerkReady.then(() => {
  bootstrap();
});
