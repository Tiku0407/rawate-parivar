/**
 * रावटे परिवार — वंश वृक्ष संग्रह
 * Google Apps Script (Google Sheet से जुड़ी स्क्रिप्ट)
 *
 * यह स्क्रिप्ट:
 *  1. फॉर्म से आई जानकारी को "Members" शीट में सेव करती है
 *  2. एक ही व्यक्ति के बार-बार दर्ज होने पर उसे पहचानकर उसी व्यक्ति में मिला देती है
 *     (नाम हिंदी या अंग्रेज़ी में हो, "स्व.", "श्री", "जी", "रावटे" आदि हटाकर मिलान)
 *  3. शक वाले नामों को "Possible_Duplicates" शीट में जाँच के लिए डालती है
 *  4. शीट में "वंश वृक्ष" मेनू देती है: डुप्लिकेट खोजें, मर्ज लागू करें
 */

const CFG = {
  MEMBERS: 'Members',
  LOG: 'Submissions',
  DUPS: 'Possible_Duplicates',
  SURNAMES: ['रावटे', 'राउटे', 'रावते', 'रावटें', 'rawate', 'rawte', 'ravate', 'raute', 'rawtey', 'rawatey'],
  TITLES: ['स्व', 'स्वर्गीय', 'श्री', 'श्रीमती', 'श्रीमान', 'कु', 'कुमारी', 'जी', 'डॉ', 'डा', 'बाई', 'ठाकुर',
           'late', 'lt', 'shri', 'sri', 'shree', 'smt', 'mr', 'mrs', 'ms', 'ku', 'kumari', 'ji', 'dr', 'bai', 'thakur', 'thakure']
};

// Members शीट के कॉलम (क्रम न बदलें)
const F = ['id', 'name', 'key', 'gender', 'parentId', 'parentName', 'spouse', 'birthYear', 'village',
           'status', 'mobile', 'notes', 'mergeInto', 'count', 'sources', 'created', 'updated'];
const COLS = ['ID', 'नाम', 'मिलान-कुंजी', 'लिंग', 'पिता_ID', 'पिता का नाम', 'पति/पत्नी', 'जन्म वर्ष', 'गाँव',
              'स्थिति', 'मोबाइल', 'टिप्पणी', 'मर्ज_ID (इसमें मिलाएँ)', 'कितनी बार दर्ज', 'जानकारी देने वाले',
              'पहली बार', 'अंतिम अपडेट'];
const LOG_COLS = ['समय', 'भरने वाले', 'मोबाइल', 'मुख्य व्यक्ति ID', 'नए जुड़े', 'पहले से मिले', 'टिप्पणी', 'पूरा डेटा'];
const DUP_COLS = ['ID-1', 'नाम-1', 'पिता-1', 'ID-2', 'नाम-2', 'पिता-2', 'कारण'];

/* ===================== वेब ऐप ===================== */

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'list') return json_(apiList());
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('रावटे परिवार वंश वृक्ष')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'डेटा पढ़ा नहीं जा सका' }); }
  return json_(apiSubmit(data));
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** वृक्ष दिखाने के लिए सूची (मोबाइल नंबर नहीं भेजे जाते) */
function apiList() {
  const members = loadMembers_();
  const idx = index_(members);
  const out = members.filter(m => !m.mergeInto).map(m => ({
    id: m.id, name: m.name, key: m.key, gender: m.gender,
    parentId: m.parentId ? idx.canon(m.parentId) : '',
    spouse: m.spouse, birthYear: m.birthYear, village: m.village, status: m.status, count: m.count
  }));
  return { ok: true, members: out };
}

/** फॉर्म से आई एक प्रविष्टि सेव करना */
function apiSubmit(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const members = loadMembers_();
    const ts = now_();
    const res = processSubmission_(members, data, ts);
    if (!res.ok) return res;
    saveMembers_(members);
    sheet_(CFG.LOG, LOG_COLS).appendRow([
      ts, safe_(data.submitter && data.submitter.name), "'" + safe_(data.submitter && data.submitter.mobile),
      res.selfId, res.created, res.matched, res.notes.join(' | '), JSON.stringify(data).slice(0, 45000)
    ]);
    if (res.dups.length) {
      const sh = sheet_(CFG.DUPS, DUP_COLS);
      res.dups.forEach(d => sh.appendRow([d.id1, d.name1, d.father1, d.id2, d.name2, d.father2, d.reason]));
    }
    return { ok: true, selfId: res.selfId, created: res.created, matched: res.matched, notes: res.notes };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== मुख्य मिलान लॉजिक ===================== */

function processSubmission_(members, data, ts) {
  const R = { ok: true, created: 0, matched: 0, notes: [], dups: [], selfId: '' };
  if (!data || !data.self) return { ok: false, error: 'मुख्य व्यक्ति की जानकारी नहीं मिली' };
  const self = person_(data.self, '');
  if (!self) return { ok: false, error: 'मुख्य व्यक्ति का नाम आवश्यक है' };

  const src = clean_(data.submitter && data.submitter.name) || self.name;
  const ctx = { members, idx: index_(members), ts, src, R };
  let selfId, fatherId, gfId;

  if (data.anchorId) {
    // दोबारा भरना: वृक्ष में पहले से मौजूद व्यक्ति (ID से) के परिवार में जोड़ना
    const a = ctx.idx.get(ctx.idx.canon(clean_(data.anchorId)));
    if (!a) return { ok: false, error: 'चुना गया सदस्य शीट में नहीं मिला। पेज रीफ्रेश करें।' };
    a.sources = addSource_(a.sources, src);
    a.updated = ts;
    selfId = a.id;
    fatherId = a.parentId ? ctx.idx.canon(a.parentId) : '';
    const f = fatherId ? ctx.idx.get(fatherId) : null;
    gfId = f && f.parentId ? ctx.idx.canon(f.parentId) : '';
  } else {
    // पूर्वज: पिता, दादा, परदादा ... (बीच में खाली होते ही रुकें)
    const anc = [];
    for (const a of (data.ancestors || [])) {
      const p = person_(a, 'पुरुष');
      if (!p) break;
      anc.push(p);
    }
    if (!anc.length) return { ok: false, error: 'पिता का नाम आवश्यक है' };

    // सबसे पुराने पूर्वज से शुरू करके स्वयं तक
    const chain = anc.slice().reverse().concat([self]);
    const ids = [];
    let parentId = '';
    chain.forEach((p, i) => {
      const next = chain[i + 1];
      const id = upsert_(ctx, p, parentId, next ? next.key : '');
      ids.push(id);
      parentId = id;
    });
    selfId = ids[ids.length - 1];
    fatherId = ids[ids.length - 2];
    gfId = ids.length >= 3 ? ids[ids.length - 3] : '';
  }
  R.selfId = selfId;

  (data.siblings || []).forEach(s => {
    const p = person_(s, '');
    if (!p || p.key === self.key) return;
    if (!fatherId) { R.notes.push('पिता का नाम न होने से "' + p.name + '" नहीं जोड़ा गया'); return; }
    upsert_(ctx, p, fatherId, '');
  });
  (data.fatherSiblings || []).forEach(s => {
    const p = person_(s, '');
    if (!p) return;
    if (!gfId) { R.notes.push('दादा का नाम न होने से "' + p.name + '" नहीं जोड़ा गया'); return; }
    upsert_(ctx, p, gfId, '');
  });
  (data.children || []).forEach(s => {
    const p = person_(s, '');
    if (p) upsert_(ctx, p, selfId, '');
  });
  return R;
}

/**
 * किसी व्यक्ति को खोजकर मिलाना, या नया बनाना।
 * मिलान का नियम: वही नाम-कुंजी + वही पिता = वही व्यक्ति।
 * जिसका पिता अभी दर्ज नहीं है, उसे बच्चों के नाम या संगत जानकारी से मिलाया जाता है।
 */
function upsert_(ctx, p, parentId, nextKey) {
  const { members, idx, R } = ctx;
  const live = members.filter(m => !m.mergeInto);
  const same = live.filter(m => m.key === p.key && compatible_(m, p));
  let hit = null, attach = false, poss = [];

  if (parentId) {
    hit = same.find(m => m.parentId && idx.canon(m.parentId) === parentId) || null;
    if (!hit) {
      const orphans = same.filter(m => !m.parentId && m.id !== parentId && !idx.isAncestor(m.id, parentId));
      const withChild = nextKey ? orphans.filter(m => idx.hasChildKey(m.id, nextKey)) : [];
      const pick = withChild.length ? withChild : orphans;
      if (pick.length === 1) { hit = pick[0]; attach = true; }
      else if (pick.length > 1) poss = poss.concat(pick);
      // उसी पिता के मिलते-जुलते नाम (जैसे मोहन/मोहान) — अपने आप नहीं मिलाते, जाँच के लिए
      if (!hit) live.forEach(m => {
        if (m.parentId && idx.canon(m.parentId) === parentId && m.key !== p.key && lev_(m.key, p.key) <= 1) poss.push(m);
      });
    }
  } else {
    const withChild = nextKey ? same.filter(m => idx.hasChildKey(m.id, nextKey)) : [];
    const pick = (withChild.length ? withChild : same).slice();
    if (pick.length) {
      pick.sort((a, b) => b.count - a.count);
      hit = pick[0];
      if (pick.length > 1) pick.slice(1).forEach(o => R.dups.push(dupRow_(idx, hit, o, 'एक जैसे नाम, पिता दर्ज नहीं')));
    }
  }

  if (hit) {
    fill_(hit, p, ctx);
    if (attach) {
      hit.parentId = parentId;
      const par = idx.get(parentId);
      hit.parentName = par ? par.name : '';
    }
    R.matched++;
    return hit.id;
  }

  const par = parentId ? idx.get(parentId) : null;
  const rec = {
    id: idx.nextId(), name: p.name, key: p.key, gender: p.gender, parentId: parentId || '',
    parentName: par ? par.name : '', spouse: p.spouse, birthYear: p.birthYear, village: p.village,
    status: p.status, mobile: p.mobile, notes: p.notes, mergeInto: '', count: 1,
    sources: ctx.src, created: ctx.ts, updated: ctx.ts
  };
  members.push(rec);
  R.created++;
  const seen = {};
  poss.forEach(o => {
    if (seen[o.id]) return; seen[o.id] = 1;
    R.dups.push(dupRow_(idx, rec, o, o.key === rec.key ? 'एक जैसा नाम, एक का पिता दर्ज नहीं' : 'एक ही पिता, मिलते-जुलते नाम'));
  });
  return rec.id;
}

function dupRow_(idx, a, b, reason) {
  const fa = a.parentId ? idx.get(idx.canon(a.parentId)) : null;
  const fb = b.parentId ? idx.get(idx.canon(b.parentId)) : null;
  return { id1: a.id, name1: a.name, father1: fa ? fa.name : '', id2: b.id, name2: b.name, father2: fb ? fb.name : '', reason };
}

/** दोनों रिकॉर्ड आपस में टकराते तो नहीं (लिंग, जन्म वर्ष, पति/पत्नी) */
function compatible_(m, p) {
  if (m.gender && p.gender && m.gender !== p.gender) return false;
  const y1 = parseInt(m.birthYear, 10), y2 = parseInt(p.birthYear, 10);
  if (y1 && y2 && Math.abs(y1 - y2) > 8) return false;
  if (m.spouse && p.spouse) {
    const k1 = nameKey(m.spouse), k2 = nameKey(p.spouse);
    if (k1 && k2 && k1 !== k2 && lev_(k1, k2) > 1) return false;
  }
  return true;
}

/** खाली खाने भरना, गिनती और स्रोत बढ़ाना */
function fill_(m, p, ctx) {
  ['gender', 'spouse', 'birthYear', 'village', 'mobile', 'notes'].forEach(f => {
    if (!m[f] && p[f]) m[f] = p[f];
  });
  if (p.status === 'दिवंगत') m.status = 'दिवंगत';
  else if (!m.status && p.status) m.status = p.status;
  m.count = (Number(m.count) || 1) + 1;
  m.sources = addSource_(m.sources, ctx.src);
  m.updated = ctx.ts;
}

function addSource_(list, name) {
  const arr = String(list || '').split(',').map(s => s.trim()).filter(Boolean);
  if (name && arr.indexOf(name) < 0) arr.push(name);
  return arr.join(', ');
}

function person_(a, defGender) {
  if (!a) return null;
  const name = clean_(a.name);
  if (!name) return null;
  const key = nameKey(name);
  if (!key) return null;
  let status = clean_(a.status);
  if (status === 'पता नहीं') status = '';
  return {
    name, key,
    gender: clean_(a.gender) || defGender || '',
    spouse: clean_(a.spouse),
    birthYear: year_(a.birthYear),
    village: clean_(a.village),
    status,
    mobile: clean_(a.mobile).replace(/[^0-9+]/g, '').slice(0, 15),
    notes: clean_(a.notes)
  };
}

function clean_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().replace(/^[=+\-@]+/, '').slice(0, 80);
}
function safe_(s) { return clean_(s); }
function year_(y) {
  const n = parseInt(String(y || '').replace(/[^0-9]/g, ''), 10);
  return (n >= 1750 && n <= 2100) ? String(n) : '';
}

/* ===================== नाम-कुंजी (हिंदी/अंग्रेज़ी मिलान) ===================== */

const DV_VOWELS = { 'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e' };
const DV_MATRAS = { 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e', 'ं': 'n', 'ँ': 'n', 'ः': 'h', '्': '' };
const DV_CONS = { 'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h', 'ळ': 'l' };
const DV_NUKTA = { 'ड': 'r', 'ढ': 'rh', 'फ': 'f', 'ज': 'j', 'क': 'k', 'ख': 'kh', 'ग': 'g' };

function translit_(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], nx = s[i + 1];
    if (DV_CONS[ch] !== undefined) {
      if (nx === '\u093C') { out += DV_NUKTA[ch] || DV_CONS[ch]; i++; }
      else out += DV_CONS[ch];
      const after = s[i + 1];
      if (!(after && DV_MATRAS[after] !== undefined)) out += 'a';
    } else if (DV_VOWELS[ch] !== undefined) out += DV_VOWELS[ch];
    else if (DV_MATRAS[ch] !== undefined) out += DV_MATRAS[ch];
    else if (ch === '\u093C') { /* अकेला नुक्ता */ }
    else out += ch;
  }
  return out;
}

/** "स्व. श्री रामलाल जी रावटे" और "Late Ramlal Rawate" दोनों → एक ही कुंजी */
function nameKey(s) {
  let t = String(s || '').normalize('NFD').toLowerCase().replace(/[.\-_,()'"/]/g, ' ');
  const drop = {};
  CFG.TITLES.concat(CFG.SURNAMES).forEach(w => { drop[w.normalize('NFD')] = 1; });
  t = t.split(/\s+/).filter(w => w && !drop[w]).join('');
  t = translit_(t);
  return t.replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f').replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/x/g, 'ks')
    .replace(/ksh/g, 'ks').replace(/chh/g, 'c').replace(/ch/g, 'c').replace(/sh/g, 's')
    .replace(/([kgcjtdpbr])h/g, '$1')
    .replace(/eo/g, 'ev').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/au|ou/g, 'o').replace(/ai/g, 'e')
    .replace(/a/g, '').replace(/(.)\1+/g, '$1');
}

function lev_(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/* ===================== सहायक: सदस्य-सूची इंडेक्स ===================== */

function index_(members) {
  const get = id => members.find(m => m.id === id) || null;
  const canon = id => {
    let cur = id, guard = 0;
    while (cur && guard++ < 50) {
      const m = get(cur);
      if (!m || !m.mergeInto || m.mergeInto === cur) return cur;
      cur = m.mergeInto;
    }
    return cur;
  };
  return {
    get, canon,
    hasChildKey: (id, key) => members.some(c => !c.mergeInto && c.parentId && canon(c.parentId) === id && c.key === key),
    isAncestor: (a, b) => { // क्या a, b का पूर्वज है (या स्वयं b)
      let cur = canon(b), guard = 0;
      while (cur && guard++ < 60) {
        if (cur === a) return true;
        const m = get(cur);
        cur = m && m.parentId ? canon(m.parentId) : '';
      }
      return false;
    },
    nextId: () => {
      let max = 0;
      members.forEach(m => { const n = parseInt(String(m.id).replace(/\D/g, ''), 10); if (n > max) max = n; });
      return 'R' + String(max + 1).padStart(4, '0');
    }
  };
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MM-yyyy HH:mm');
}

/* ===================== शीट पढ़ना/लिखना ===================== */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name, headers) {
  let sh = ss_().getSheetByName(name);
  if (!sh) {
    sh = ss_().insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f3e2c4');
  }
  return sh;
}

function loadMembers_() {
  const sh = sheet_(CFG.MEMBERS, COLS);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const v = sh.getRange(2, 1, last - 1, F.length).getDisplayValues();
  return v.filter(r => r[0]).map(r => {
    const o = {};
    F.forEach((f, j) => { o[f] = String(r[j] || '').trim(); });
    o.count = Number(o.count) || 1;
    if (!o.key) o.key = nameKey(o.name);
    return o;
  });
}

function saveMembers_(members) {
  const sh = sheet_(CFG.MEMBERS, COLS);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, F.length).clearContent();
  if (!members.length) return;
  const rng = sh.getRange(2, 1, members.length, F.length);
  rng.setNumberFormat('@');
  rng.setValues(members.map(m => F.map(f => (m[f] === undefined || m[f] === null) ? '' : String(m[f]))));
}

/* ===================== एडमिन मेनू ===================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('वंश वृक्ष')
    .addItem('संभावित डुप्लिकेट खोजें', 'menuScanDuplicates')
    .addItem('मर्ज लागू करें (मर्ज_ID वाले)', 'menuApplyMerges')
    .addItem('नाम बदलने के बाद मिलान-कुंजी दोबारा बनाएँ', 'menuRebuildKeys')
    .addItem('शीट तैयार करें (पहली बार)', 'setup')
    .addToUi();
}

function setup() {
  sheet_(CFG.MEMBERS, COLS);
  sheet_(CFG.LOG, LOG_COLS);
  sheet_(CFG.DUPS, DUP_COLS);
  SpreadsheetApp.getUi().alert('शीटें तैयार हैं: Members, Submissions, Possible_Duplicates');
}

function scanDuplicates_(members) {
  const idx = index_(members);
  const live = members.filter(m => !m.mergeInto);
  const out = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const pa = a.parentId ? idx.canon(a.parentId) : '', pb = b.parentId ? idx.canon(b.parentId) : '';
      if (pa && pa === pb && lev_(a.key, b.key) <= 1) out.push(dupRow_(idx, a, b, a.key === b.key ? 'एक ही पिता, एक ही नाम' : 'एक ही पिता, मिलते-जुलते नाम'));
      else if (a.key === b.key && (!pa || !pb) && compatible_(a, b) && !idx.isAncestor(a.id, b.id) && !idx.isAncestor(b.id, a.id))
        out.push(dupRow_(idx, a, b, (!pa && !pb) ? 'एक जैसा नाम, दोनों के पिता दर्ज नहीं' : 'एक जैसा नाम, एक का पिता दर्ज नहीं'));
    }
  }
  return out;
}

function menuScanDuplicates() {
  const members = loadMembers_();
  const rows = scanDuplicates_(members);
  const sh = sheet_(CFG.DUPS, DUP_COLS);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, DUP_COLS.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, DUP_COLS.length)
    .setValues(rows.map(d => [d.id1, d.name1, d.father1, d.id2, d.name2, d.father2, d.reason]));
  SpreadsheetApp.getUi().alert(rows.length
    ? rows.length + ' संभावित डुप्लिकेट जोड़े मिले। "Possible_Duplicates" शीट देखें। जो सचमुच एक ही व्यक्ति हों, Members शीट में डुप्लिकेट वाली पंक्ति के "मर्ज_ID" कॉलम में रखने वाले ID लिखें, फिर "मर्ज लागू करें" चलाएँ।'
    : 'कोई संभावित डुप्लिकेट नहीं मिला।');
}

/**
 * मर्ज: डुप्लिकेट की जानकारी मुख्य रिकॉर्ड में भरना, उसके बच्चों को मुख्य रिकॉर्ड के नीचे लाना,
 * और फिर एक ही नाम वाले बच्चों को भी अपने आप मिलाना।
 */
function applyMerges_(members) {
  const idx = index_(members);
  const msgs = [];
  let done = 0;
  const mergeOne = (dup, keepId) => {
    const keep = idx.get(idx.canon(keepId));
    if (!keep || keep.id === dup.id) { msgs.push(dup.id + ': मर्ज_ID गलत है'); dup.mergeInto = ''; return; }
    if (idx.isAncestor(dup.id, keep.id)) { msgs.push(dup.id + ': अपने ही वंशज में नहीं मिलाया जा सकता'); dup.mergeInto = ''; return; }
    dup.mergeInto = keep.id;
    ['gender', 'spouse', 'birthYear', 'village', 'mobile', 'notes', 'status'].forEach(f => { if (!keep[f] && dup[f]) keep[f] = dup[f]; });
    if (dup.status === 'दिवंगत') keep.status = 'दिवंगत';
    if (!keep.parentId && dup.parentId && !idx.isAncestor(keep.id, dup.parentId)) { keep.parentId = dup.parentId; keep.parentName = dup.parentName; }
    keep.count = (Number(keep.count) || 1) + (Number(dup.count) || 0);
    String(dup.sources || '').split(',').forEach(s => { keep.sources = addSource_(keep.sources, s.trim()); });
    dup.count = 0;
    done++;
    // बच्चों को नए पिता के नीचे लाएँ
    members.forEach(c => { if (!c.mergeInto && c.parentId && idx.canon(c.parentId) === keep.id) { c.parentId = keep.id; c.parentName = keep.name; } });
    // एक ही नाम वाले बच्चे अब एक ही पिता के नीचे हों तो उन्हें भी मिलाएँ
    const kids = members.filter(c => !c.mergeInto && c.parentId === keep.id);
    const byKey = {};
    kids.forEach(c => {
      if (byKey[c.key] && compatible_(byKey[c.key], c)) mergeOne(c, byKey[c.key].id);
      else if (!byKey[c.key]) byKey[c.key] = c;
    });
  };
  members.filter(m => m.mergeInto && Number(m.count) > 0).forEach(m => mergeOne(m, m.mergeInto));
  return { done, msgs };
}

function menuApplyMerges() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const members = loadMembers_();
    const r = applyMerges_(members);
    saveMembers_(members);
    SpreadsheetApp.getUi().alert(r.done + ' रिकॉर्ड मिलाए गए।' + (r.msgs.length ? '\n\nध्यान दें:\n' + r.msgs.join('\n') : ''));
  } finally { lock.releaseLock(); }
}

function menuRebuildKeys() {
  const members = loadMembers_();
  members.forEach(m => { m.key = nameKey(m.name); });
  saveMembers_(members);
  SpreadsheetApp.getUi().alert('मिलान-कुंजी दोबारा बन गई।');
}
