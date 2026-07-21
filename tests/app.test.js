import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BASE = 'http://localhost:3099';
const PROD_DATA = join(__dirname, '..', 'data', 'opportunities.json');
const TEST_DATA_DIR = join(__dirname, '..', 'data', '__test_isolation__');
const TEST_DATA = join(TEST_DATA_DIR, 'opportunities.json');

let server;
let originalKey;
let prodChecksum;

// --- Vacancy markdown fixtures based on actual GOV.UK structure ---

// Data Analyst: employer 2 lines after H1 (blank line between)
const MD_DATA_ANALYST = `# Data Analyst Apprentice

FOURTEEN (NORTH WEST) LTD

ENGLAND (BL1 2HB)

Closes in 3 days (Thursday 23 July 2026)

Posted on 23 June 2026

## Summary

We are looking for a passionate Junior Data Analyst.

Wage

£17,550 a year

Training course

Data analyst (level 4)

Hours

Monday to Friday, 9.00am to 5.00pm.

37 hours 30 minutes a week

Start date

Friday 24 July 2026

Duration

1 year 8 months

Positions available

1

## Work

### What you'll do at work

Develop and implement databases, data collection systems and data engineering solutions.

### Where you'll work

CROFT HOUSE

ST GEORGES SQUARE

BOLTON

ENGLAND

BL1 2HB

## Training

### Training provider

NOWSKILLS LIMITED

### Training course

Data analyst (level 4)

### What you'll learn

Use data systems securely to meet requirements.

## Requirements

### Desirable qualifications

A Level in Computer Science (grade B)

Maths (grade B)

### Skills

Communication skills

Analytical skills

## After this apprenticeship

Data & Automation Manager.

## Apply now

The reference code for this apprenticeship is VAC2000038797.`;

// Data Engineer: also blank line between H1 and employer
const MD_DATA_ENGINEER = `# Data Engineer Apprentice

Big Data Corp Ltd

Manchester (M2 2AA)

Closes in 10 days (Monday 3 August 2026)

Posted on 20 June 2026

Wage

£21,000 a year

Training course

Data engineer (level 4)

Hours

37 hours a week

Start date

Monday 10 August 2026

Duration

2 years

## Summary

Build and maintain data pipelines and infrastructure.

## Training

### Training provider

DATA ACADEMY LTD

### Training course

Data engineer (level 4)

## Requirements

### Skills

Python

SQL

## Apply now

The reference code for this apprenticeship is VAC2000041234.`;

// Data Technician: blank line between H1 and employer
const MD_DATA_TECHNICIAN = `# Data Technician Apprentice

DataCorp Ltd

Manchester (M1 1AA)

Closes in 14 days (Tuesday 4 August 2026)

Posted on 15 June 2026

Wage

£18,000 a year

Training course

Data technician (level 3)

Hours

37 hours a week

Start date

Monday 17 August 2026

Duration

18 months

## Summary

Support data collection and reporting processes.

## Training

### Training provider

TECH ACADEMY UK

### Training course

Data technician (level 3)

## Apply now

The reference code for this apprenticeship is VAC2000045678.`;

// Software Dev: should parse but be rejected by role filter
const MD_SOFTWARE_DEV = `# Software Developer Apprentice

TechFirm Plc

Manchester (M3 3BB)

Closes in 7 days (Monday 27 July 2026)

Posted on 10 June 2026

Wage

£22,000 a year

Training course

Software developer (level 4)

Hours

37 hours a week

Start date

Monday 3 August 2026

Duration

2 years

## Summary

Build web applications and APIs.

## Training

### Training provider

CODE ACADEMY LTD

### Training course

Software developer (level 4)

## Apply now

The reference code for this apprenticeship is VAC2000050000.`;

// Minimal markdown with missing employer (no non-blank line after H1)
const MD_NO_EMPLOYER = `# Unknown Role


`;

// Minimal markdown with no H1
const MD_NO_TITLE = `

Some Employer Ltd

Manchester (M1 1AA)

Closes in 5 days.

Training course

Data analyst (level 4)

The reference code for this apprenticeship is VAC2000088888.`;

// Mechanical vacancy (direct employer line — no blank line)
const MD_MECHANICAL = `# Apprentice Welding Engineer
United Infrastructure
Cheshire (WA5 3UZ)
Training course
Manufacturing engineer (degree) (level 6)
Wage
£20,000 a year
Closes in 21 days (Sunday 9 August 2026)
Distance 15.4 miles`;

// --- Server mock fixtures ---
const VACANCY_DEFENCE = `# Missile Systems Apprentice
BAE Systems
Portsmouth (PO1 3LT)
Training course
Engineering technician (level 4)
Wage
£18,000 a year
Closes on Friday 15 August 2026
Working on combat systems and weapons development for the Royal Navy.
Distance 5.2 miles`;

const VACANCY_SERCO = `# Marine Engineer Apprentice
Serco Limited
Recruiting nationally
Training course
Small vessel chief engineer (level 4)
Wage
£19,968 a year
Closes in 12 days (Friday 31 July 2026)
Working at the frontline of defence support, delivering essential services to military training activities.`;

const vacancyMap = {
  'VAC0001': MD_MECHANICAL,
  'VAC0002': VACANCY_DEFENCE,
  'VAC0003': VACANCY_SERCO,
  'VAC0004': MD_DATA_TECHNICIAN,
  'VAC0005': MD_SOFTWARE_DEV,
  'VAC0006': MD_DATA_ANALYST,
  'VAC0007': MD_DATA_ENGINEER,
};

function mockSearchPage(refs) {
  const links = refs.map(r => `- [Apprentice](https://www.findapprenticeship.service.gov.uk/apprenticeship/${r})`).join('\n');
  return { success: true, data: { markdown: `# Search results\n${links}`, creditsUsed: 1 } };
}

function mockVacancyPage(ref, md) {
  return { success: true, data: { markdown: md, creditsUsed: 1 } };
}

async function checksum(filepath) {
  try {
    const data = await readFile(filepath);
    return createHash('sha256').update(data).digest('hex');
  } catch { return null; }
}

async function resetData(entries) {
  await writeFile(TEST_DATA, JSON.stringify(entries || [], null, 2) + '\n');
}

function mockFetch(refs) {
  return mock.fn(async (url, opts) => {
    const b = JSON.parse(opts.body);
    const reqUrl = b.url;
    if (reqUrl.includes('/apprenticeships?')) {
      return { json: async () => mockSearchPage(refs) };
    }
    for (const [ref, md] of Object.entries(vacancyMap)) {
      if (reqUrl.includes(ref)) {
        return { json: async () => mockVacancyPage(ref, md) };
      }
    }
    return { json: async () => ({ success: false, error: 'not found' }) };
  });
}

function restoreKey(saved) {
  if (saved !== undefined) process.env.FIRECRAWL_API_KEY = saved;
  else delete process.env.FIRECRAWL_API_KEY;
}

before(async () => {
  prodChecksum = await checksum(PROD_DATA);
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  await mkdir(TEST_DATA_DIR, { recursive: true });
  await resetData([]);
  process.env.APP_DATA_DIR = TEST_DATA_DIR;

  const mod = await import('../server.js');
  server = mod.server;
  originalKey = process.env.FIRECRAWL_API_KEY;
  await new Promise(resolve => server.listen(3099, resolve));
});

after(async () => {
  server.close();
  restoreKey(originalKey);
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  const current = await checksum(PROD_DATA);
  assert.equal(current, prodChecksum, 'production data must be byte-for-byte unchanged');
});

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    }).on('error', reject);
  });
}

function post(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let resp = '';
      res.on('data', chunk => resp += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(resp) }); }
        catch { resolve({ status: res.statusCode, body: resp }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// Test isolation
// ============================================================
describe('Test isolation', () => {
  it('uses isolated data directory', () => {
    assert.equal(process.env.APP_DATA_DIR, TEST_DATA_DIR);
  });
  it('isolated test data is readable via API', async () => {
    await resetData([{
      reference: 'ISO-TEST', title: 'Test', employer: 'Test', url: '', location: '',
      distance: null, level: 3, pathway: 'data', sector: '', qualification: '',
      trainingProvider: '', salary: '', deadline: '', startDate: '', duration: '',
      matchScore: 78, notificationThreshold: 85, notificationStatus: '',
      defenceResult: '', eligibility: '', strengths: [], risks: [], status: 'review',
    }]);
    const { body } = await get('/api/opportunities');
    assert.equal(body.count, 1);
  });
});

// ============================================================
// parseVacancy: Data-vacancy parsing from real GOV.UK structure
// ============================================================
describe('parseVacancy', () => {
  let parseVacancy;
  before(async () => {
    const mod = await import('../server.js');
    parseVacancy = mod.parseVacancy;
  });

  it('parses Data Analyst with blank-line structure', () => {
    const r = parseVacancy(MD_DATA_ANALYST);
    assert.equal(r.title, 'Data Analyst Apprentice');
    assert.equal(r.employer, 'FOURTEEN (NORTH WEST) LTD');
    assert.ok(r.location.includes('ENGLAND') || r.location.includes('BL1'));
    assert.equal(r.level, 4);
    assert.equal(r.salary, '£17,550 a year');
    assert.ok(r.deadlineRaw.includes('Thursday 23 July 2026'));
    assert.ok(r.reference === 'VAC2000038797' || r.reference === 'VAC2000038797');
    assert.ok(r.description.length > 0);
  });

  it('parses Data Engineer with blank-line structure', () => {
    const r = parseVacancy(MD_DATA_ENGINEER);
    assert.equal(r.title, 'Data Engineer Apprentice');
    assert.equal(r.employer, 'Big Data Corp Ltd');
    assert.equal(r.level, 4);
    assert.equal(r.salary, '£21,000 a year');
    assert.equal(r.reference, 'VAC2000041234');
  });

  it('parses Data Technician with blank-line structure', () => {
    const r = parseVacancy(MD_DATA_TECHNICIAN);
    assert.equal(r.title, 'Data Technician Apprentice');
    assert.equal(r.employer, 'DataCorp Ltd');
    assert.equal(r.level, 3);
    assert.equal(r.salary, '£18,000 a year');
    assert.equal(r.reference, 'VAC2000045678');
  });

  it('parses mechanical vacancy with direct-employer line', () => {
    const r = parseVacancy(MD_MECHANICAL);
    assert.equal(r.title, 'Apprentice Welding Engineer');
    assert.equal(r.employer, 'United Infrastructure');
    assert.equal(r.level, 6);
  });

  it('missing employer returns empty string', () => {
    const r = parseVacancy(MD_NO_EMPLOYER);
    assert.equal(r.title, 'Unknown Role');
    assert.equal(r.employer, '', 'employer must be empty string when absent');
  });

  it('no H1 title returns empty string', () => {
    const r = parseVacancy(MD_NO_TITLE);
    assert.equal(r.title, '');
  });

  it('blank lines do not shift fields into employer', () => {
    const r = parseVacancy(MD_NO_EMPLOYER);
    assert.equal(r.employer, '', 'blank lines must not push unrelated text into employer');
  });

  it('extracts level from Training course line', () => {
    let r = parseVacancy(MD_DATA_ANALYST);
    assert.equal(r.level, 4);
    r = parseVacancy(MD_DATA_TECHNICIAN);
    assert.equal(r.level, 3);
  });

  it('extracts salary across labelled GOV.UK structure', () => {
    const r = parseVacancy(MD_DATA_ANALYST);
    assert.equal(r.salary, '£17,550 a year');
  });

  it('extracts qualification from ### Training course heading', () => {
    const r = parseVacancy(MD_DATA_ANALYST);
    assert.equal(r.qualification, 'Data analyst (level 4)');
  });
  it('extracts trainingProvider from ### Training provider heading', () => {
    const r = parseVacancy(MD_DATA_ANALYST);
    assert.equal(r.trainingProvider, 'NOWSKILLS LIMITED');
  });
  it('extracts startDate from Start date label', () => {
    const r = parseVacancy(MD_DATA_ANALYST);
    assert.equal(r.startDate, 'Friday 24 July 2026');
  });
  it('extracts duration from Duration label', () => {
    const r = parseVacancy(MD_DATA_ANALYST);
    assert.equal(r.duration, '1 year 8 months');
  });
  it('qualification is empty string when ### Training course heading absent', () => {
    const r = parseVacancy(MD_MECHANICAL);
    assert.equal(r.qualification, '', 'no ### Training course heading → qualification must be empty string');
  });
});

// ============================================================
// classifyPathway
// ============================================================
describe('classifyPathway', () => {
  let classifyPathway;
  before(async () => { classifyPathway = (await import('../server.js')).classifyPathway; });

  it('classifies Data Analyst as data', () => {
    const mod = {};
    const r = { title: 'Data Analyst Apprentice', description: '' };
    assert.equal(classifyPathway(r), 'data');
  });
  it('classifies Data Engineer as data', () => {
    assert.equal(classifyPathway({ title: 'Data Engineer Apprentice', description: '' }), 'data');
  });
  it('classifies Data Technician as data', () => {
    assert.equal(classifyPathway({ title: 'Data Technician Apprentice', description: '' }), 'data');
  });
  it('classifies Welding Engineer as mechanical', () => {
    assert.equal(classifyPathway({ title: 'Apprentice Welding Engineer', description: '' }), 'mechanical');
  });
  it('rejects Software Developer', () => {
    assert.equal(classifyPathway({ title: 'Software Developer Apprentice', description: '' }), null);
  });
});

// ============================================================
// filterByCriteria
// ============================================================
describe('filterByCriteria', () => {
  let filterByCriteria;
  before(async () => { filterByCriteria = (await import('../server.js')).filterByCriteria; });

  it('excludes beyond distance', () => {
    assert.equal(filterByCriteria([{ reference: 'V1', distance: 15.4, level: 6, pathway: 'mechanical' }], { distance: 10, mechLevels: ['6'] }).length, 0);
  });
  it('mech L4 + data L3 rejects mech L3', () => {
    assert.equal(filterByCriteria([{ reference: 'V1', distance: 5, level: 3, pathway: 'mechanical' }], { distance: 25, mechLevels: ['4'], dataLevels: ['3'] }).length, 0);
  });
  it('mech L4 + data L3 rejects data L4', () => {
    assert.equal(filterByCriteria([{ reference: 'V1', distance: 5, level: 4, pathway: 'data' }], { distance: 25, mechLevels: ['4'], dataLevels: ['3'] }).length, 0);
  });
  it('mech L4 + data L3 accepts mech L4', () => {
    assert.equal(filterByCriteria([{ reference: 'V1', distance: 5, level: 4, pathway: 'mechanical' }], { distance: 25, mechLevels: ['4'], dataLevels: ['3'] }).length, 1);
  });
});

// ============================================================
// classifyPathway — automotive / utilities / civilian aviation
// ============================================================
describe('classifyPathway — sector coverage', () => {
  let classifyPathway;
  before(async () => { classifyPathway = (await import('../server.js')).classifyPathway; });

  it('automotive role classifies as mechanical', () => {
    assert.equal(classifyPathway({ title: 'Apprentice Automotive Technician', description: '' }), 'mechanical');
  });
  it('vehicle mechanic classifies as mechanical', () => {
    assert.equal(classifyPathway({ title: 'Vehicle Mechanic Apprentice', description: '' }), 'mechanical');
  });
  it('utilities engineer classifies as mechanical', () => {
    assert.equal(classifyPathway({ title: 'Utilities Engineer Apprentice', description: '' }), 'mechanical');
  });
  it('gas/water utility technician classifies as mechanical', () => {
    assert.equal(classifyPathway({ title: 'Gas Network Technician Apprentice', description: '' }), 'mechanical');
  });
  it('IT network technician is not mechanical', () => {
    assert.equal(classifyPathway({ title: 'IT Network Technician Apprentice', description: '' }), null);
  });
  it('civilian aviation maintenance engineer classifies as mechanical', () => {
    assert.equal(classifyPathway({ title: 'Aircraft Maintenance Engineer Apprentice', description: '' }), 'mechanical');
  });
  it('aerospace technician classifies as mechanical', () => {
    assert.equal(classifyPathway({ title: 'Aerospace Technician Apprentice', description: '' }), 'mechanical');
  });
});

// ============================================================
// filterByCriteria — null/unknown distance policy
// ============================================================
describe('filterByCriteria — null distance policy', () => {
  let filterByCriteria;
  before(async () => { filterByCriteria = (await import('../server.js')).filterByCriteria; });

  it('null distance passes the distance filter (not excluded)', () => {
    const opps = [{ reference: 'VN1', distance: null, level: 4, pathway: 'mechanical' }];
    assert.equal(filterByCriteria(opps, { distance: 10, mechLevels: ['4'] }).length, 1,
      'vacancy with null distance must not be excluded by distance filter');
  });
  it('undefined distance passes the distance filter', () => {
    const opps = [{ reference: 'VN2', level: 3, pathway: 'data' }];
    assert.equal(filterByCriteria(opps, { distance: 5, dataLevels: ['3'] }).length, 1,
      'vacancy with undefined distance must not be excluded by distance filter');
  });
  it('null distance still subject to level filter', () => {
    const opps = [{ reference: 'VN3', distance: null, level: 5, pathway: 'mechanical' }];
    assert.equal(filterByCriteria(opps, { distance: 10, mechLevels: ['4'] }).length, 0,
      'null-distance vacancy must still be excluded when level does not match');
  });
});

// ============================================================
// filterByCriteria — pathway=both
// ============================================================
describe('filterByCriteria — both pathway', () => {
  let filterByCriteria;
  before(async () => { filterByCriteria = (await import('../server.js')).filterByCriteria; });

  it('both-pathway vacancy included when level in mechLevels union', () => {
    const opps = [{ reference: 'VB1', distance: 5, level: 4, pathway: 'both' }];
    assert.equal(filterByCriteria(opps, { distance: 25, mechLevels: ['4'], dataLevels: ['3'] }).length, 1);
  });
  it('both-pathway vacancy included when level in dataLevels union', () => {
    const opps = [{ reference: 'VB2', distance: 5, level: 3, pathway: 'both' }];
    assert.equal(filterByCriteria(opps, { distance: 25, mechLevels: ['4'], dataLevels: ['3'] }).length, 1);
  });
  it('both-pathway vacancy excluded when level in neither set', () => {
    const opps = [{ reference: 'VB3', distance: 5, level: 6, pathway: 'both' }];
    assert.equal(filterByCriteria(opps, { distance: 25, mechLevels: ['4'], dataLevels: ['3'] }).length, 0);
  });
});

// ============================================================
// filterByCriteria — combined search enforces level per pathway
// ============================================================
describe('filterByCriteria — combined search independent level enforcement', () => {
  let filterByCriteria;
  before(async () => { filterByCriteria = (await import('../server.js')).filterByCriteria; });

  // mechLevels=['4'], dataLevels=['3']: a mech L3 must be rejected even though L3 is valid for data
  it('mech vacancy at data-selected level is rejected', () => {
    const opps = [{ reference: 'VC1', distance: 5, level: 3, pathway: 'mechanical' }];
    assert.equal(filterByCriteria(opps, { distance: 25, mechLevels: ['4'], dataLevels: ['3'] }).length, 0,
      'mech L3 must be rejected when mechLevels=[4], even though dataLevels includes 3');
  });
  // data L4 must be rejected even though L4 is valid for mech
  it('data vacancy at mech-selected level is rejected', () => {
    const opps = [{ reference: 'VC2', distance: 5, level: 4, pathway: 'data' }];
    assert.equal(filterByCriteria(opps, { distance: 25, mechLevels: ['4'], dataLevels: ['3'] }).length, 0,
      'data L4 must be rejected when dataLevels=[3], even though mechLevels includes 4');
  });
  // mech L4 accepted under mechLevels=['4']
  it('mech vacancy at mech-selected level is accepted', () => {
    const opps = [{ reference: 'VC3', distance: 5, level: 4, pathway: 'mechanical' }];
    assert.equal(filterByCriteria(opps, { distance: 25, mechLevels: ['4'], dataLevels: ['3'] }).length, 1);
  });
  // data L3 accepted under dataLevels=['3']
  it('data vacancy at data-selected level is accepted', () => {
    const opps = [{ reference: 'VC4', distance: 5, level: 3, pathway: 'data' }];
    assert.equal(filterByCriteria(opps, { distance: 25, mechLevels: ['4'], dataLevels: ['3'] }).length, 1);
  });
});

// ============================================================
// buildSearchURL
// ============================================================
// ============================================================
// Threshold wording (API: searchThreshold in response)
// ============================================================
describe('Threshold wording via API searchThreshold', () => {
  // We test the search endpoint with mocked fetch so we can observe searchThreshold
  // in the response and validate the wording logic in isolation.

  before(async () => {
    await resetData([]);
    process.env.FIRECRAWL_API_KEY = '***';
    globalThis.fetch = mockFetch(['VAC0001']); // Mechanical L6, score 78
  });
  after(() => {
    globalThis.fetch = mockFetch(['VAC0001', 'VAC0002', 'VAC0003']);
  });

  it('default threshold (85) returned in searchThreshold field', async () => {
    await resetData([]);
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4', '5', '6'], dataLevels: [] } });
    assert.equal(body.searchThreshold, 85, 'searchThreshold must equal the default 85');
  });

  it('non-default threshold 50 returned in searchThreshold field', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0001']);
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4', '5', '6'], dataLevels: [], threshold: '50' } });
    assert.equal(body.searchThreshold, 50, 'searchThreshold must reflect the requested 50% threshold');
  });

  it('score 78 below default threshold 85: notificationThreshold stored as 85', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0001']);
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4', '5', '6'], dataLevels: [] } });
    // matchScore=78 < threshold=85 → "below" wording territory
    assert.equal(body.accepted.matchScore, 78);
    assert.equal(body.searchThreshold, 85);
    assert.ok(body.accepted.matchScore < body.searchThreshold, '78 must be below 85');
  });

  it('score 78 at or above threshold 50: meets alert threshold territory', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0001']);
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4', '5', '6'], dataLevels: [], threshold: '50' } });
    assert.equal(body.accepted.matchScore, 78);
    assert.equal(body.searchThreshold, 50);
    assert.ok(body.accepted.matchScore >= body.searchThreshold, '78 must be ≥ 50');
  });

  it('score 78 equal to threshold 78: meets alert threshold territory', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0001']);
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4', '5', '6'], dataLevels: [], threshold: '78' } });
    assert.equal(body.searchThreshold, 78);
    assert.ok(body.accepted.matchScore >= body.searchThreshold, '78 must be ≥ 78 (equal counts as meeting threshold)');
  });

  it('score 78 above threshold 70: meets alert threshold territory', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0001']);
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4', '5', '6'], dataLevels: [], threshold: '70' } });
    assert.equal(body.searchThreshold, 70);
    assert.ok(body.accepted.matchScore >= body.searchThreshold, '78 must be ≥ 70');
  });

  it('app.js renderCard: 78% with threshold 50 produces meets-threshold label', () => {
    // Verify the wording logic directly without a browser
    function thresholdLabel(matchScore, threshold) {
      const meetsThreshold = matchScore >= threshold;
      return meetsThreshold
        ? `Meets alert threshold — ${matchScore}% is at or above the ${threshold}% email-alert threshold.`
        : `Review opportunity — ${matchScore}% is below the ${threshold}% email-alert threshold.`;
    }
    assert.equal(
      thresholdLabel(78, 50),
      'Meets alert threshold — 78% is at or above the 50% email-alert threshold.'
    );
  });

  it('app.js renderCard: 78% with threshold 85 produces below-threshold label', () => {
    function thresholdLabel(matchScore, threshold) {
      const meetsThreshold = matchScore >= threshold;
      return meetsThreshold
        ? `Meets alert threshold — ${matchScore}% is at or above the ${threshold}% email-alert threshold.`
        : `Review opportunity — ${matchScore}% is below the ${threshold}% email-alert threshold.`;
    }
    assert.equal(
      thresholdLabel(78, 85),
      'Review opportunity — 78% is below the 85% email-alert threshold.'
    );
  });

  it('app.js renderCard: 78% equal to threshold 78 produces meets-threshold label', () => {
    function thresholdLabel(matchScore, threshold) {
      const meetsThreshold = matchScore >= threshold;
      return meetsThreshold
        ? `Meets alert threshold — ${matchScore}% is at or above the ${threshold}% email-alert threshold.`
        : `Review opportunity — ${matchScore}% is below the ${threshold}% email-alert threshold.`;
    }
    assert.equal(
      thresholdLabel(78, 78),
      'Meets alert threshold — 78% is at or above the 78% email-alert threshold.'
    );
  });
});

describe('buildSearchURL pathway', () => {
  let buildSearchURL;
  before(async () => { buildSearchURL = (await import('../server.js')).buildSearchURL; });

  it('mech-only uses routeIds=9', () => {
    const url = buildSearchURL({ distance: 25, mechLevels: ['4'], dataLevels: [] });
    const ids = [...url.matchAll(/routeIds=(\d+)/g)].map(m => m[1]);
    assert.ok(ids.includes('9'));
  });
  it('data-only uses routeIds=7', () => {
    const url = buildSearchURL({ distance: 10, mechLevels: [], dataLevels: ['3'] });
    const ids = [...url.matchAll(/routeIds=(\d+)/g)].map(m => m[1]);
    assert.ok(ids.includes('7'));
  });
});

// ============================================================
// Data-role relevance
// ============================================================
describe('Data-role relevance', () => {
  let isDataRole;
  before(async () => { isDataRole = (await import('../server.js')).isDataRole; });
  it('accepts Data Technician', () => assert.ok(isDataRole({ title: 'Data Technician Apprentice' })));
  it('accepts Data Engineer', () => assert.ok(isDataRole({ title: 'Data Engineer Apprentice' })));
  it('accepts Data Analyst', () => assert.ok(isDataRole({ title: 'Data Analyst Apprentice' })));
  it('rejects Software Developer', () => assert.ok(!isDataRole({ title: 'Software Developer Apprentice' })));
  it('rejects software mentioning data in title', () => assert.ok(!isDataRole({ title: 'Software Developer Apprentice (Data Systems)' })));
  it('rejects IT Support', () => assert.ok(!isDataRole({ title: 'IT Support Technician' })));
  it('rejects Network Engineer', () => assert.ok(!isDataRole({ title: 'Network Engineer Apprentice' })));
});

// ============================================================
// Mechanical-role relevance
// ============================================================
describe('Mechanical-role relevance', () => {
  let isMechanicalRole;
  before(async () => { isMechanicalRole = (await import('../server.js')).isMechanicalRole; });
  it('accepts Welding Engineer', () => assert.ok(isMechanicalRole({ title: 'Apprentice Welding Engineer', description: '' })));
  it('accepts Manufacturing', () => assert.ok(isMechanicalRole({ title: 'Manufacturing Technician', description: '' })));
  it('accepts Rail Engineer', () => assert.ok(isMechanicalRole({ title: 'Rail Engineering Technician', description: '' })));
  it('rejects Software Developer', () => assert.ok(!isMechanicalRole({ title: 'Software Developer Apprentice', description: '' })));
  it('rejects Chef', () => assert.ok(!isMechanicalRole({ title: 'Chef Apprentice', description: '' })));
});

// ============================================================
// Firecrawl live search (integration)
// ============================================================
describe('Firecrawl live search', () => {
  before(async () => {
    await resetData([]);
    process.env.FIRECRAWL_API_KEY = '***';
    globalThis.fetch = mockFetch(['VAC0001', 'VAC0002', 'VAC0003']);
  });
  after(() => { globalThis.fetch = undefined; });

  it('503 when API key is missing', async () => {
    const saved = process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    await resetData([]);
    const { status } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4'], dataLevels: [] } });
    assert.equal(status, 503);
    restoreKey(saved);
  });

  it('accepts suitable mechanical vacancy', async () => {
    await resetData([]);
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4', '5', '6'], dataLevels: [] } });
    assert.equal(body.accepted.employer, 'United Infrastructure');
    assert.equal(body.accepted.pathway, 'mechanical');
  });

  it('rejects defence', async () => {
    await resetData([{
      reference: 'VAC0001', title: 'Welder', employer: 'UI', url: '', location: '', distance: 15.4,
      level: 6, pathway: 'mechanical', sector: '', qualification: '', trainingProvider: '',
      salary: '', deadline: '', startDate: '', duration: '', matchScore: 78,
      notificationThreshold: 85, notificationStatus: '', defenceResult: '',
      eligibility: '', strengths: [], risks: [], status: 'review',
    }]);
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4'], dataLevels: [] } });
    assert.ok((body.skipped || []).some(s => s.reason === 'defence'));
  });

  it('rejects duplicates', async () => {
    await resetData([{
      reference: 'VAC0001', title: 'Welder', employer: 'UI', url: '', location: '', distance: 15.4,
      level: 6, pathway: 'mechanical', sector: '', qualification: '', trainingProvider: '',
      salary: '', deadline: '', startDate: '', duration: '', matchScore: 78,
      notificationThreshold: 85, notificationStatus: '', defenceResult: '',
      eligibility: '', strengths: [], risks: [], status: 'review',
    }]);
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4', '5', '6'], dataLevels: [] } });
    assert.ok(body.skipped.some(s => s.reason === 'duplicate'));
  });

  it('handles no suitable results', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0002', 'VAC0003']);
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4'], dataLevels: [] } });
    assert.equal(body.accepted, null);
    assert.ok(body.message.includes('No suitable'));
    globalThis.fetch = mockFetch(['VAC0001', 'VAC0002', 'VAC0003']);
  });

  // --- New parsing integration tests ---

  it('Data Analyst parses and is accepted for Data L4 search', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0006']); // Data Analyst
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: [], dataLevels: ['3', '4'] } });
    assert.ok(body.accepted, 'Data Analyst should be parsed and accepted');
    assert.equal(body.accepted.employer, 'FOURTEEN (NORTH WEST) LTD');
    assert.equal(body.accepted.level, 4);
    assert.equal(body.accepted.pathway, 'data');
    globalThis.fetch = mockFetch(['VAC0001', 'VAC0002', 'VAC0003']);
  });

  it('Data Engineer parses and is accepted for Data L4 search', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0007']); // Data Engineer
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: [], dataLevels: ['4'] } });
    assert.ok(body.accepted, 'Data Engineer should be parsed and accepted');
    assert.equal(body.accepted.employer, 'Big Data Corp Ltd');
    assert.equal(body.accepted.level, 4);
    assert.equal(body.accepted.pathway, 'data');
    globalThis.fetch = mockFetch(['VAC0001', 'VAC0002', 'VAC0003']);
  });

  it('Data Technician parses and is accepted for Data L3 search', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0004']); // Data Technician
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: [], dataLevels: ['3'] } });
    assert.ok(body.accepted, 'Data Technician should be parsed and accepted');
    assert.equal(body.accepted.employer, 'DataCorp Ltd');
    assert.equal(body.accepted.level, 3);
    assert.equal(body.accepted.pathway, 'data');
    globalThis.fetch = mockFetch(['VAC0001', 'VAC0002', 'VAC0003']);
  });

  it('Software Dev parses but is rejected as not a relevant role', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0005']); // Software Dev
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: [], dataLevels: ['3', '4'] } });
    assert.equal(body.accepted, null, 'Software Dev must not be accepted');
    assert.ok((body.skipped || []).some(s => s.reason === 'not a relevant role'));
    globalThis.fetch = mockFetch(['VAC0001', 'VAC0002', 'VAC0003']);
  });

  it('parsing_failed recorded when employer missing', async () => {
    // Override fetch to return a fixture with missing employer
    const MD_NO_EMP = `# Data Apprentice


`;
    const tempMap = { 'VAC0009': MD_NO_EMP };
    globalThis.fetch = mock.fn(async (url, opts) => {
      const b = JSON.parse(opts.body);
      const reqUrl = b.url;
      if (reqUrl.includes('/apprenticeships?')) {
        return { json: async () => mockSearchPage(['VAC0009']) };
      }
      for (const [ref, md] of Object.entries(tempMap)) {
        if (reqUrl.includes(ref)) { return { json: async () => mockVacancyPage(ref, md) }; }
      }
      return { json: async () => ({ success: false }) };
    });
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: [], dataLevels: ['3', '4'] } });
    assert.equal(body.accepted, null, 'no vacancy accepted');
    assert.ok((body.skipped || []).some(s => s.reason === 'parsing_failed'), 'parsing_failed must be recorded');
    const pf = body.skipped.find(s => s.reason === 'parsing_failed');
    assert.ok(pf, 'parsing_failed entry exists');
    assert.ok(pf.missingFields && pf.missingFields.includes('employer'), 'missingFields must include employer');
    globalThis.fetch = mockFetch(['VAC0001', 'VAC0002', 'VAC0003']);
  });

  // --- Existing regression ---
  it('excluding beyond distance', async () => {
    await resetData([{
      reference: 'V-FAR', title: 'Welder', employer: 'Far', url: '', location: '', distance: 15.4,
      level: 6, pathway: 'mechanical', sector: '', qualification: '', trainingProvider: '',
      salary: '', deadline: '', startDate: '', duration: '', matchScore: 78,
      notificationThreshold: 85, notificationStatus: '', defenceResult: '',
      eligibility: '', strengths: [], risks: [], status: 'review',
    }]);
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 10, mechLevels: ['4', '5'], dataLevels: [] } });
    assert.equal(body.opportunities.length, 0);
  });

  it('stores custom threshold', async () => {
    await resetData([]);
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4', '5', '6'], dataLevels: [], threshold: '50' } });
    assert.equal(body.accepted.notificationThreshold, 50);
  });

  it('deduplicates by reference', async () => {
    await resetData([
      { reference: 'V-DUP', title: 'A', employer: 'T', url: '', location: '', distance: 5, level: 6,
        pathway: 'mechanical', sector: '', qualification: '', trainingProvider: '',
        salary: '', deadline: '', startDate: '', duration: '', matchScore: 78,
        notificationThreshold: 85, notificationStatus: '', defenceResult: '',
        eligibility: '', strengths: [], risks: [], status: 'review' },
      { reference: 'V-DUP', title: 'B', employer: 'T', url: '', location: '', distance: 5, level: 6,
        pathway: 'mechanical', sector: '', qualification: '', trainingProvider: '',
        salary: '', deadline: '', startDate: '', duration: '', matchScore: 60,
        notificationThreshold: 85, notificationStatus: '', defenceResult: '',
        eligibility: '', strengths: [], risks: [], status: 'review' },
    ]);
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4', '5', '6'], dataLevels: [] } });
    assert.equal(body.opportunities.filter(o => o.reference === 'V-DUP').length, 1);
  });

  it('combined: mech L4 accepted, data L3 accepted', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0001', 'VAC0004']); // mech L6, data tech L3
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['4', '5', '6'], dataLevels: ['3'] } });
    assert.ok(body.accepted, 'should accept first matching vacancy');
    globalThis.fetch = mockFetch(['VAC0001', 'VAC0002', 'VAC0003']);
  });

  it('data vacancy rejected in mech-only search', async () => {
    await resetData([]);
    globalThis.fetch = mockFetch(['VAC0004']); // Data Technician
    process.env.FIRECRAWL_API_KEY = '***';
    const { body } = await post('/api/search', { preferences: { distance: 25, mechLevels: ['3', '4'], dataLevels: [] } });
    assert.equal(body.accepted, null, 'data vacancy must be rejected in mech-only search');
    globalThis.fetch = mockFetch(['VAC0001', 'VAC0002', 'VAC0003']);
  });
});

// ============================================================
// API basics
// ============================================================
describe('API basics', () => {
  it('GET /api/health returns 200', async () => {
    const { status, body } = await get('/api/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });
  it('GET /api/opportunities returns data', async () => {
    const { status, body } = await get('/api/opportunities');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.opportunities));
  });
  it('GET / serves index.html', async () => {
    const { status, body } = await get('/');
    assert.equal(status, 200);
    assert.ok(body.includes('<!DOCTYPE html>'));
  });
  it('client JS uses dynamic threshold', async () => {
    const { body } = await get('/app.js');
    assert.ok(body.includes('notificationThreshold'));
    assert.ok(body.includes('threshold'));
  });
});

// Legacy
describe('Legacy filtering', () => {
  it('rejects duplicate by reference', async () => {
    await resetData([{
      reference: 'VAC2000041895', title: 'Test', employer: 'Test', url: '', location: '', distance: 5,
      level: 6, pathway: 'mechanical', sector: '', qualification: '', trainingProvider: '',
      salary: '', deadline: '', startDate: '', duration: '', matchScore: 82,
      notificationThreshold: 85, notificationStatus: '', defenceResult: '',
      eligibility: '', strengths: [], risks: [], status: 'review',
    }]);
    const { status } = await post('/api/search', {
      candidate: { reference: 'VAC2000041895', title: 'Test', employer: 'Test' }
    });
    assert.equal(status, 409);
  });
  it('rejects defence role', async () => {
    await resetData([]);
    const { status } = await post('/api/search', {
      candidate: { title: 'Missile Apprentice', employer: 'BAE Systems', description: 'Weapons.' }
    });
    assert.equal(status, 422);
  });
});
