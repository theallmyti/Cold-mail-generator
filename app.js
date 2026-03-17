/**
 * ColdCraft — AI Cold Email Generator
 * app.js — All interactive logic
 */

const BACKEND_URL = "http://127.0.0.1:8000/api/generate";
const HISTORY_KEY = 'coldcraft_history';
const THEME_KEY   = 'coldcraft_theme';
const MAX_HISTORY = 40;

// =====================================================
// State
// =====================================================
let currentEmail = null; // { subjects, body, formData, timestamp, wordCount }
let activeModal  = null; // history entry displayed in modal

// =====================================================
// DOM Refs
// =====================================================
const $ = id => document.getElementById(id);

const pages = {
  dashboard: $('page-dashboard'),
  generator: $('page-generator'),
  history:   $('page-history'),
};

// =====================================================
// Navigation
// =====================================================
const PAGE_TITLES = {
  dashboard: 'Dashboard',
  generator: 'Generator',
  history:   'History',
};

function navigateTo(pageKey) {
  // Update pages
  Object.values(pages).forEach(p => p.classList.remove('active'));
  pages[pageKey].classList.add('active');

  // Update sidebar nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageKey);
    btn.setAttribute('aria-current', btn.dataset.page === pageKey ? 'page' : 'false');
  });

  // Update mobile tab bar
  document.querySelectorAll('.tab-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageKey);
  });

  // Topbar title
  $('topbar-title').textContent = PAGE_TITLES[pageKey];

  // Refresh data on page entry
  if (pageKey === 'dashboard') refreshDashboard();
  if (pageKey === 'history')   renderHistory();
}

// Sidebar nav items
document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.page));
});

// Mobile tab items
document.querySelectorAll('.tab-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.page));
});

// Dashboard quick cards
$('qc-generate').addEventListener('click', () => navigateTo('generator'));
$('qc-generate').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') navigateTo('generator'); });
$('qc-history').addEventListener('click', () => navigateTo('history'));
$('qc-history').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') navigateTo('history'); });

// =====================================================
// Theme
// =====================================================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  const isDark = theme === 'dark';
  $('theme-icon-sidebar').textContent  = isDark ? '☀' : '☽';
  $('theme-label-sidebar').textContent = isDark ? 'Light Mode' : 'Dark Mode';
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

// Restore saved theme
applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

$('theme-toggle-sidebar').addEventListener('click', toggleTheme);

// =====================================================
// Form — Char counters & validation
// =====================================================
['personalization'].forEach(id => {
  const el  = $(id);
  const ctr = $(`char-${id}`);
  el.addEventListener('input', () => {
    ctr.textContent = el.value.length;
    if (el.value.length > 300) el.value = el.value.slice(0, 300);
    ctr.textContent = el.value.length;
  });
});

const REQUIRED_FIELDS = [
  { id: 'applicantName',   label: 'Your Name' },
  { id: 'targetRole',      label: 'Target Role' },
  { id: 'managerName',     label: 'Hiring Manager Name' },
  { id: 'targetCompany',   label: 'Target Company' },
  { id: 'personalization', label: 'Personalization Detail' },
  { id: 'githubUsername',  label: 'GitHub Username' },
];

function validateForm() {
  let valid = true;
  REQUIRED_FIELDS.forEach(({ id, label }) => {
    const el  = $(id);
    const err = $(`err-${id}`);
    const empty = !el.value.trim();
    el.classList.toggle('error', empty);
    err.textContent = empty ? `${label} is required.` : '';
    if (empty) valid = false;
  });
  return valid;
}

// Clear error on input
REQUIRED_FIELDS.forEach(({ id }) => {
  $(id).addEventListener('input', () => {
    $(id).classList.remove('error');
    $(`err-${id}`).textContent = '';
  });
});



// =====================================================
// Backend API Call (SSE)
// =====================================================
async function* callLLM(data) {
  const res = await fetch(BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.detail || errBody?.error?.message || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    
    // Process SSE lines
    let lineEndIndex;
    while ((lineEndIndex = buffer.indexOf('\n\n')) !== -1) {
      const line = buffer.slice(0, lineEndIndex).trim();
      buffer = buffer.slice(lineEndIndex + 2);
      
      if (line.startsWith('data: ')) {
        const payload = line.replace('data: ', '');
        try {
          yield JSON.parse(payload);
        } catch(e) {}
      }
    }
  }
}

// =====================================================
// Output state helpers
// =====================================================
function showState(state) {
  $('output-placeholder').style.display = state === 'placeholder' ? 'flex'  : 'none';
  $('output-loading').style.display     = state === 'loading'     ? 'flex'  : 'none';
  $('output-result').style.display      = state === 'result'      ? 'flex'  : 'none';
}

function countWords(str) {
  return str.trim().split(/\s+/).filter(Boolean).length;
}

function renderResult(parsed, save = true) {
  const wc = countWords(parsed.body);

  $('composer-subject-select').innerHTML = `
    <option value="${escHtml(parsed.subject1)}">Option 1: ${escHtml(parsed.subject1)}</option>
    <option value="${escHtml(parsed.subject2)}">Option 2: ${escHtml(parsed.subject2)}</option>
  `;
  $('composer-subject').value = parsed.subject1;
  $('composer-body').value    = parsed.body;
  
  if (parsed.formData?.managerName && parsed.formData?.targetCompany) {
     const fn = parsed.formData.managerName.split(' ')[0].toLowerCase();
     const domain = parsed.formData.targetCompany.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
     $('composer-to').value = `${fn}@${domain}`;
  } else {
     $('composer-to').value = '';
  }

  $('word-count-badge').textContent = `${wc} word${wc === 1 ? '' : 's'}`;
  $('word-count-badge').style.color = wc > 100 ? '#ef4444' : '';

  showState('result');

  const subjects = `Option 1: ${parsed.subject1}\nOption 2: ${parsed.subject2}`;
  currentEmail = { ...parsed, subjects, wordCount: wc };

  if (save) saveToHistory(parsed, wc);
  refreshDashboard();
  updateHistoryBadge();
}

$('composer-subject-select').addEventListener('change', (e) => {
  $('composer-subject').value = e.target.value;
});

// =====================================================
// Form Submit
// =====================================================
$('email-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!validateForm()) return;

  const data = {
    applicantName:   $('applicantName').value.trim(),
    targetRole:      $('targetRole').value.trim(),
    managerName:     $('managerName').value.trim(),
    targetCompany:   $('targetCompany').value.trim(),
    personalization: $('personalization').value.trim(),
    githubUsername:  $('githubUsername').value.trim(),
    apiKey:          (typeof NVIDIA_API_KEY !== 'undefined') ? NVIDIA_API_KEY : '',
  };

  // Store formData for regenerate
  currentEmail = { formData: data };

  setGenerating(true);
  showState('loading');

  try {
    const stream = callLLM(data);
    for await (const event of stream) {
      if (event.type === 'progress') {
        const { message, total, scanned } = event;
        let loaderText = message;
        if (total != null && scanned != null) {
          loaderText = `${message} (${scanned}/${total})`;
        }
        $('output-loading').querySelector('.loading-text').innerHTML = `${escHtml(loaderText)}<span class="loading-dots"></span>`;
      } else if (event.type === 'result') {
        event.data.formData = data; // attach for re-use
        renderResult(event.data, true);
        break; // Generator finishes here
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
  } catch (err) {
    showState('placeholder');
    $('output-placeholder').querySelector('.placeholder-text').innerHTML =
      `<span style="color:#ef4444">⚠ ${escHtml(err.message)}</span><br><span style="font-size:12px;color:var(--text-3)">Check your API key in config.js</span>`;
    console.error(err);
  } finally {
    setGenerating(false);
  }
});

function setGenerating(on) {
  const btn = $('btn-generate');
  btn.disabled = on;
  $('btn-generate-icon').textContent = on ? '' : '✦';
  $('btn-generate-text').textContent = on ? 'Generating…' : 'Generate Email';
  if (on) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.style.cssText = 'width:16px;height:16px;border-width:2px;margin:0;';
    btn.insertBefore(spinner, btn.firstChild);
  } else {
    btn.querySelectorAll('.spinner').forEach(s => s.remove());
  }
}

// Regenerate
$('btn-regenerate').addEventListener('click', async () => {
  if (!currentEmail?.formData) return;
  setGenerating(true);
  showState('loading');
  try {
    const stream = callLLM(currentEmail.formData);
    for await (const event of stream) {
      if (event.type === 'progress') {
        const { message, total, scanned } = event;
        let loaderText = message;
        if (total != null && scanned != null) {
          loaderText = `${message} (${scanned}/${total})`;
        }
        $('output-loading').querySelector('.loading-text').innerHTML = `${escHtml(loaderText)}<span class="loading-dots"></span>`;
      } else if (event.type === 'result') {
        event.data.formData = currentEmail.formData;
        renderResult(event.data, true);
        break;
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
  } catch (err) {
    showState('result');
    showToast('Regeneration failed: ' + err.message);
    console.error(err);
  } finally {
    setGenerating(false);
  }
});

// =====================================================
// Copy helpers
// =====================================================
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = '✓ Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = orig;
      btn.classList.remove('copied');
    }, 1600);
  }).catch(() => showToast('Copy failed — please copy manually.'));
}

$('btn-copy-all').addEventListener('click', () => {
  const full = `${$('composer-subject').value}\n\n${$('composer-body').value}`;
  copyText(full, $('btn-copy-all'));
});

$('btn-send-email').addEventListener('click', () => {
  const to = $('composer-to').value.trim();
  const subject = $('composer-subject').value.trim();
  const body = $('composer-body').value;
  
  if (!to) return showToast('Please enter a recipient email.');
  
  const gmailLink = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(gmailLink, '_blank');
});

// =====================================================
// Toast
// =====================================================
let toastTimer = null;
function showToast(msg, duration = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

// =====================================================
// History
// =====================================================
function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch { return []; }
}

function saveToHistory(parsed, wordCount) {
  const hist = getHistory();
  const entry = {
    id:          Date.now(),
    timestamp:   new Date().toISOString(),
    subject1:    parsed.subject1,
    subject2:    parsed.subject2,
    body:        parsed.body,
    wordCount,
    formData:    parsed.formData || {},
  };
  hist.unshift(entry);
  if (hist.length > MAX_HISTORY) hist.splice(MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
  updateHistoryBadge();
}

function deleteHistoryEntry(id) {
  const hist = getHistory().filter(e => e.id !== id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
  renderHistory();
  refreshDashboard();
  updateHistoryBadge();
  showToast('Entry deleted.');
}

function clearHistory() {
  if (!confirm('Clear all history? This cannot be undone.')) return;
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
  refreshDashboard();
  updateHistoryBadge();
  showToast('History cleared.');
}

function updateHistoryBadge() {
  const count = getHistory().length;
  $('sidebar-history-count').textContent = count;
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHistory() {
  const hist = getHistory();
  const grid = $('history-grid');
  const empty = $('history-empty');

  if (hist.length === 0) {
    empty.style.display = 'flex';
    grid.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  grid.innerHTML = hist.map(entry => `
    <div class="history-card" data-id="${entry.id}" tabindex="0" role="button" aria-label="View email to ${escHtml(entry.formData?.managerName || 'manager')}">
      <div class="history-card-top">
        <div class="history-card-meta">
          <div class="history-card-recipient">${escHtml(entry.formData?.managerName || 'Hiring Manager')}</div>
          <div class="history-card-company">${escHtml(entry.formData?.targetCompany || '')}</div>
        </div>
        <div class="history-card-time">${relativeTime(entry.timestamp)}</div>
      </div>
      <div class="history-card-subject">${escHtml(entry.subject1 || '')}</div>
      <div class="history-card-preview">${escHtml(entry.body || '')}</div>
      <div class="history-card-footer">
        <span class="history-card-role">${escHtml(entry.formData?.targetRole || 'Role unspecified')}</span>
        <button class="history-card-del" data-del="${entry.id}" aria-label="Delete entry" title="Delete">🗑</button>
      </div>
    </div>
  `).join('');

  // Card click → open modal
  grid.querySelectorAll('.history-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.dataset.del) return; // handled below
      const id = Number(card.dataset.id);
      const entry = getHistory().find(h => h.id === id);
      if (entry) openModal(entry);
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        const id = Number(card.dataset.id);
        const entry = getHistory().find(h => h.id === id);
        if (entry) openModal(entry);
      }
    });
  });

  // Delete buttons
  grid.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteHistoryEntry(Number(btn.dataset.del));
    });
  });
}

$('btn-clear-history').addEventListener('click', clearHistory);

// =====================================================
// Dashboard Stats
// =====================================================
function refreshDashboard() {
  const hist = getHistory();
  $('stat-total').textContent = hist.length;

  const oneWeek = Date.now() - 7 * 24 * 60 * 60 * 1000;
  $('stat-week').textContent = hist.filter(e => new Date(e.timestamp).getTime() > oneWeek).length;

  const companies = new Set(hist.map(e => e.formData?.targetCompany?.toLowerCase()).filter(Boolean));
  $('stat-companies').textContent = companies.size;

  if (hist.length > 0) {
    const avg = Math.round(hist.reduce((s, e) => s + (e.wordCount || 0), 0) / hist.length);
    $('stat-words').textContent = avg;
  } else {
    $('stat-words').textContent = '—';
  }
}

// =====================================================
// History Detail Modal
// =====================================================
function openModal(entry) {
  activeModal = entry;
  $('modal-title').textContent = `Email → ${entry.formData?.managerName || 'Hiring Manager'} at ${entry.formData?.targetCompany || ''}`;

  $('modal-body').innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
      <span style="font-size:11px;background:var(--accent-subtle);border:1px solid var(--accent);color:var(--accent);border-radius:20px;padding:2px 9px;font-weight:600;">
        ${escHtml(entry.formData?.targetRole || 'Role')}
      </span>
      <span style="font-size:11px;color:var(--text-3);padding:2px 0;">
        ${entry.wordCount || '?'} words · ${new Date(entry.timestamp).toLocaleString()}
      </span>
    </div>

    <div class="subject-block">
      <div class="output-label">
        <span class="output-label-text">📌 Subject Lines</span>
      </div>
      <div class="output-text">${escHtml(`Option 1: ${entry.subject1}\nOption 2: ${entry.subject2}`)}</div>
    </div>

    <div class="body-block">
      <div class="output-label">
        <span class="output-label-text">✉ Email Body</span>
      </div>
      <div class="output-text">${escHtml(entry.body)}</div>
    </div>

    ${entry.formData?.personalization ? `
    <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-3);margin-bottom:4px;">Personalization Used</div>
      <div style="font-size:12.5px;color:var(--text-2);line-height:1.5;">${escHtml(entry.formData.personalization)}</div>
    </div>` : ''}
  `;

  $('modal-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  $('modal-close').focus();
}

function closeModal() {
  $('modal-overlay').classList.remove('open');
  document.body.style.overflow = '';
  activeModal = null;
}

$('modal-close').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', e => {
  if (e.target === $('modal-overlay')) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('modal-overlay').classList.contains('open')) closeModal();
});

$('modal-copy-all').addEventListener('click', () => {
  if (!activeModal) return;
  const text = `Option 1: ${activeModal.subject1}\nOption 2: ${activeModal.subject2}\n\n${activeModal.body}`;
  navigator.clipboard.writeText(text).then(() => showToast('✓ Copied to clipboard!'));
});

$('modal-reuse').addEventListener('click', () => {
  if (!activeModal?.formData) return;
  const fd = activeModal.formData;
  $('applicantName').value   = fd.applicantName   || '';
  $('targetRole').value      = fd.targetRole      || '';
  $('managerName').value     = fd.managerName     || '';
  $('targetCompany').value   = fd.targetCompany   || '';
  $('personalization').value = fd.personalization || '';
  $('githubUsername').value  = fd.githubUsername  || '';
  // Update char counters
  ['personalization'].forEach(id => {
    $(`char-${id}`).textContent = $(id).value.length;
  });
  closeModal();
  navigateTo('generator');
  showToast('Form loaded from history.');
});

// =====================================================
// Init
// =====================================================
refreshDashboard();
updateHistoryBadge();
showState('placeholder');
