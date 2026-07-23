import { createServer } from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createWorker } from 'tesseract.js';
import busboy from 'busboy';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

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

const GOV_DISTANCES = [2, 5, 10, 15, 20, 30, 40, 75];

function nearestGOVDistance(req) {
  const n = Number(req) || 25;
  return GOV_DISTANCES.filter(d => d <= n).pop() || 2;
}

const ROUTE_MECH = '9';
const ROUTE_DATA = '7';

const PROGRAMME_ROUTES = {
  // Engineering and manufacturing (Route 9)
  'mechanical engineering': '9',
  'automotive engineering': '9',
  'manufacturing engineering': '9',
  'welding and fabrication engineering': '9',
  'rail engineering': '9',
  'aerospace engineering': '9',
  'electrical engineering': '9',
  'electronics engineering': '9',
  'maintenance engineering': '9',
  'energy and utilities engineering': '9',
  'other engineering and technology': '9',
  'engineering and manufacturing': '9',

  // Construction and building (Route 5)
  'civil engineering': '5',
  'building services engineering': '5',
  'construction and building': '5',

  // Digital (Route 7)
  'data engineering': '7',
  'data technician': '7',
  'data analyst': '7',
  'software development': '7',
  'cyber security': '7',
  'network engineering': '7',
  'digital': '7',

  // Business and administration (Route 2)
  'business and administration': '2',

  // Legal, finance and accounting (Route 12)
  'accountancy and finance': '12',
  'legal, finance and accounting': '12',

  // Transport and logistics (Route 15)
  'supply chain and logistics': '15',
  'transport and logistics': '15',

  // Agriculture, environmental and animal care (Route 1)
  'environmental and sustainability': '1',
  'agriculture, environmental and animal care': '1',

  // Health and science (Route 11)
  'laboratory and scientific': '11',
  'health and science': '11',

  // Broad routes for backwards compatibility
  'care services': '3',
  'catering and hospitality': '4',
  'creative and design': '6',
  'education and early years': '8',
  'hair and beauty': '10',
  'protective services': '13',
  'sales and marketing': '14',
};

function buildSearchURL(prefs) {
  const p = new URLSearchParams();
  p.set('location', 'BL3 2QZ');
  p.set('distance', String(nearestGOVDistance(prefs.distance)));
  p.set('sort', 'DistanceAsc');
  const levels = new Set();
  const routeIds = new Set();

  if (prefs.programme) {
    const progKey = String(prefs.programme).toLowerCase().trim();
    if (PROGRAMME_ROUTES[progKey]) {
      routeIds.add(PROGRAMME_ROUTES[progKey]);
    }
  }

  if (prefs.mechLevels && prefs.mechLevels.length) {
    prefs.mechLevels.forEach(l => levels.add(String(l)));
    if (!prefs.programme) routeIds.add(ROUTE_MECH);
  }
  if (prefs.dataLevels && prefs.dataLevels.length) {
    prefs.dataLevels.forEach(l => levels.add(String(l)));
    if (!prefs.programme) routeIds.add(ROUTE_DATA);
  }
  if (prefs.levels && prefs.levels.length) {
    prefs.levels.forEach(l => levels.add(String(l)));
  }

  [...routeIds].forEach(id => p.append('routeIds', id));
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

function matchProgramme(vacancy, targetProgramme) {
  if (!targetProgramme || targetProgramme.trim() === '') return true;
  const progKey = String(targetProgramme).toLowerCase().trim();
  const title = (vacancy.title || '').toLowerCase();
  const sector = (vacancy.sector || '').toLowerCase();
  const text = `${title} ${sector} ${vacancy.qualification || ''} ${vacancy.description || ''}`.toLowerCase();

  if (vacancy.ambiguous || (!title && !sector)) return 'review';

  // Detailed Programme Matching Logic

  // 1. Automotive Engineering
  if (progKey.includes('automotive')) {
    const isAuto = text.includes('automotive') || text.includes('vehicle') || text.includes('motor') ||
                   text.includes('hgv') || text.includes('bus') || text.includes('coach') ||
                   text.includes('car ') || text.includes('auto ');
    if (isAuto) return true;
    const isOtherMech = text.includes('welding') || text.includes('welder') || text.includes('fabricat') ||
                        text.includes('manufacturing') || text.includes('rail') || text.includes('aerospace') ||
                        text.includes('civil') || text.includes('building');
    if (isOtherMech || text.includes('chef') || text.includes('hair') || text.includes('nurse')) return false;
    return 'review';
  }

  // 2. Welding and Fabrication Engineering
  if (progKey.includes('welding') || progKey.includes('fabrication')) {
    const isWeld = text.includes('weld') || text.includes('fabricat') || text.includes('metalwork') || text.includes('boilermaker');
    if (isWeld) return true;
    const isOther = text.includes('automotive') || text.includes('vehicle') || text.includes('rail') ||
                    text.includes('aerospace') || text.includes('civil') || text.includes('chef') || text.includes('hair');
    if (isOther) return false;
    return 'review';
  }

  // 3. Manufacturing Engineering
  if (progKey.includes('manufacturing')) {
    const isMfg = text.includes('manufacturing') || text.includes('production') || text.includes('process engineer') || text.includes('cnc') || text.includes('machining');
    if (isMfg) return true;
    if (text.includes('chef') || text.includes('hair') || text.includes('nurse') || text.includes('car mechanic')) return false;
    return 'review';
  }

  // 4. Mechanical Engineering
  if (progKey.includes('mechanical engineering') || progKey === 'mechanical') {
    const isMech = text.includes('mechanical') || isMechanicalRole(vacancy);
    if (isMech) return true;
    if (text.includes('software') || text.includes('hair') || text.includes('chef') || text.includes('nurse')) return false;
    return 'review';
  }

  // 5. Maintenance Engineering
  if (progKey.includes('maintenance engineering')) {
    const isMaint = text.includes('maintenance') || text.includes('maintain');
    if (isMaint) return true;
    if (text.includes('chef') || text.includes('hair') || text.includes('software')) return false;
    return 'review';
  }

  // 6. Rail Engineering
  if (progKey.includes('rail')) {
    const isRail = text.includes('rail') || text.includes('railway') || text.includes('rolling stock') || text.includes('track') || text.includes('train');
    if (isRail) return true;
    if (text.includes('automotive') || text.includes('car') || text.includes('aircraft') || text.includes('hair')) return false;
    return 'review';
  }

  // 7. Aerospace Engineering
  if (progKey.includes('aerospace')) {
    const isAero = text.includes('aerospace') || text.includes('aircraft') || text.includes('aviation') || text.includes('aeronautical') || text.includes('avionics');
    if (isAero) return true;
    if (text.includes('automotive') || text.includes('car') || text.includes('railway') || text.includes('hair')) return false;
    return 'review';
  }

  // 8. Electrical Engineering
  if (progKey.includes('electrical engineering')) {
    const isElec = text.includes('electrical') || text.includes('electrician') || text.includes('power distribution');
    if (isElec) return true;
    if (text.includes('chef') || text.includes('hair') || text.includes('welder')) return false;
    return 'review';
  }

  // 9. Electronics Engineering
  if (progKey.includes('electronics engineering')) {
    const isTron = text.includes('electronic') || text.includes('pcb') || text.includes('embedded');
    if (isTron) return true;
    if (text.includes('civil') || text.includes('bricklayer') || text.includes('chef')) return false;
    return 'review';
  }

  // 10. Civil Engineering
  if (progKey.includes('civil engineering')) {
    const isCivil = text.includes('civil') || text.includes('highways') || text.includes('structural') || text.includes('infrastructure') || text.includes('groundworks');
    if (isCivil) return true;
    if (text.includes('automotive') || text.includes('welder') || text.includes('data analyst') || text.includes('hair')) return false;
    return 'review';
  }

  // 11. Building Services Engineering
  if (progKey.includes('building services')) {
    const isBldg = text.includes('building services') || text.includes('hvac') || text.includes('heating') || text.includes('ventilation') || text.includes('plumbing');
    if (isBldg) return true;
    if (text.includes('automotive') || text.includes('welder') || text.includes('data analyst')) return false;
    return 'review';
  }

  // 12. Energy and Utilities Engineering
  if (progKey.includes('energy') || progKey.includes('utilities')) {
    const isUtil = text.includes('utilit') || text.includes('power') || text.includes('energy') || text.includes('gas') || text.includes('water') || text.includes('grid');
    if (isUtil) return true;
    if (text.includes('hair') || text.includes('chef') || text.includes('software')) return false;
    return 'review';
  }

  // 13. Data Engineering
  if (progKey.includes('data engineering')) {
    const isDE = text.includes('data engineer') || text.includes('data engineering') || text.includes('big data') || text.includes('pipeline') || text.includes('etl');
    if (isDE) return true;
    if (text.includes('bricklayer') || text.includes('welder') || text.includes('hair')) return false;
    return 'review';
  }

  // 14. Data Technician
  if (progKey.includes('data technician')) {
    const isDT = text.includes('data technician') || text.includes('data tech');
    if (isDT) return true;
    if (text.includes('bricklayer') || text.includes('welder') || text.includes('hair')) return false;
    return 'review';
  }

  // 15. Data Analyst
  if (progKey.includes('data analyst')) {
    const isDA = text.includes('data analyst') || text.includes('data analytics') || text.includes('bi analyst') || text.includes('reporting');
    if (isDA) return true;
    if (text.includes('bricklayer') || text.includes('welder') || text.includes('software developer')) return false;
    return 'review';
  }

  // 16. Software Development
  if (progKey.includes('software')) {
    const isSoft = text.includes('software') || text.includes('developer') || text.includes('programmer') || text.includes('coding');
    if (isSoft) return true;
    if (text.includes('bricklayer') || text.includes('welder') || text.includes('mechanic')) return false;
    return 'review';
  }

  // 17. Cyber Security
  if (progKey.includes('cyber')) {
    const isCyber = text.includes('cyber') || text.includes('security') || text.includes('soc analyst');
    if (isCyber) return true;
    if (text.includes('bricklayer') || text.includes('welder')) return false;
    return 'review';
  }

  // 18. Network Engineering
  if (progKey.includes('network')) {
    const isNet = text.includes('network') || text.includes('cisco') || text.includes('infrastructure');
    if (isNet) return true;
    if (text.includes('bricklayer') || text.includes('welder')) return false;
    return 'review';
  }

  // 19. Business and Administration
  if (progKey.includes('business')) {
    if (text.includes('business') || text.includes('admin') || text.includes('office') || text.includes('management')) return true;
    if (text.includes('bricklayer') || text.includes('welder')) return false;
    return 'review';
  }

  // 20. Accountancy and Finance
  if (progKey.includes('accountancy') || progKey.includes('finance')) {
    if (text.includes('account') || text.includes('finance') || text.includes('tax') || text.includes('audit') || text.includes('payroll')) return true;
    if (text.includes('bricklayer') || text.includes('chef') || text.includes('welder')) return false;
    return 'review';
  }

  // 21. Supply Chain and Logistics
  if (progKey.includes('supply chain') || progKey.includes('logistics')) {
    if (text.includes('supply chain') || text.includes('logistics') || text.includes('transport') || text.includes('warehouse') || text.includes('freight')) return true;
    if (text.includes('hair') || text.includes('nurse')) return false;
    return 'review';
  }

  // 22. Environmental and Sustainability
  if (progKey.includes('environmental') || progKey.includes('sustainability')) {
    if (text.includes('environment') || text.includes('sustainab') || text.includes('green') || text.includes('eco') || text.includes('waste')) return true;
    if (text.includes('hair') || text.includes('chef')) return false;
    return 'review';
  }

  // 23. Laboratory and Scientific
  if (progKey.includes('laboratory') || progKey.includes('scientific')) {
    if (text.includes('lab') || text.includes('scientific') || text.includes('science') || text.includes('chemistry') || text.includes('bio')) return true;
    if (text.includes('bricklayer') || text.includes('welder') || text.includes('mechanic')) return false;
    return 'review';
  }

  // 24. Other Engineering and Technology & broad fallbacks
  if (progKey.includes('construction') || progKey.includes('building')) {
    if (text.includes('construction') || text.includes('building') || text.includes('brick') || text.includes('carpenter') || text.includes('plumb') || text.includes('site') || text.includes('survey')) return true;
    if (text.includes('hair') || text.includes('beauty') || text.includes('chef') || text.includes('nurse') || text.includes('data analyst')) return false;
    return 'review';
  }

  if (progKey.includes('health') || progKey.includes('science')) {
    if (text.includes('health') || text.includes('science') || text.includes('nurse') || text.includes('lab') || text.includes('pharm') || text.includes('clinical') || text.includes('care')) return true;
    if (text.includes('construction') || text.includes('brick') || text.includes('welder') || text.includes('mechanic')) return false;
    return 'review';
  }

  if (progKey.includes('engineering')) {
    if (isMechanicalRole(vacancy) || text.includes('engineering') || text.includes('technician')) return true;
    if (text.includes('chef') || text.includes('hair')) return false;
    return 'review';
  }

  return true;
}

function matchLevel(vacancy, targetLevels) {
  if (!targetLevels || !targetLevels.length) return true;
  if (vacancy.level === null || vacancy.level === undefined) return true;
  const levelsStr = targetLevels.map(String);
  return levelsStr.includes(String(vacancy.level));
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
  const threshold = prefs.threshold !== undefined && prefs.threshold !== '' ? Number(prefs.threshold) : 85;
  const mechSet = new Set((prefs.mechLevels || []).map(String));
  const dataSet = new Set((prefs.dataLevels || []).map(String));
  const unifiedSet = new Set((prefs.levels || []).map(String));
  const hasMech = mechSet.size > 0;
  const hasData = dataSet.size > 0;
  const hasUnified = unifiedSet.size > 0;

  return opps.filter(o => {
    if (threshold > 0 && o.matchScore !== undefined && o.matchScore < threshold) return false;
    if (o.distance !== null && o.distance !== undefined && o.distance > effDistance) return false;
    if (prefs.programme && !matchProgramme(o, prefs.programme)) return false;
    if (hasUnified && !matchLevel(o, prefs.levels)) return false;
    if (o.level !== null && o.level !== undefined) {
      const lv = String(o.level);
      const pathway = o.pathway || '';
      if (pathway === 'mechanical') {
        if (hasMech && !mechSet.has(lv)) return false;
      } else if (pathway === 'data') {
        if (hasData && !dataSet.has(lv)) return false;
      } else if (pathway !== 'programme') {
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

export function parseExtractedFields(rawText, originalFilename) {
  const cleanText = (rawText || '').replace(/\r\n/g, '\n').trim();
  const lines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);

  let title = '';
  const titleMatch = cleanText.match(/(?:Title|Role|Position|Vacancy Title)\s*[:\-]\s*(.+)/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  } else if (lines.length > 0) {
    title = lines.find(l => l.length >= 5 && l.length <= 100) || lines[0] || 'Unknown Vacancy';
  }

  let employer = '';
  const empMatch = cleanText.match(/(?:Employer|Company|Organization|Organisation)\s*[:\-]\s*(.+)/i);
  if (empMatch) {
    employer = empMatch[1].trim();
  } else {
    const titleIdx = lines.indexOf(title);
    if (titleIdx >= 0 && titleIdx + 1 < lines.length) {
      employer = lines[titleIdx + 1];
    }
  }

  let location = '';
  const locMatch = cleanText.match(/(?:Location|Address|City)\s*[:\-]\s*(.+)/i) || cleanText.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
  if (locMatch) {
    location = locMatch[1] ? locMatch[1].trim() : locMatch[0].trim();
  }

  let salary = '';
  const salMatch = cleanText.match(/(?:Salary|Pay|Wage|Compensation)\s*[:\-]\s*(.+)/i) || cleanText.match(/£[\d,.]+(?:\s*(?:a|per)\s*(?:year|annum|hr|hour))?/i);
  if (salMatch) {
    salary = salMatch[1] ? salMatch[1].trim() : salMatch[0].trim();
  }

  let deadline = '';
  const deadMatch = cleanText.match(/(?:Deadline|Closing Date|Apply By)\s*[:\-]\s*(.+)/i) || cleanText.match(/\b\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4}\b/);
  if (deadMatch) {
    deadline = deadMatch[1] ? deadMatch[1].trim() : deadMatch[0].trim();
  }

  let level = null;
  const levMatch = cleanText.match(/(?:Level|Apprenticeship Level)\s*[:\-]?\s*([2-7])/i) || cleanText.match(/Level\s*([2-7])/i);
  if (levMatch) {
    level = parseInt(levMatch[1], 10);
  }

  let qualification = '';
  const qualMatch = cleanText.match(/(?:Qualification|Course|Diploma|Degree)\s*[:\-]\s*(.+)/i);
  if (qualMatch) {
    qualification = qualMatch[1].trim();
  }

  let trainingProvider = '';
  const provMatch = cleanText.match(/(?:Training Provider|Provider|College)\s*[:\-]\s*(.+)/i);
  if (provMatch) {
    trainingProvider = provMatch[1].trim();
  }

  let requirements = '';
  const reqMatch = cleanText.match(/(?:Candidate Requirements|Requirements|Entry Requirements|Qualifications Needed)\s*[:\-]?\s*([\s\S]+?)(?=\n\n|\n[A-Z][a-z]+:|$)/i);
  if (reqMatch) {
    requirements = reqMatch[1].trim();
  }

  const sourceFilename = basename((originalFilename || 'uploaded_document')).replace(/[^a-zA-Z0-9_.-]/g, '_');

  return {
    title: title || 'Apprentice Role',
    employer: employer || 'Unknown Employer',
    location: location || '',
    salary: salary || '',
    deadline: deadline || '',
    level: level || null,
    qualification: qualification || '',
    trainingProvider: trainingProvider || '',
    description: cleanText,
    requirements: requirements || '',
    sourceFilename,
  };
}

export async function extractDocumentText(buffer, mimeType, originalFilename) {
  let rawText = '';
  const cleanMime = (mimeType || '').toLowerCase();
  const cleanName = (originalFilename || '').toLowerCase();

  if (cleanMime === 'application/pdf' || cleanName.endsWith('.pdf')) {
    try {
      const data = await pdfParse(buffer);
      rawText = data.text || '';
    } catch {
      rawText = '';
    }
    if (rawText.trim().length < 20) {
      let worker = null;
      try {
        worker = await createWorker('eng', 1, { errorHandler: () => {} });
        const ret = await worker.recognize(buffer);
        rawText = ret.data.text || '';
      } catch {
        rawText = '';
      } finally {
        if (worker) {
          try { await worker.terminate(); } catch {}
        }
      }
    }
  } else if (['image/png', 'image/jpeg', 'image/jpg'].includes(cleanMime) || /\.(png|jpe?g)$/i.test(cleanName)) {
    let worker = null;
    try {
      worker = await createWorker('eng', 1, { errorHandler: () => {} });
      const ret = await worker.recognize(buffer);
      rawText = ret.data.text || '';
    } catch {
      rawText = '';
    } finally {
      if (worker) {
        try { await worker.terminate(); } catch {}
      }
    }
  }

  return parseExtractedFields(rawText, originalFilename);
}

function validateMagicBytes(buffer, ext, mimeType) {
  const cleanExt = (ext || '').toLowerCase().replace('.', '');
  const cleanMime = (mimeType || '').toLowerCase();

  const allowedExts = ['pdf', 'png', 'jpg', 'jpeg'];
  const allowedMimes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];

  if (!allowedExts.includes(cleanExt) && !allowedMimes.includes(cleanMime)) {
    return false;
  }

  if (cleanExt === 'pdf' || cleanMime === 'application/pdf') {
    return buffer.length >= 4 && buffer.subarray(0, 4).toString('utf-8') === '%PDF';
  }

  if (cleanExt === 'png' || cleanMime === 'image/png') {
    return buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
  }

  if (['jpg', 'jpeg'].includes(cleanExt) || ['image/jpeg', 'image/jpg'].includes(cleanMime)) {
    return buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  }

  return false;
}

function parseUploadRequest(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return reject({ status: 400, error: 'invalid_format', message: 'Expected multipart/form-data request.' });
    }

    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    } catch {
      return reject({ status: 400, error: 'invalid_format', message: 'Failed to initialize upload parser.' });
    }

    let fileFound = false;
    let fileTooLarge = false;
    const chunks = [];
    let fileMeta = {};

    bb.on('file', (fieldname, file, info) => {
      fileFound = true;
      fileMeta = info;

      file.on('data', (data) => {
        chunks.push(data);
      });

      file.on('limit', () => {
        fileTooLarge = true;
      });
    });

    bb.on('finish', () => {
      if (!fileFound) {
        return reject({ status: 400, error: 'missing_file', message: 'No file uploaded.' });
      }
      if (fileTooLarge) {
        return reject({ status: 413, error: 'file_too_large', message: 'File size exceeds 5 MB limit.' });
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 5 * 1024 * 1024) {
        return reject({ status: 413, error: 'file_too_large', message: 'File size exceeds 5 MB limit.' });
      }
      resolve({ buffer, filename: fileMeta.filename, mimeType: fileMeta.mimeType });
    });

    bb.on('error', () => {
      reject({ status: 500, error: 'upload_error', message: 'Failed to parse upload.' });
    });

    req.pipe(bb);
  });
}

async function handleExtractDocument(req, res) {
  let tempFilePath = null;
  try {
    const { buffer, filename, mimeType } = await parseUploadRequest(req);
    const safeFilename = basename(filename || 'uploaded_file').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const ext = extname(safeFilename) || (mimeType === 'application/pdf' ? '.pdf' : '.png');

    if (!validateMagicBytes(buffer, ext, mimeType)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_format', message: 'Unsupported file format or MIME type mismatch.' }));
    }

    tempFilePath = join(tmpdir(), `upload_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    await writeFile(tempFilePath, buffer);

    const extractedData = await extractDocumentText(buffer, mimeType, safeFilename);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ searched: false, extracted: extractedData }));

  } catch (err) {
    if (err && err.status) {
      res.writeHead(err.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.error, message: err.message }));
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'extraction_failed', message: 'Failed to extract text from document.' }));
  } finally {
    if (tempFilePath) {
      try { await unlink(tempFilePath); } catch {}
    }
  }
}

async function handleAssessManual(req, res) {
  try {
    const body = await readBody(req);
    let payload = {};
    try { payload = JSON.parse(body); } catch {}

    const vacancy = payload.vacancy || {};
    const prefs = payload.preferences || {};

    const title = (vacancy.title || '').trim();
    const employer = (vacancy.employer || '').trim();
    const levelRaw = vacancy.level != null ? String(vacancy.level).trim() : '';
    const level = levelRaw !== '' ? Number(levelRaw) : null;

    if (!title || !employer || level == null || isNaN(level)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing_fields', message: 'Vacancy title, employer, and apprenticeship level are required.' }));
    }

    const vObj = {
      title,
      employer,
      location: vacancy.location || '',
      salary: vacancy.salary || '',
      deadline: vacancy.deadline || '',
      level,
      qualification: vacancy.qualification || '',
      trainingProvider: vacancy.trainingProvider || '',
      description: vacancy.description || '',
      requirements: vacancy.requirements || '',
      sourceFilename: vacancy.sourceFilename || '',
    };

    if (isDefenceRelated(vObj)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ accepted: false, reason: 'defence', message: 'Defence-related opportunity excluded.' }));
    }

    if (prefs.programme) {
      const pMatch = matchProgramme(vObj, prefs.programme);
      if (pMatch === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ accepted: false, reason: 'programme_mismatch', message: `Opportunity does not match selected programme (${prefs.programme}).` }));
      }
    }

    const targetLevels = (prefs.levels && prefs.levels.length) ? prefs.levels : [...(prefs.mechLevels || []), ...(prefs.dataLevels || [])];
    if (targetLevels.length > 0) {
      const lMatch = matchLevel(vObj, targetLevels);
      if (!lMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ accepted: false, reason: 'level_mismatch', message: `Apprenticeship level ${level} does not match selected level(s).` }));
      }
    }

    let matchScore = vacancy.matchScore != null && vacancy.matchScore !== '' ? Number(vacancy.matchScore) : 80;
    if (vacancy.matchScore == null || vacancy.matchScore === '') {
      if (vObj.level) matchScore += 5;
      if (vObj.qualification) matchScore += 5;
      if (vObj.requirements) matchScore += 5;
      if (matchScore > 95) matchScore = 95;
    }

    const threshold = prefs.threshold !== undefined && prefs.threshold !== '' ? Number(prefs.threshold) : 85;
    if (threshold > 0 && matchScore < threshold) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        accepted: false,
        reason: 'below_threshold',
        message: `Match score (${matchScore}%) is below selected threshold (${threshold}%).`,
        searchThreshold: threshold,
        matchScore
      }));
    }

    const eligibility = (vObj.requirements && vObj.requirements.trim())
      ? 'Fully eligible based on provided details.'
      : 'Eligibility needs confirmation';

    const programmeMatchStatus = prefs.programme && matchProgramme(vObj, prefs.programme) === 'review' ? 'review' : 'confirmed';

    const opportunity = {
      reference: `MANUAL_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: vObj.title,
      employer: vObj.employer,
      location: vObj.location,
      salary: vObj.salary,
      deadline: vObj.deadline,
      level: vObj.level,
      qualification: vObj.qualification || 'Not specified',
      trainingProvider: vObj.trainingProvider || 'Not specified',
      description: vObj.description,
      requirements: vObj.requirements,
      sourceFilename: vObj.sourceFilename,
      matchScore,
      notificationThreshold: threshold,
      programmeMatch: programmeMatchStatus,
      eligibility,
      strengths: [
        `Role aligns with ${prefs.programme || 'selected preferences'}`,
        `Level ${vObj.level} apprenticeship`
      ],
      risks: vObj.requirements ? [] : ['Candidate entry requirements missing or unconfirmed']
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      accepted: true,
      opportunity,
      searchThreshold: threshold
    }));
  } catch (error) {
    console.error('[manual-assessment-error]', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    return res.end(JSON.stringify({
      error: 'manual_assessment_failed',
      message: 'Could not complete manual assessment.'
    }));
  }
}

async function handleAPI(pathname, req, res) {
  if (pathname === '/api/extract-document' && req.method === 'POST') {
    return handleExtractDocument(req, res);
  }
  if (pathname === '/api/assess-manual' && req.method === 'POST') {
    return handleAssessManual(req, res);
  }
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
    if (prefs && prefs.programme && (!prefs.levels || !prefs.levels.length) && (!prefs.mechLevels || !prefs.mechLevels.length) && (!prefs.dataLevels || !prefs.dataLevels.length)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing_levels', message: 'Select at least one apprenticeship level.' }));
    }

    if (prefs && (prefs.distance || prefs.programme || (prefs.levels && prefs.levels.length) || (prefs.mechLevels && prefs.mechLevels.length) || (prefs.dataLevels && prefs.dataLevels.length))) {
      try {
        const threshold = prefs.threshold !== undefined && prefs.threshold !== '' ? Number(prefs.threshold) : 85;
        const { results, effectiveDistance } = await searchGOVUK(prefs);
        if (!results.length) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            searched: true, found: 0, accepted: null, opportunities: [],
            message: `No vacancies found within ${effectiveDistance} miles of BL3 2QZ for the selected levels.`,
            effectiveDistance, searchThreshold: threshold,
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

          let vacancyPathway = null;
          let programmeMatchStatus = 'confirmed';
          if (prefs.programme) {
            const matchRes = matchProgramme(r, prefs.programme);
            if (matchRes === false) {
              skipped.push({ reference: r.reference, title: r.title, reason: 'not a relevant role' });
              continue;
            }
            if (matchRes === 'review') {
              programmeMatchStatus = 'review';
            }
            const targetLevels = (prefs.levels && prefs.levels.length) ? prefs.levels : [...(prefs.mechLevels || []), ...(prefs.dataLevels || [])];
            if (!matchLevel(r, targetLevels)) {
              skipped.push({ reference: r.reference, title: r.title, reason: 'no matching level' });
              continue;
            }
            vacancyPathway = classifyPathway(r) || 'programme';
          } else {
            // Classify pathway from the vacancy's own content (legacy)
            vacancyPathway = classifyPathway(r);
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
          }

          const eligibilityText = programmeMatchStatus === 'confirmed'
            ? 'Eligibility needs confirmation.'
            : 'Programme relevance needs confirmation.';

          const opp = {
            reference: r.reference, title: r.title, employer: r.employer,
            url: r.url, location: r.location || 'Unknown', distance: r.distance,
            sector: r.sector || '', level: r.level, qualification: r.qualification || '',
            trainingProvider: r.trainingProvider || '', salary: r.salary || '',
            deadline: r.deadlineRaw || '',
            startDate: r.startDate || '', duration: r.duration || '',
            matchScore: 78, notificationThreshold: threshold,
            notificationStatus: 'No immediate email', defenceResult: 'Passed',
            eligibility: eligibilityText,
            programmeMatch: programmeMatchStatus,
            eligibilityNote: eligibilityText,
            strengths: ['Matches selected level and pathway.', 'Located within search distance.'],
            risks: ['Verify full eligibility.', 'Confirm commute is practical.'],
            status: 'review',
            pathway: vacancyPathway,
          };

          if (threshold > 0 && opp.matchScore < threshold) {
            skipped.push({ reference: r.reference, title: r.title, reason: 'below suitability threshold', matchScore: opp.matchScore, threshold });
            continue;
          }

          existing.push(opp);
          await saveOpps(existing);
          accepted = opp;
          break;
        }
        const filtered = filterByCriteria(existing, prefs);
        const seen = new Set();
        const deduped = filtered.filter(o => !seen.has(o.reference) && seen.add(o.reference));
        res.writeHead(200, { 'Content-Type': 'application/json' });

        let message = '';
        if (accepted && (threshold === 0 || accepted.matchScore >= threshold)) {
          message = `Found and saved: ${accepted.title} at ${accepted.employer}.`;
        } else if (skipped.some(s => s.reason === 'below suitability threshold')) {
          message = `No suitable non-defence, non-duplicate vacancies found meeting the selected ${threshold}% threshold.`;
        } else {
          message = 'No suitable non-defence, non-duplicate vacancies found in the first 5 results.';
        }

        return res.end(JSON.stringify({
          searched: true, found: results.length, accepted: (accepted && (threshold === 0 || accepted.matchScore >= threshold)) ? accepted : null, opportunities: deduped,
          skipped, effectiveDistance, searchThreshold: threshold,
          message,
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
  nearestGOVDistance, ROUTE_MECH, ROUTE_DATA, PROGRAMME_ROUTES,
  matchProgramme, matchLevel,
  isDataRole, isMechanicalRole, classifyPathway, DATA_FILE,
  parseVacancy, extractVacancyRefs,
};
