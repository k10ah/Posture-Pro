
 
// Flow of the working
 *   • Webcam start / stop
 *   • MediaPipe Pose loading & inference
 *   • Skeleton rendering
 *   • UI updates (tabs, stats, joint angles, ergonomic score)
 *   • Alerts & productivity-mode reminders
 *   • Session persistence & history rendering
 *   • CSV export wiring
 *
 * Depends on: analytics.js  
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// § 1  DOM REFERENCES
// ─────────────────────────────────────────────────────────────

const video  = document.getElementById('videoEl');
const canvas = document.getElementById('canvasEl');
const ctx    = canvas.getContext('2d');

// ─────────────────────────────────────────────────────────────
// § 2  STATE
// ─────────────────────────────────────────────────────────────

let pose         = null;
let camera       = null;
let isRunning    = false;
let sessionStart = null;

// Frame counters
let goodFrames         = 0;
let badFrames          = 0;
let totalFrames        = 0;
let consecutiveBadFrames = 0;

// Alerts
let alertCount   = 0;
let lastAlertTime = 0;

// Ergonomics
let tookBreak    = false;
let currentErgoScore  = 0;

// Productivity mode
let productivityInterval = null;
let sittingMinutes       = 0;
const BREAK_INTERVAL_MIN = 45;

// CSV data rows — sampled every 5 s
let csvRows       = [];
let csvSampleTimer = null;
let sessionId     = '';

// History mini-chart data (in-memory, last 8 snapshots)
let historyData      = [];
let historyInterval  = null;

// Event log
let logEntries   = [];

// Current posture issues snapshot
let currentIssues = {};

// Active tab
let activeTab = 'live';

// Sensitivity thresholds array indexed 0–4
const THRESHOLDS = {
  shoulderLeveling: [0.030, 0.045, 0.060, 0.075, 0.090],
  forwardHead:      [0.120, 0.100, 0.080, 0.060, 0.040],
  torsoLean:        [0.080, 0.065, 0.050, 0.040, 0.030],
};

// ─────────────────────────────────────────────────────────────
// § 3  HELPERS
// ─────────────────────────────────────────────────────────────

function getSensitivity() {
  return parseInt(document.getElementById('sensitivitySlider').value, 10) - 1;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function buildSessionId() {
  const d = new Date();
  return d.toISOString().slice(0, 10) + '_' +
         String(d.getHours()).padStart(2,'0') + '-' +
         String(d.getMinutes()).padStart(2,'0');
}

function fmtAngle(v) {
  return v != null ? v.toFixed(1) + '°' : '—';
}

function getGoodPct() {
  const t = goodFrames + badFrames;
  return t > 0 ? Math.round(goodFrames / t * 100) : 0;
}

// ─────────────────────────────────────────────────────────────
// § 4  EVENT LOG
// ─────────────────────────────────────────────────────────────

function addLog(msg, type = 'info') {
  const now = new Date();
  const ts  = now.toLocaleTimeString('en-US', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  logEntries.unshift({ time: ts, msg, type });
  if (logEntries.length > 60) logEntries.pop();
  if (activeTab === 'log') renderLog();
}

function renderLog() {
  const el = document.getElementById('sessionLog');
  if (logEntries.length === 0) {
    el.innerHTML = '<div class="empty-state">Events will appear here</div>';
    return;
  }
  el.innerHTML = logEntries.slice(0, 30).map(e => `
    <div class="log-entry log-${e.type}">
      <span class="log-time">${e.time}</span>
      <span class="log-msg">${e.msg}</span>
    </div>
  `).join('');
}

// ─────────────────────────────────────────────────────────────
// § 5  TAB SWITCHING
// ─────────────────────────────────────────────────────────────

function switchTab(name) {
  activeTab = name;
  const tabs = ['live', 'joints', 'issues', 'history', 'log'];
  tabs.forEach(t => {
    const panel = document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1));
    if (panel) panel.style.display = t === name ? 'flex' : 'none';
  });
  document.querySelectorAll('.tab').forEach((el, i) => {
    el.classList.toggle('active', tabs[i] === name);
  });

  // Refresh data-heavy tabs on switch
  if (name === 'log')     renderLog();
  if (name === 'history') renderHistoryTab();
}

// ─────────────────────────────────────────────────────────────
// § 6  POSTURE ANALYSIS
// ─────────────────────────────────────────────────────────────

function analyzePosture(lm) {
  const sens   = getSensitivity();
  const issues = {};
  let   issueCount = 0;

  const ls   = lm[11], rs   = lm[12];
  const lh   = lm[23], rh   = lm[24];
  const nose = lm[0];
  const le   = lm[7],  re   = lm[8];

  // — Uneven shoulders —
  if (ls && rs && ls.visibility > 0.5 && rs.visibility > 0.5) {
    const diff = Math.abs(ls.y - rs.y);
    const thr  = THRESHOLDS.shoulderLeveling[sens];
    issues.unevenShoulders = { active: diff > thr, val: diff.toFixed(3), label: 'Uneven shoulders', threshold: thr.toFixed(3) };
    if (issues.unevenShoulders.active) issueCount++;
  }

  // — Forward head —
  if (ls && rs && nose && nose.visibility > 0.5) {
    const midShX = (ls.x + rs.x) / 2;
    const earX   = (le && le.visibility > 0.3) ? le.x : (re && re.visibility > 0.3 ? re.x : null);
    if (earX !== null) {
      const fwd = Math.abs(earX - midShX);
      const thr = THRESHOLDS.forwardHead[sens];
      issues.forwardHead = { active: fwd > thr, val: fwd.toFixed(3), label: 'Forward head posture', threshold: thr.toFixed(3) };
      if (issues.forwardHead.active) issueCount++;
    }
  }

  // — Torso lean / slouch —
  if (ls && rs && lh && rh &&
      ls.visibility > 0.5 && rs.visibility > 0.5 &&
      lh.visibility > 0.5 && rh.visibility > 0.5) {
    const msx  = (ls.x + rs.x) / 2;
    const mhx  = (lh.x + rh.x) / 2;
    const lean = Math.abs(msx - mhx);
    const thr  = THRESHOLDS.torsoLean[sens];
    issues.torsoLean = { active: lean > thr, val: lean.toFixed(3), label: 'Torso lean / slouch', threshold: thr.toFixed(3) };
    if (issues.torsoLean.active) issueCount++;
  }

  // — Head tilted down —
  if (nose && le && re && nose.visibility > 0.5) {
    const midEarY = (le.y + re.y) / 2;
    const tilt    = nose.y - midEarY;
    issues.headDown = { active: tilt > 0.08, val: tilt.toFixed(3), label: 'Head tilted down', threshold: '0.080' };
    if (issues.headDown.active) issueCount++;
  }

  return { issues, issueCount };
}

// ─────────────────────────────────────────────────────────────
// § 7  MEDIAPIPE RESULTS CALLBACK
// ─────────────────────────────────────────────────────────────

function onResults(results) {
  if (!results.poseLandmarks) return;

  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const { issues, issueCount } = analyzePosture(results.poseLandmarks);
  currentIssues = issues;
  const isGood  = issueCount === 0;

  // Draw skeleton
  if (window.drawConnectors && window.POSE_CONNECTIONS) {
    const lineColor = isGood ? 'rgba(0,229,160,0.65)' : 'rgba(255,71,87,0.65)';
    const dotColor  = isGood ? 'rgba(0,229,160,0.95)' : 'rgba(255,71,87,0.95)';
    window.drawConnectors(ctx, results.poseLandmarks, window.POSE_CONNECTIONS, { color: lineColor, lineWidth: 2 });
    window.drawLandmarks (ctx, results.poseLandmarks, { color: dotColor, lineWidth: 1, radius: 3 });
  }
  ctx.restore();

  // Frame counting
  totalFrames++;
  if (isGood) { goodFrames++;  consecutiveBadFrames = 0; }
  else        { badFrames++;   consecutiveBadFrames++; }

  // Alert after sustained bad posture
  const now = Date.now();
  if (consecutiveBadFrames > 20 && now - lastAlertTime > 30000) {
    lastAlertTime = now;
    alertCount++;
    const msgs = Object.values(issues).filter(i => i.active).map(i => i.label);
    showAlert(msgs);
    addLog('Alert: ' + msgs.join(' · '), 'bad');
  }

  // Update live angles
  const angles = getAllAngles(results.poseLandmarks);
  updateAnglesUI(angles);

  // Compute & update ergonomic score
  const gp = getGoodPct();
  const { score, breakdown, advice } = calculateErgonomicScore(issues, gp, tookBreak);
  currentErgoScore = score;
  updateErgoUI(score, breakdown, advice);

  updateLiveUI(isGood, issues);
}

// ─────────────────────────────────────────────────────────────
// § 8  UI UPDATE FUNCTIONS
// ─────────────────────────────────────────────────────────────

function updateLiveUI(isGood, issues) {
  const badge      = document.getElementById('postureBadge');
  const overlay    = document.getElementById('issuesOverlay');
  const statusPill = document.getElementById('statusPill');
  const activeList = Object.values(issues).filter(i => i.active);

  // Classification label
  const label = classifyPosture(issues);

  if (isGood) {
    badge.className  = 'posture-badge good';
    badge.textContent = '✓ ' + label;
    statusPill.className  = 'status-pill active';
    statusPill.textContent = '● good';
  } else {
    const severity = activeList.length >= 3 ? 'bad' : 'warn';
    badge.className  = 'posture-badge ' + severity;
    badge.textContent = '⚠ ' + label;
    statusPill.className  = 'status-pill bad';
    statusPill.textContent = '● alert';
  }

  overlay.innerHTML = activeList.map(i => `<div class="issue-tag">${i.label}</div>`).join('');

  // Stats cards
  const gp = getGoodPct();
  const bp = 100 - gp;
  document.getElementById('goodPct').textContent  = gp + '%';
  document.getElementById('badPct').textContent   = bp + '%';
  document.getElementById('alertCount').textContent = alertCount;

  // Score bar
  document.getElementById('scoreNum').textContent = gp + '%';
  const fill = document.getElementById('scoreFill');
  fill.style.width      = gp + '%';
  fill.style.background = gp > 70 ? 'var(--good)' : gp > 40 ? 'var(--warn)' : 'var(--bad)';

  // Issues tab
  if (activeTab === 'issues') updateIssuesUI(issues);
}

function updateIssuesUI(issues) {
  const list    = document.getElementById('issueList');
  const entries = Object.entries(issues);
  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">Start monitoring to see posture checks</div>';
    return;
  }
  list.innerHTML = entries.map(([, d]) => `
    <div class="issue-row ${d.active ? 'active' : 'ok'}">
      <div class="issue-dot ${d.active ? 'active' : 'ok'}"></div>
      <div class="issue-info">
        <div class="issue-name">${d.label}</div>
        <div class="issue-val">val: ${d.val} / thr: ${d.threshold}</div>
      </div>
      <div class="issue-status ${d.active ? 'active' : 'ok'}">${d.active ? 'ALERT' : 'OK'}</div>
    </div>
  `).join('');
}

function updateAnglesUI(angles) {
  const defs = [
    { id: 'angleNeck',     val: angles.neck,     label: 'Neck',     unit: '°', min: 0,   max: 180, healthy: [145, 180], tip: '>145° is healthy' },
    { id: 'angleTorso',    val: angles.torso,    label: 'Torso',    unit: '°', min: 0,   max: 180, healthy: [160, 180], tip: '>160° is healthy' },
    { id: 'angleShoulder', val: angles.shoulder, label: 'Shoulder', unit: '°', min: 0,   max: 30,  healthy: [0,   5],   tip: '<5° is healthy'   },
    { id: 'angleElbow',    val: angles.elbow,    label: 'Elbow',    unit: '°', min: 0,   max: 180, healthy: [90,  120], tip: '90–120° is ideal' },
    { id: 'angleKnee',     val: angles.knee,     label: 'Knee',     unit: '°', min: 0,   max: 180, healthy: [85,  100], tip: '85–100° seated'   },
  ];

  defs.forEach(({ id, val, label, healthy, tip }) => {
    const card = document.getElementById(id);
    if (!card) return;

    const [lo, hi] = healthy;
    let status = 'angle-neutral';
    if (val != null) {
      status = (val >= lo && val <= hi) ? 'angle-good' : 'angle-bad';
    }

    card.className = 'angle-card ' + status;
    card.innerHTML = `
      <div class="angle-label">${label}</div>
      <div class="angle-val">${val != null ? val.toFixed(1) : '—'}<span class="angle-unit">${val != null ? '°' : ''}</span></div>
      <div class="angle-tip">${tip}</div>
    `;
  });
}

function updateErgoUI(score, breakdown, advice) {
  // Score ring — circumference = 2π × 36 ≈ 226.2 px
  const ringContainer = document.getElementById('ergoRing');
  if (ringContainer) {
    const color  = score >= 75 ? 'var(--good)' : score >= 50 ? 'var(--warn)' : 'var(--bad)';
    const circ   = 2 * Math.PI * 36;          // ≈ 226.2
    const arcLen = (circ * score / 100).toFixed(2);
    ringContainer.style.setProperty('--ring-progress', arcLen + 'px');
    ringContainer.style.setProperty('--ring-color',    color);
    const numEl = document.getElementById('ergoScoreNum');
    numEl.textContent = score;
    numEl.style.color = color;
  }

  // Sub-bars
  const subs = [
    { id: 'ergoShoulders', pts: breakdown.shoulders, label: 'Shoulders' },
    { id: 'ergoHead',      pts: breakdown.head,      label: 'Head / Neck' },
    { id: 'ergoTorso',     pts: breakdown.torso,     label: 'Torso' },
    { id: 'ergoBreaks',    pts: breakdown.breaks,    label: 'Activity breaks' },
  ];
  subs.forEach(({ id, pts, label }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const pct   = Math.round(pts / 25 * 100);
    const color = pct >= 80 ? 'var(--good)' : pct >= 40 ? 'var(--warn)' : 'var(--bad)';
    el.innerHTML = `
      <div class="ergo-sub-label"><span>${label}</span><span>${pts}/25</span></div>
      <div class="score-bar-track"><div class="score-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    `;
  });

  // Advice list
  const advEl = document.getElementById('ergoAdvice');
  if (advEl) {
    advEl.innerHTML = advice.length === 0
      ? '<div class="ergo-advice-item good">✓ Great ergonomics — keep it up!</div>'
      : advice.map(a => `<div class="ergo-advice-item">${a}</div>`).join('');
  }
}

function updateHistoryChart() {
  const total = goodFrames + badFrames;
  if (total < 10) return;
  const gp      = getGoodPct();
  const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
  historyData.push({ time: formatTime(elapsed), good: gp });
  if (historyData.length > 8) historyData.shift();

  const chart = document.getElementById('historyChart');
  const empty = document.getElementById('historyEmpty');
  if (empty) empty.remove();

  chart.innerHTML = historyData.map(d => `
    <div class="history-bar-row">
      <div class="history-bar-label">${d.time}</div>
      <div class="history-bar-track">
        <div class="history-bar-fill" style="width:${d.good}%;background:${d.good>70?'var(--good)':d.good>40?'var(--warn)':'var(--bad)'}"></div>
      </div>
      <div class="history-bar-pct">${d.good}%</div>
    </div>
  `).join('');
}

function renderHistoryTab() {
  const sessions = loadSessions();
  const el       = document.getElementById('savedSessions');
  if (!el) return;

  if (sessions.length === 0) {
    el.innerHTML = '<div class="empty-state">Completed sessions will appear here.<br>Stop monitoring to save a session.</div>';
    return;
  }

  el.innerHTML = sessions.map((s, i) => {
    const color = s.score >= 75 ? 'var(--good)' : s.score >= 50 ? 'var(--warn)' : 'var(--bad)';
    return `
      <div class="session-card">
        <div class="session-card-meta">
          <span class="session-card-date">${s.date}</span>
          <span class="session-card-dur">${s.duration}</span>
        </div>
        <div class="session-card-stats">
          <span style="color:${color};font-weight:700">${s.score}/100</span>
          <span style="color:var(--good)">${s.goodPct}% good</span>
          <span style="color:var(--warn)">${s.alerts} alerts</span>
        </div>
      </div>
    `;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// § 9  ALERTS
// ─────────────────────────────────────────────────────────────

function showAlert(msgs, isBreakReminder = false) {
  const banner = document.getElementById('alertBanner');
  banner.className = 'alert-banner show' + (isBreakReminder ? ' break-reminder' : '');
  banner.textContent = isBreakReminder
    ? '🧘 Time for a stretch break! You\'ve been sitting for ' + sittingMinutes + ' min.'
    : '⚠ ' + msgs.join(' · ');
  clearTimeout(banner._hideTimer);
  banner._hideTimer = setTimeout(() => banner.classList.remove('show'), 6000);
}

// ─────────────────────────────────────────────────────────────
// § 10 CSV DATA SAMPLING
// ─────────────────────────────────────────────────────────────

function sampleCSVRow() {
  if (!isRunning) return;
  const lm      = window._lastLandmarks;
  const angles2 = lm ? getAllAngles(lm) : { neck: null, torso: null, shoulder: null };
  const gp      = getGoodPct();
  const { score } = calculateErgonomicScore(currentIssues, gp, tookBreak);
  const activeIssues = Object.values(currentIssues)
    .filter(i => i.active).map(i => i.label).join('; ');

  csvRows.push({
    timestamp:      new Date().toISOString(),
    ergoScore:      score,
    neckAngle:      angles2.neck,
    shoulderTilt:   angles2.shoulder,
    torsoAngle:     angles2.torso,
    issues:         activeIssues,
    classification: classifyPosture(currentIssues),
  });
}

// ─────────────────────────────────────────────────────────────
// § 11 START / STOP / RESET
// ─────────────────────────────────────────────────────────────

async function startMonitor() {
  // UI state
  document.getElementById('btnStart').style.display = 'none';
  document.getElementById('btnStop').style.display  = 'flex';
  ['camIdle'].forEach(id => document.getElementById(id).style.display = 'none');
  ['videoEl','canvasEl'].forEach(id => document.getElementById(id).style.display = 'block');
  document.getElementById('postureBadge').style.display  = 'flex';
  document.getElementById('issuesOverlay').style.display = 'flex';
  document.getElementById('btnExport').style.display     = 'inline-flex';

  const pill = document.getElementById('statusPill');
  pill.className   = 'status-pill active';
  pill.textContent = '● loading…';

  sessionStart = Date.now();
  sessionId    = buildSessionId();
  isRunning    = true;
  tookBreak    = false;
  csvRows      = [];

  addLog('Session started', 'info');

  // Periodic snapshots for history chart & CSV
  historyInterval = setInterval(updateHistoryChart, 15000);
  csvSampleTimer  = setInterval(sampleCSVRow, 5000);

  // Productivity mode: count sitting minutes
  sittingMinutes = 0;
  productivityInterval = setInterval(() => {
    sittingMinutes++;
    document.getElementById('sittingTime').textContent = sittingMinutes + ' min sitting';
    if (sittingMinutes > 0 && sittingMinutes % BREAK_INTERVAL_MIN === 0) {
      showAlert([], true);
      addLog(`Productivity reminder: ${sittingMinutes} min sitting`, 'warn');
    }
  }, 60000);

  try {
    pose = new Pose({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${f}`
    });
    pose.setOptions({
      modelComplexity:       1,
      smoothLandmarks:       true,
      enableSegmentation:    false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence:  0.5,
    });
    pose.onResults(results => {
      if (results.poseLandmarks) window._lastLandmarks = results.poseLandmarks;
      onResults(results);
    });

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' }
    });
    video.srcObject = stream;
    await new Promise(r => { video.onloadedmetadata = r; });

    camera = new Camera(video, {
      onFrame: async () => { if (isRunning) await pose.send({ image: video }); },
      width: 640, height: 480,
    });
    camera.start();

    pill.textContent = '● active';
    addLog('Camera and pose model ready', 'info');
  } catch (err) {
    addLog('Error: ' + err.message, 'bad');
    pill.className   = 'status-pill idle';
    pill.textContent = '● error';
    document.getElementById('camIdle').style.display = 'flex';
    document.getElementById('camIdle').querySelector('p').textContent =
      'Camera access denied or unavailable.';
    document.getElementById('btnStart').style.display = 'flex';
    document.getElementById('btnStop').style.display  = 'none';
    isRunning = false;
  }
}

function stopMonitor() {
  isRunning = false;

  if (camera) { camera.stop(); camera = null; }
  if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }

  clearInterval(historyInterval);
  clearInterval(csvSampleTimer);
  clearInterval(productivityInterval);

  document.getElementById('btnStart').style.display  = 'flex';
  document.getElementById('btnStop').style.display   = 'none';
  document.getElementById('postureBadge').style.display  = 'none';
  document.getElementById('issuesOverlay').style.display = 'none';
  document.getElementById('statusPill').className   = 'status-pill idle';
  document.getElementById('statusPill').textContent = '● idle';
  document.getElementById('sittingTime').textContent = '';

  const gp       = getGoodPct();
  const duration = sessionStart ? formatTime((Date.now() - sessionStart) / 1000) : '0:00';
  addLog(`Session ended — ${gp}% good posture — ${duration}`, 'info');
  updateHistoryChart();

  // Save to localStorage
  saveSession({
    date:     new Date().toLocaleDateString(),
    duration,
    score:    currentErgoScore,
    goodPct:  gp,
    alerts:   alertCount,
  });
  if (activeTab === 'history') renderHistoryTab();
}

function resetStats() {
  goodFrames = 0; badFrames = 0; totalFrames = 0;
  alertCount = 0; consecutiveBadFrames = 0;
  lastAlertTime = 0; logEntries = []; historyData = [];
  currentErgoScore = 0; csvRows = []; tookBreak = false;
  sessionStart = isRunning ? Date.now() : null;

  ['goodPct','badPct'].forEach(id => document.getElementById(id).textContent = '—');
  document.getElementById('sessionTime').textContent  = '0:00';
  document.getElementById('alertCount').textContent   = '0';
  document.getElementById('scoreNum').textContent     = '—';
  document.getElementById('scoreFill').style.width    = '0%';
  document.getElementById('historyChart').innerHTML   = '<div class="empty-state" id="historyEmpty">Session history appears here</div>';
  document.getElementById('ergoScoreNum').textContent = '—';

  renderLog();
  addLog('Stats reset', 'info');
}

// ─────────────────────────────────────────────────────────────
// § 12 EXPORT
// ─────────────────────────────────────────────────────────────

function triggerExport() {
  exportCSV(csvRows, sessionId || buildSessionId());
  addLog('CSV report exported', 'info');
}

function triggerBreak() {
  tookBreak = true;
  sittingMinutes = 0;
  addLog('Break taken — timer reset', 'info');
  showAlert([], true);
  document.getElementById('sittingTime').textContent = '0 min sitting';
}

function clearHistory() {
  clearSessions();
  renderHistoryTab();
  addLog('Session history cleared', 'info');
}

// ─────────────────────────────────────────────────────────────
// § 13 SESSION TIMER (1 s tick)
// ─────────────────────────────────────────────────────────────

setInterval(() => {
  if (isRunning && sessionStart) {
    const elapsed = (Date.now() - sessionStart) / 1000;
    document.getElementById('sessionTime').textContent = formatTime(elapsed);
  }
}, 1000);

// ─────────────────────────────────────────────────────────────
// § 14 INIT
// ─────────────────────────────────────────────────────────────

document.getElementById('sensitivitySlider').addEventListener('input', e => {
  document.getElementById('sensitivityVal').textContent = e.target.value;
});

switchTab('live');
renderHistoryTab();
addLog('PostureAI Pro ready', 'info');
