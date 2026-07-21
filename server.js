import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.APP_DATA_DIR || join(__dirname, 'data');
const DATA_FILE = join(DATA_DIR, 'opportunities.json');

try {
  const envRaw = readFileSync(join(__dirname, '.env'), 'utf-8');
  for (const line of envRaw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k && v && !process.env[k]) process.env[k] = v;
    }
  }
} catch { /* .env optional */ }

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';

function getFirecrawlKey() {
  return process.env.FIRECRAWL_API_KEY || '';
}

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

const DEFENCE_KEYWORDS = [
  'defence', 'defense', 'military', 'armed forces', 'weapon',
  'combat system', 'combat-system', 'mod ', 'ministry of defence',
  'royal navy', 'british army', 'royal air force', 'raf ',
  'navy ', 'army ', 'air force', 'warfare', 'munition',
  'bae systems', 'qinetiq', 'serco', 'atlas elektronik',
  'thales', 'lockheed', 'northrop', 'raytheon', 'boeing defence',
  'general dynamics', 'babcock international', 'ultra electronics',
  'chemring', 'troop', 'artillery', 'ordnance',
  'frigate', 'destroyer', 'submarine', 'warship', 'battleship',
  'armoured', 'tank ', 'combat', 'missile', 'bomb ',
];

function isDefenceRelated(opp) {
  const fields = [opp.title, opp.employer, opp.sector, opp.description, opp.location]
    .filter(Boolean).join(' ').toLowerCase();
  return DEFENCE_KEYWORDS.some(k => fields.includes(k.toLowerCase()));
}

function isDuplicate(opps, ref) {
  return opps.some(o => o.reference === ref);
}

const GOV_DISTANCES = [2, 5, 10, 15, 20, 30, 40];

function nearestGOVDistance(req) {
  const n = Number(req) || 25;
  return GOV_DISTANCES.filter(d => d <= n).pop() || 2;
}

const ROUTE_MECH = '9';
const ROUTE_DATA = '7';

function buildSearchURL(prefs) {
  const p = new URLSearchParams();
  p.set('location', 'BL3 2QZ');
  p.set('distance', String(nearestGOVDistance(prefs.distance)));
  p.set('sort', 'DistanceAsc');
  const levels = new Set();
  if (prefs.mechLevels && prefs.mechLevels.length) {
    prefs.mechLevels.forEach(l => levels.add(String(l)));
    p.append('routeIds', ROUTE_MECH);
  }
  if (prefs.dataLevels && prefs.dataLevels.length) {
    prefs.dataLevels.forEach(l => levels.add(String(l)));
    p.append('routeIds', ROUTE_DATA);
  }
  [...levels].sort().forEach(l => p.append('levelIds', l));
  return `https://www.findapprenticeship.service.gov.uk/apprenticeships?${p.toString()}`;
}

const DATA_ROLE_ACCEPT = [
  'data engineer', 'data engineering', 'data analyst', 'data analytics',
  'data technician', 'data tech', 'data scientist',
  'big data', 'data specialist', 'data professional',
].map(k => k.toLowerCase());
const DATA_ROLE_REJECT = [
  'software developer', 'software engineer', 'software dev',
  'web developer', 'app developer', 'application developer',
  'it support', 'it technician', 'it helpdesk', 'it service',
  'it infrastructure', 'it operations',
  'network engineer', 'network technician', 'network admin',
  'cyber security', 'cybersecurity', 'cyber analyst', 'security analyst',
  'penetration test', 'ethical hack',
  'devops', 'dev ops', 'cloud engineer', 'cloud support',
  'ux designer', 'ui designer', 'graphic designer',
  'digital marketer', 'social media',
].map(k => k.toLowerCase());

const MECH_ROLE_ACCEPT = [
  'engineer', 'engineering', 'technician', 'mechanic',
  'manufacturing', 'fabrication', 'machining', 'cnc',
  'welder', 'welding', 'fitter', 'fitter',
  'assembler', 'assembly', 'production oper',
  'maintenance', 'maintain',
  'automotive', 'vehicle', 'motor',
  'rail', 'railway', 'rolling stock',
  'utilit', 'power', 'energy', 'gas', 'water',
  'aviation', 'aircraft', 'aerospace', 'aeronautical',
  'civil', 'structural', 'mechanical engineer',
  'toolmaker', 'tool maker', 'moulder',
  'electrical', 'electronic', 'electromechanical',
].map(k => k.toLowerCase());
const MECH_ROLE_REJECT = [
  'software', 'it support', 'cyber', 'data engineer', 'data analyst', 'data technician', 'data scientist',
  'digital', 'web developer', 'it network', 'computer network', 'network engineer', 'network admin', 'network support', 'cloud',
  'chef', 'catering', 'hospitality',
  'care worker', 'nurse', 'healthcare', 'social care',
  'teacher', 'teaching assistant', 'early years',
  'accountant', 'finance', 'hr ', 'human resource',
  'marketing', 'sales', 'retail', 'customer service',
  'hairdress', 'barber', 'beauty',
  'security guard', 'cleaner', 'admin',
].map(k => k.toLowerCase());

function titleText(opp) {
  return (opp.title || '').toLowerCase();
}

function descText(opp) {
  return (opp.description || '').toLowerCase();
}

function isDataRole(opp) {
  const t = titleText(opp);
  const accepted = DATA_ROLE_ACCEPT.some(k => t.includes(k));
  if (!accepted) return false;
  const rejected = DATA_ROLE_REJECT.some(k => t.includes(k));
  return !rejected;
}

function isMechanicalRole(opp) {
  const t = titleText(opp);
  const d = descText(opp);
  const accepted = MECH_ROLE_ACCEPT.some(k => t.includes(k) || d.includes(k));
  if (!accepted) return false;
  const rejected = MECH_ROLE_REJECT.some(k => t.includes(k));
  return !rejected;
}

function classifyPathway(vacancy) {
  const isData = isDataRole(vacancy);
  const isMech = isMechanicalRole(vacancy);
  if (isData && isMech) return 'both';
  if (isData) return 'data';
  if (isMech) return 'mechanical';
  return null;
}

function activeSearchPathways(prefs) {
  const hasMech = prefs.mechLevels && prefs.mechLevels.length;
  const hasData = prefs.dataLevels && prefs.dataLevels.length;
  if (hasMech && !hasData) return 'mechanical';
  if (hasData && !hasMech) return 'data';
  return 'both';
}

function filterByCriteria(opps, prefs) {
  if (!prefs) return opps;
  const effDistance = nearestGOVDistance(prefs.distance || 25);
  const mechSet = new Set((prefs.mechLevels || []).map(String));
  const dataSet = new Set((prefs.dataLevels || []).map(String));
  const hasMech = mechSet.size > 0;
  const hasData = dataSet.size > 0;
  return opps.filter(o => {
    if (o.distance !== null && o.distance !== undefined && o.distance > effDistance) return false;
    if (o.level !== null && o.level !== undefined) {
      const lv = String(o.level);
      const pathway = o.pathway || '';
      if (pathway === 'mechanical') {
        if (hasMech && !mechSet.has(lv)) return false;
      } else if (pathway === 'data') {
        if (hasData && !dataSet.has(lv)) return false;
      } else {
        const union = new Set([...mechSet, ...dataSet]);
        if (union.size > 0 && !union.has(lv)) return false;
      }
    }
    return true;
  });
}

async function firecrawlScrape(url) {
  const key = getFirecrawlKey();
  if (!key) throw new Error('missing_key');
  const resp = await fetch(`${FIRECRAWL_BASE}/scrape`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
  });
  const data = await resp.json();
  if (!data.success) throw new Error(data.error || 'Firecrawl scrape failed');
  return { markdown: data.data.markdown || '', creditsUsed: data.data.creditsUsed };
}

function extractVacancyRefs(md) {
  const seen = new Set();
  for (const m of md.matchAll(/apprenticeship\/(VAC\d+)/g)) {
    if (!seen.has(m[1])) seen.add(m[1]);
  }
  return [...seen].slice(0, 5);
}

function parseVacancy(md) {
  const r = {};
  const h1 = md.match(/^# (.+)$/m);
  r.title = h1 ? h1[1].trim() : '';
  const vac = md.match(/VAC\d+/);
  r.reference = vac ? vac[0] : '';
  const lines = md.split('\n');
  const ti = lines.findIndex(l => l.startsWith('# '));
  r.employer = '';
  if (ti >= 0) {
    // Employer is the first non-empty line after the H1 title
    for (let j = ti + 1; j < lines.length; j++) {
      if (lines[j].trim()) { r.employer = lines[j].trim(); break; }
    }
  }
  // Location: next non-empty line after employer
  if (r.employer) {
    const ei = lines.findIndex((l, i) => i > ti && lines[i].trim() === r.employer);
    if (ei >= 0) {
      for (let j = ei + 1; j < lines.length; j++) {
        if (lines[j].trim()) { r.location = lines[j].trim(); break; }
      }
    }
  }
  r.location = r.location || '';
  const lv = md.match(/\(level (\d)\)/i);
  r.level = lv ? parseInt(lv[1]) : null;
  const wage = md.match(/£[\d,.]+( a year)?/);
  r.salary = wage ? wage[0] : '';
  const cls = md.match(/Closes (?:in \d+ days \()?(.+?)(?:\)|$)/m);
  r.deadlineRaw = cls ? cls[1].trim() : '';
  const dist = md.match(/Distance ([\d.]+) miles/);
  r.distance = dist ? parseFloat(dist[1]) : null;
  // Description: text after Distance line (mechanical direct-line pages)
  const dl = lines.findIndex(l => /^Distance/.test(l));
  if (dl >= 0 && dl + 1 < lines.length) {
    r.description = lines.slice(dl + 1).join(' ').trim();
  } else {
    // Fallback for GOV.UK pages without a Distance line: use the
    // "What you'll do at work" section, else the Summary section.
    let di = lines.findIndex(l => /what you'll do at work/i.test(l));
    if (di < 0) di = lines.findIndex(l => /^##\s+Summary/i.test(l));
    if (di >= 0) {
      const body = [];
      for (let j = di + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (/^#{1,3}\s/.test(lines[j])) break; // stop at next heading
        if (t) body.push(t);
      }
      r.description = body.join(' ').trim();
    } else {
      r.description = '';
    }
  }
  r.sector = '';

  // qualification: first non-empty line after '### Training course' heading
  const tcHeadingIdx = lines.findIndex(l => /^###\s+Training course/i.test(l));
  if (tcHeadingIdx >= 0) {
    for (let j = tcHeadingIdx + 1; j < lines.length; j++) {
      if (lines[j].trim()) { r.qualification = lines[j].trim(); break; }
    }
  } else {
    r.qualification = '';
  }

  // trainingProvider: first non-empty line after '### Training provider' heading
  const tpHeadingIdx = lines.findIndex(l => /^###\s+Training provider/i.test(l));
  if (tpHeadingIdx >= 0) {
    for (let j = tpHeadingIdx + 1; j < lines.length; j++) {
      if (lines[j].trim()) { r.trainingProvider = lines[j].trim(); break; }
    }
  } else {
    r.trainingProvider = '';
  }

  // startDate: first non-empty line after a 'Start date' label line
  const sdIdx = lines.findIndex(l => /^Start date\s*$/i.test(l.trim()));
  if (sdIdx >= 0) {
    for (let j = sdIdx + 1; j < lines.length; j++) {
      if (lines[j].trim()) { r.startDate = lines[j].trim(); break; }
    }
  } else {
    r.startDate = '';
  }

  // duration: first non-empty line after a 'Duration' label line
  const durIdx = lines.findIndex(l => /^Duration\s*$/i.test(l.trim()));
  if (durIdx >= 0) {
    for (let j = durIdx + 1; j < lines.length; j++) {
      if (lines[j].trim()) { r.duration = lines[j].trim(); break; }
    }
  } else {
    r.duration = '';
  }

  return r;
}

async function searchGOVUK(prefs) {
  if (!getFirecrawlKey()) throw new Error('missing_key');
  const url = buildSearchURL(prefs);
  const sr = await firecrawlScrape(url);
  const refs = extractVacancyRefs(sr.markdown);
  const results = [];
  for (const ref of refs) {
    const vu = `https://www.findapprenticeship.service.gov.uk/apprenticeship/${ref}`;
    const vp = await firecrawlScrape(vu);
    const p = parseVacancy(vp.markdown);
    p.reference = ref;
    p.url = vu;
    results.push(p);
  }
  return { results, effectiveDistance: nearestGOVDistance(prefs.distance), creditsUsed: sr.creditsUsed };
}

function serveStatic(pathname, res) {
  const safe = pathname.replace(/^\/+/, '') || 'index.html';
  return readFile(join(__dirname, 'public', safe))
    .then(data => {
      const ext = extname(join(__dirname, 'public', safe));
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
    })
    .catch(() => { res.writeHead(404); res.end('Not found'); });
}

async function loadOpps() {
  try {
    return JSON.parse(await readFile(DATA_FILE, 'utf-8'));
  } catch { return []; }
}

async function saveOpps(data) {
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function readBody(req) {
  return new Promise(resolve => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b));
  });
}

async function handleAPI(pathname, req, res) {
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  }
  if (pathname === '/api/opportunities') {
    const data = await loadOpps();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ count: data.length, opportunities: data }));
  }
  if (pathname === '/api/search' && req.method === 'POST') {
    const body = await readBody(req);
    let payload = {};
    try { payload = JSON.parse(body); } catch {}
    const existing = await loadOpps();

    const prefs = payload.preferences;
    if (prefs && (prefs.distance || prefs.mechLevels || prefs.dataLevels)) {
      try {
        const { results, effectiveDistance } = await searchGOVUK(prefs);
        if (!results.length) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            searched: true, found: 0, accepted: null, opportunities: [],
            message: `No vacancies found within ${effectiveDistance} miles of BL3 2QZ for the selected levels.`,
            effectiveDistance,
          }));
        }
        let accepted = null;
        const skipped = [];
        for (const r of results) {
          // Record parsing failures — don't silently discard
          const missingFields = [];
          if (!r.employer) missingFields.push('employer');
          if (!r.title || r.title === 'Unknown') missingFields.push('title');
          if (!r.reference) missingFields.push('reference');
          if (!r.level) missingFields.push('level');

          if (missingFields.length > 0) {
            skipped.push({ reference: r.reference || 'unknown', title: r.title || 'Unknown', reason: 'parsing_failed', missingFields });
            continue;
          }
          if (isDefenceRelated(r)) {
            skipped.push({ reference: r.reference, title: r.title, reason: 'defence' });
            continue;
          }
          if (r.reference && isDuplicate(existing, r.reference)) {
            skipped.push({ reference: r.reference, title: r.title, reason: 'duplicate' });
            continue;
          }
          // Classify pathway from the vacancy's own content
          const vacancyPathway = classifyPathway(r);
          if (!vacancyPathway) {
            skipped.push({ reference: r.reference, title: r.title, reason: 'not a relevant role' });
            continue;
          }
          // Cross-pathway level check
          const hasMech = prefs.mechLevels && prefs.mechLevels.length;
          const hasData = prefs.dataLevels && prefs.dataLevels.length;
          const mechLevels = (prefs.mechLevels || []).map(String);
          const dataLevels = (prefs.dataLevels || []).map(String);

          if (vacancyPathway === 'mechanical') {
            if (!hasMech) {
              skipped.push({ reference: r.reference, title: r.title, reason: 'no matching level' });
              continue;
            }
            if (r.level !== null && r.level !== undefined && !mechLevels.includes(String(r.level))) {
              skipped.push({ reference: r.reference, title: r.title, reason: 'no matching level' });
              continue;
            }
          } else if (vacancyPathway === 'data') {
            if (!hasData) {
              skipped.push({ reference: r.reference, title: r.title, reason: 'no matching level' });
              continue;
            }
            if (r.level !== null && r.level !== undefined && !dataLevels.includes(String(r.level))) {
              skipped.push({ reference: r.reference, title: r.title, reason: 'no matching level' });
              continue;
            }
          } else if (vacancyPathway === 'both') {
            let matched = false;
            if (hasMech && r.level !== null && mechLevels.includes(String(r.level))) matched = true;
            if (hasData && r.level !== null && dataLevels.includes(String(r.level))) matched = true;
            if (!matched && ((hasMech || hasData) && r.level !== null)) {
              skipped.push({ reference: r.reference, title: r.title, reason: 'no matching level' });
              continue;
            }
          }
          const threshold = parseInt(prefs.threshold) || 85;
          const opp = {
            reference: r.reference, title: r.title, employer: r.employer,
            url: r.url, location: r.location || 'Unknown', distance: r.distance,
            sector: r.sector || '', level: r.level, qualification: r.qualification || '',
            trainingProvider: r.trainingProvider || '', salary: r.salary || '',
            deadline: r.deadlineRaw || '',
            startDate: r.startDate || '', duration: r.duration || '',
            matchScore: 78, notificationThreshold: threshold,
            notificationStatus: 'No immediate email', defenceResult: 'Passed',
            eligibility: 'Eligibility needs confirmation.',
            strengths: ['Matches selected level and pathway.', 'Located within search distance.'],
            risks: ['Verify full eligibility.', 'Confirm commute is practical.'],
            status: 'review',
            pathway: vacancyPathway,
          };
          existing.push(opp);
          await saveOpps(existing);
          accepted = opp;
          break;
        }
        const filtered = filterByCriteria(existing, prefs);
        const seen = new Set();
        const deduped = filtered.filter(o => !seen.has(o.reference) && seen.add(o.reference));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          searched: true, found: results.length, accepted, opportunities: deduped,
          skipped, effectiveDistance, searchThreshold: threshold,
          message: accepted ? `Found and saved: ${accepted.title} at ${accepted.employer}.`
            : 'No suitable non-defence, non-duplicate vacancies found in the first 5 results.',
        }));
      } catch (err) {
        if (err.message === 'missing_key') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'firecrawl_unavailable', message: 'Search is not available.' }));
        }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'search_failed', message: 'Search could not be completed.' }));
      }
    }

    const candidate = payload.candidate;
    if (candidate) {
      if (candidate.reference && isDuplicate(existing, candidate.reference)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ accepted: false, reason: 'duplicate', message: 'Already stored.' }));
      }
      if (isDefenceRelated(candidate)) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ accepted: false, reason: 'defence', message: 'Defence-related excluded.' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ count: existing.length, opportunities: existing }));
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Provide preferences or candidate.' }));
  }
  res.writeHead(404);
  res.end('Not found');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) await handleAPI(url.pathname, req, res);
  else await serveStatic(url.pathname, res);
});

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) server.listen(PORT, () => console.log(`Apprenticeship AI Assistant running on http://localhost:${PORT}`));

export {
  server, loadOpps as loadOpportunities, isDefenceRelated, isDuplicate,
  searchGOVUK, firecrawlScrape, buildSearchURL, filterByCriteria,
  nearestGOVDistance, ROUTE_MECH, ROUTE_DATA,
  isDataRole, isMechanicalRole, classifyPathway, DATA_FILE,
  parseVacancy, extractVacancyRefs,
};
