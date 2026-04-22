
 * MediaPipe Pose landmark indices used:
 *   0=nose  7=l-ear  8=r-ear  11=l-shoulder  12=r-shoulder
 *   13=l-elbow  14=r-elbow  15=l-wrist  16=r-wrist
 *   23=l-hip  24=r-hip  25=l-knee  26=r-knee  27=l-ankle  28=r-ankle
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// § 1  JOINT ANGLE ENGINE
// ─────────────────────────────────────────────────────────────

/**
 * Calculate the angle (degrees) at vertex B in the triangle A–B–C.
 * Uses the dot-product / arc-cosine formula.
 *
 * θ = arccos( (BA · BC) / (|BA| · |BC|) )
 *
 * @param {{x:number,y:number}} a  — first point
 * @param {{x:number,y:number}} b  — vertex (middle joint)
 * @param {{x:number,y:number}} c  — third point
 * @returns {number} angle in degrees, or 0 if degenerate
 */
function calculateAngle(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };
  const dot   = ba.x * bc.x + ba.y * bc.y;
  const magBA = Math.hypot(ba.x, ba.y);
  const magBC = Math.hypot(bc.x, bc.y);
  if (magBA === 0 || magBC === 0) return 0;
  const cosTheta = Math.min(1, Math.max(-1, dot / (magBA * magBC)));
  return Math.acos(cosTheta) * (180 / Math.PI);
}

/**
 * Neck angle — measures how far the head has drifted forward.
 * Computed as: ear → mid-shoulder → mid-hip.
 * Healthy range: 145°–180° (nearly straight line).
 *
 * @param {Array} lm  MediaPipe pose landmarks
 * @returns {number|null}
 */
function getNeckAngle(lm) {
  const ls = lm[11], rs = lm[12], lh = lm[23], rh = lm[24];
  if (!ls || !rs || !lh || !rh) return null;
  if (ls.visibility < 0.5 || rs.visibility < 0.5) return null;

  const midShoulder = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const midHip      = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };

  // Pick the more-visible ear
  const le = lm[7], re = lm[8];
  let ear = null;
  if (le && re)      ear = le.visibility >= re.visibility ? le : re;
  else if (le)       ear = le;
  else if (re)       ear = re;
  if (!ear || ear.visibility < 0.3) return null;

  return calculateAngle(ear, midShoulder, midHip);
}

/**
 * Torso angle — deviation from vertical.
 * Computed as: mid-shoulder → mid-hip → point directly below mid-hip.
 * Healthy range: 160°–180°.
 *
 * @param {Array} lm
 * @returns {number|null}
 */
function getTorsoAngle(lm) {
  const ls = lm[11], rs = lm[12], lh = lm[23], rh = lm[24];
  if (!ls || !rs || !lh || !rh) return null;
  if ([ls, rs, lh, rh].some(p => p.visibility < 0.5)) return null;

  const midShoulder = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const midHip      = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const below       = { x: midHip.x,            y: midHip.y + 0.1    };  // reference vertical

  return calculateAngle(midShoulder, midHip, below);
}

/**
 * Shoulder tilt — angle of the shoulder line relative to horizontal.
 * Healthy range: < 5°.
 *
 * @param {Array} lm
 * @returns {number|null}
 */
function getShoulderTilt(lm) {
  const ls = lm[11], rs = lm[12];
  if (!ls || !rs || ls.visibility < 0.5 || rs.visibility < 0.5) return null;
  const dy = rs.y - ls.y;
  const dx = rs.x - ls.x;
  return Math.abs(Math.atan2(dy, dx) * (180 / Math.PI));
}

/**
 * Elbow angle — shoulder → elbow → wrist.
 * Healthy desk range: 90°–120°.
 * Tries left side first, falls back to right.
 *
 * @param {Array} lm
 * @returns {number|null}
 */
function getElbowAngle(lm) {
  const pairs = [
    [lm[11], lm[13], lm[15]],   // left
    [lm[12], lm[14], lm[16]],   // right
  ];
  for (const [s, e, w] of pairs) {
    if (s && e && w && s.visibility > 0.5 && e.visibility > 0.5 && w.visibility > 0.5) {
      return calculateAngle(s, e, w);
    }
  }
  return null;
}

/**
 * Knee angle — hip → knee → ankle.
 * Healthy seated range: 85°–95°.
 * Tries left side first, falls back to right.
 *
 * @param {Array} lm
 * @returns {number|null}
 */
function getKneeAngle(lm) {
  const pairs = [
    [lm[23], lm[25], lm[27]],   // left
    [lm[24], lm[26], lm[28]],   // right
  ];
  for (const [h, k, a] of pairs) {
    if (h && k && a && h.visibility > 0.5 && k.visibility > 0.5 && a.visibility > 0.5) {
      return calculateAngle(h, k, a);
    }
  }
  return null;
}

/**
 * Compute all joint angles in one call.
 *
 * @param {Array} lm  MediaPipe landmarks
 * @returns {{ neck: number|null, torso: number|null, shoulder: number|null, elbow: number|null, knee: number|null }}
 */
function getAllAngles(lm) {
  return {
    neck:     getNeckAngle(lm),
    torso:    getTorsoAngle(lm),
    shoulder: getShoulderTilt(lm),
    elbow:    getElbowAngle(lm),
    knee:     getKneeAngle(lm),
  };
}


// ─────────────────────────────────────────────────────────────
// § 2  POSTURE CLASSIFICATION
// ─────────────────────────────────────────────────────────────

/**
 * Map active posture issues to a descriptive label.
 *
 * @param {Object} issues  — map from key → { active, label }
 * @returns {string}
 */
function classifyPosture(issues) {
  const active = Object.entries(issues).filter(([, v]) => v.active);

  if (active.length === 0)  return 'Excellent posture';
  if (active.length >= 3)   return 'Fatigue posture detected';

  const keys = active.map(([k]) => k);

  if (keys.length === 1) {
    if (keys[0] === 'forwardHead')    return 'Mild forward head';
    if (keys[0] === 'torsoLean')      return 'Slouching risk';
    if (keys[0] === 'unevenShoulders') return 'Uneven shoulders';
    if (keys[0] === 'headDown')       return 'Head tilted down';
  }
  return 'Multiple issues — correct now';
}


// ─────────────────────────────────────────────────────────────
// § 3  ERGONOMIC SCORE ENGINE
// ─────────────────────────────────────────────────────────────

/**
 * Calculate ergonomic score out of 100.
 *
 * Component breakdown:
 *   Shoulders level   → 25 pts
 *   Head neutral      → 25 pts
 *   Torso upright     → 25 pts
 *   Movement breaks   → 25 pts  (scales with goodPct if no formal break)
 *
 * @param {Object}  issues      current posture issues map
 * @param {number}  goodPct     0–100, overall % of good-posture frames
 * @param {boolean} tookBreak   whether a stretch break was logged this session
 * @returns {{ score:number, breakdown:Object, advice:string[] }}
 */
function calculateErgonomicScore(issues, goodPct, tookBreak) {
  const breakdown = {};
  const advice    = [];

  // Shoulders (25 pts)
  const shouldersOk = !issues.unevenShoulders?.active;
  breakdown.shoulders = shouldersOk ? 25 : 10;
  if (!shouldersOk) advice.push('Level your shoulders — one side is raised');

  // Head / neck (25 pts)
  const headOk = !issues.forwardHead?.active && !issues.headDown?.active;
  breakdown.head = headOk ? 25 : 10;
  if (!headOk) advice.push('Raise monitor to eye level and keep chin tucked');

  // Torso (25 pts)
  const torsoOk = !issues.torsoLean?.active;
  breakdown.torso = torsoOk ? 25 : 10;
  if (!torsoOk) advice.push('Sit tall — engage your lower back against the chair');

  // Breaks (25 pts — proportional to overall good-posture %)
  breakdown.breaks = tookBreak ? 25 : Math.round((goodPct / 100) * 25);
  if (!tookBreak) advice.push('Take a 5-min stretch break every 45 minutes');

  const score = breakdown.shoulders + breakdown.head + breakdown.torso + breakdown.breaks;
  return { score: Math.min(100, Math.round(score)), breakdown, advice };
}


// ─────────────────────────────────────────────────────────────
// § 4  CSV EXPORT
// ─────────────────────────────────────────────────────────────

/**
 * Build and trigger download of a session CSV report.
 *
 * Columns:
 *   timestamp | ergo_score | neck_angle_deg | shoulder_tilt_deg |
 *   torso_angle_deg | active_issues | classification
 *
 * @param {Array}  rows       array of data-row objects collected during session
 * @param {string} sessionId  e.g. "2026-04-22_14-32"
 */
function exportCSV(rows, sessionId) {
  if (!rows || rows.length === 0) {
    alert('No session data to export.\nStart a monitoring session and record some data first.');
    return;
  }

  const headers = [
    'timestamp',
    'ergo_score',
    'neck_angle_deg',
    'shoulder_tilt_deg',
    'torso_angle_deg',
    'active_issues',
    'classification',
  ];

  const lines = [headers.join(',')];

  rows.forEach(r => {
    const row = [
      r.timestamp                                            || '',
      r.ergoScore        != null ? r.ergoScore              : '',
      r.neckAngle        != null ? r.neckAngle.toFixed(1)   : '',
      r.shoulderTilt     != null ? r.shoulderTilt.toFixed(1): '',
      r.torsoAngle       != null ? r.torsoAngle.toFixed(1)  : '',
      '"' + (r.issues         || '')                        + '"',
      '"' + (r.classification || '')                        + '"',
    ];
    lines.push(row.join(','));
  });

  const csv  = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href     = url;
  a.download = `postureai-session-${sessionId}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


// ─────────────────────────────────────────────────────────────
// § 5  SESSION PERSISTENCE  (localStorage)
// ─────────────────────────────────────────────────────────────

const _STORAGE_KEY    = 'postureai_sessions_v2';
const _MAX_SESSIONS   = 10;

/**
 * Persist a completed session summary to localStorage.
 *
 * @param {{ date:string, duration:string, score:number, goodPct:number, alerts:number }} session
 */
function saveSession(session) {
  try {
    const all = loadSessions();
    all.unshift(session);
    localStorage.setItem(_STORAGE_KEY, JSON.stringify(all.slice(0, _MAX_SESSIONS)));
  } catch (e) {
    console.warn('[PostureAI] localStorage write failed:', e);
  }
}

/**
 * Load all saved session summaries.
 *
 * @returns {Array}
 */
function loadSessions() {
  try {
    return JSON.parse(localStorage.getItem(_STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

/**
 * Clear all stored sessions.
 */
function clearSessions() {
  localStorage.removeItem(_STORAGE_KEY);
}
