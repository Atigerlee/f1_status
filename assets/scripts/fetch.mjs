#!/usr/bin/env node
/**
 * F1 2026 data fetcher (manual, run after each Grand Prix).
 *
 * Usage (from hw5/):
 *   node assets/scripts/fetch.mjs                # fetch every finished round that has no file yet
 *   node assets/scripts/fetch.mjs --round 5      # (re)fetch a single round
 *   node assets/scripts/fetch.mjs --force        # re-fetch all finished rounds
 *   node assets/scripts/fetch.mjs --season 2026  # override season
 *
 * Sources: Jolpica-F1 (Ergast successor) + OpenF1.
 * Output : assets/data/*.json  (the front-end reads only these static files)
 */
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');
const JOLPICA = 'https://api.jolpi.ca/ergast/f1';
const OPENF1 = 'https://api.openf1.org/v1';

// ---------- CLI ----------
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const SEASON = argVal('--season') || '2026';
const ONLY_ROUND = argVal('--round') ? Number(argVal('--round')) : null;
const FORCE = args.includes('--force');

// ---------- HTTP with throttle + retry ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastCall = { jolpica: 0, openf1: 0 };
const GAP = { jolpica: 350, openf1: 2200 }; // OpenF1 free tier: 30 req/min

async function get(kind, url, { optional = false } = {}) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const wait = lastCall[kind] + GAP[kind] - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall[kind] = Date.now();
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        const delay = 3000 * attempt;
        console.warn(`  ! ${res.status} ${url} -> retry in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      if (res.status === 404) return optional ? null : Promise.reject(new Error(`404 ${url}`));
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      if (attempt === 6) { if (optional) { console.warn(`  ! giving up: ${e.message}`); return null; } throw e; }
      await sleep(2000 * attempt);
    }
  }
  return null;
}
const jol = (path, opt) => get('jolpica', `${JOLPICA}${path}`, opt);
const opf = (path, opt) => get('openf1', `${OPENF1}${path}`, { optional: true, ...opt });

/** Fetch every page of a Jolpica list endpoint and return concatenated MRData tables. */
async function jolAll(path, pick) {
  const out = [];
  let offset = 0, total = Infinity;
  while (offset < total) {
    const d = await jol(`${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`, { optional: true });
    if (!d) break;
    total = Number(d.MRData.total);
    out.push(...pick(d.MRData));
    offset += 100;
  }
  return out;
}

// ---------- helpers ----------
const fmtLap = (s) => {
  if (s == null || Number.isNaN(Number(s))) return '';
  s = Number(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(3).padStart(6, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : m ? `${m}:${sec}` : (+sec).toFixed(3);
};
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const exists = (p) => access(p).then(() => true, () => false);
const writeJson = async (rel, obj) => {
  const file = join(DATA, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj));
};
const readJson = async (rel) => JSON.parse(await readFile(join(DATA, rel), 'utf8'));

const OPF_SESSION = {
  'Practice 1': 'fp1', 'Practice 2': 'fp2', 'Practice 3': 'fp3',
  'Sprint Qualifying': 'sprintQualifying', 'Sprint Shootout': 'sprintQualifying',
  Sprint: 'sprint', Qualifying: 'qualifying', Race: 'race',
};

// ---------- Jolpica row mappers ----------
const driverRef = (d) => ({
  code: d.code || (d.familyName || '').slice(0, 3).toUpperCase(),
  number: num(d.permanentNumber),
  name: `${d.givenName} ${d.familyName}`,
  nationality: d.nationality,
});

function mapRace(rows) {
  return rows.map((r) => ({
    pos: num(r.position), posText: r.positionText, driver: driverRef(r.Driver).code, number: num(r.number),
    name: driverRef(r.Driver).name, team: r.Constructor.name, constructorId: r.Constructor.constructorId,
    grid: num(r.grid), laps: num(r.laps), time: r.Time?.time || '', points: num(r.points) ?? 0,
    status: r.status, fastestLap: r.FastestLap ? { rank: num(r.FastestLap.rank), lap: num(r.FastestLap.lap), time: r.FastestLap.Time?.time } : null,
  }));
}
function mapQuali(rows) {
  return rows.map((r) => ({
    pos: num(r.position), driver: driverRef(r.Driver).code, number: num(r.number), name: driverRef(r.Driver).name,
    team: r.Constructor.name, constructorId: r.Constructor.constructorId, q1: r.Q1 || '', q2: r.Q2 || '', q3: r.Q3 || '',
  }));
}

// ---------- OpenF1 session helpers ----------
const driverCache = new Map(); // session_key -> { number: {code,team,color} }
async function openF1Drivers(sessionKey) {
  if (driverCache.has(sessionKey)) return driverCache.get(sessionKey);
  const list = (await opf(`/drivers?session_key=${sessionKey}`)) || [];
  const map = {};
  for (const d of list) map[d.driver_number] = { code: d.name_acronym, team: d.team_name, color: d.team_colour, name: d.full_name, headshot: d.headshot_url };
  driverCache.set(sessionKey, map);
  return map;
}

function mapOpenF1Result(rows, drivers, isQuali) {
  const info = (n) => drivers[n] || { code: `#${n}`, team: '' };
  return rows
    .slice()
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
    .map((r) => {
      const d = info(r.driver_number);
      const base = { pos: r.position, driver: d.code, number: r.driver_number, team: d.team, laps: r.number_of_laps };
      if (isQuali || Array.isArray(r.duration)) {
        const [q1, q2, q3] = Array.isArray(r.duration) ? r.duration : [r.duration];
        return { ...base, q1: fmtLap(q1), q2: fmtLap(q2), q3: fmtLap(q3) };
      }
      const gap = r.gap_to_leader;
      return { ...base, time: fmtLap(r.duration), gap: gap ? `+${Number(gap).toFixed(3)}` : '' };
    });
}

/** Stints from OpenF1 keyed by driver code. */
async function fetchStints(sessionKey, drivers) {
  const rows = (await opf(`/stints?session_key=${sessionKey}`)) || [];
  const out = {};
  for (const s of rows) {
    const code = drivers[s.driver_number]?.code || `#${s.driver_number}`;
    (out[code] ||= []).push({ stint: s.stint_number, compound: s.compound || 'UNKNOWN', start: s.lap_start, end: s.lap_end, age: s.tyre_age_at_start ?? 0 });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.stint - b.stint);
  return out;
}

/** Lap-by-lap positions for a session from OpenF1 (used for sprints; Jolpica has no sprint laps). */
async function fetchPositionsOpenF1(sessionKey, drivers, gridByCode) {
  const laps = await opf(`/laps?session_key=${sessionKey}`);
  const pos = await opf(`/position?session_key=${sessionKey}`);
  if (!laps?.length || !pos?.length) return null;
  const posBy = {};
  for (const p of pos) (posBy[p.driver_number] ||= []).push({ t: Date.parse(p.date), p: p.position });
  const lapsBy = {};
  for (const l of laps) if (l.date_start && l.lap_duration) (lapsBy[l.driver_number] ||= []).push(l);
  const out = {};
  for (const [n, ls] of Object.entries(lapsBy)) {
    const code = drivers[n]?.code || `#${n}`;
    ls.sort((a, b) => a.lap_number - b.lap_number);
    const series = posBy[n]?.sort((a, b) => a.t - b.t) || [];
    const arr = [gridByCode[code] ?? null];
    for (const l of ls) {
      const end = Date.parse(l.date_start) + l.lap_duration * 1000;
      let cur = null;
      for (const s of series) { if (s.t <= end) cur = s.p; else break; }
      arr[l.lap_number] = cur;
    }
    out[code] = arr;
  }
  return out;
}

/** Lap-by-lap positions for the race from Jolpica (index 0 = grid). */
async function fetchLapPositions(round, race) {
  const laps = await jolAll(`/${SEASON}/${round}/laps.json`, (m) => m.RaceTable.Races[0]?.Laps || []);
  if (!laps.length) return null;
  const idToCode = {};
  const out = {};
  // laps are paginated by timings so one lap may be split across pages -> merge by lap number
  const byLap = new Map();
  for (const l of laps) {
    const n = Number(l.number);
    byLap.set(n, [...(byLap.get(n) || []), ...l.Timings]);
  }
  const results = race.Results;
  for (const r of results) idToCode[r.Driver.driverId] = driverRef(r.Driver).code;
  // grid positions (pit-lane starters are given grid 0 -> put them behind the last gridded car)
  const gridded = results.filter((r) => Number(r.grid) > 0).length;
  let extra = gridded;
  const pitStarters = results.filter((r) => Number(r.grid) === 0).sort((a, b) => Number(a.position) - Number(b.position));
  for (const r of results) if (Number(r.grid) > 0) (out[idToCode[r.Driver.driverId]] ||= [])[0] = Number(r.grid);
  for (const r of pitStarters) (out[idToCode[r.Driver.driverId]] ||= [])[0] = ++extra;
  for (const [n, timings] of [...byLap.entries()].sort((a, b) => a[0] - b[0])) {
    for (const t of timings) {
      const code = idToCode[t.driverId];
      if (code) (out[code] ||= [])[n] = Number(t.position);
    }
  }
  return out;
}

async function fetchPitstops(round, idToCode) {
  const rows = await jolAll(`/${SEASON}/${round}/pitstops.json`, (m) => m.RaceTable.Races[0]?.PitStops || []);
  const out = {};
  for (const p of rows) {
    const code = idToCode[p.driverId] || p.driverId;
    (out[code] ||= []).push({ stop: Number(p.stop), lap: Number(p.lap), duration: p.duration, time: p.time });
  }
  return out;
}

// ---------- track outline ----------
async function fetchTrack(circuitId, raceSessionKey, drivers, winnerCode) {
  const file = `tracks/${circuitId}.json`;
  if (await exists(join(DATA, file)) && !FORCE) return;
  const number = Object.keys(drivers).find((n) => drivers[n].code === winnerCode) || Object.keys(drivers)[0];
  if (!number) return;
  const laps = await opf(`/laps?session_key=${raceSessionKey}&driver_number=${number}&lap_number=3`);
  const lap = laps?.[0];
  if (!lap?.date_start || !lap.lap_duration) { console.warn(`  ! no lap data for track ${circuitId}`); return; }
  const from = new Date(Date.parse(lap.date_start)).toISOString();
  const to = new Date(Date.parse(lap.date_start) + lap.lap_duration * 1000).toISOString();
  const loc = await opf(`/location?session_key=${raceSessionKey}&driver_number=${number}&date%3E=${encodeURIComponent(from)}&date%3C=${encodeURIComponent(to)}`);
  if (!loc?.length) { console.warn(`  ! no location data for track ${circuitId}`); return; }
  const pts = loc.filter((p) => p.x || p.y);
  const step = Math.max(1, Math.floor(pts.length / 300));
  const sampled = pts.filter((_, i) => i % step === 0).map((p) => [p.x, p.y]);
  const xs = sampled.map((p) => p[0]), ys = sampled.map((p) => p[1]);
  await writeJson(file, { circuitId, points: sampled, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  console.log(`  + track ${circuitId} (${sampled.length} pts)`);
}

// ---------- static images (driver photos, country flags) ----------
const IMG = join(__dirname, '..', 'img');
const COUNTRY_ISO = {
  Australia: 'au', China: 'cn', Japan: 'jp', USA: 'us', Canada: 'ca', Monaco: 'mc', Spain: 'es', Austria: 'at', UK: 'gb',
  Belgium: 'be', Hungary: 'hu', Netherlands: 'nl', Italy: 'it', Azerbaijan: 'az', Malaysia: 'my', Singapore: 'sg',
  Mexico: 'mx', Brazil: 'br', Qatar: 'qa', UAE: 'ae', Bahrain: 'bh', 'Saudi Arabia': 'sa', Portugal: 'pt', Germany: 'de',
  France: 'fr', Turkey: 'tr', Russia: 'ru', Korea: 'kr', India: 'in', Argentina: 'ar', Thailand: 'th',
};
/** Download a binary file once (skipped when it already exists unless --force). Returns true if the file is available. */
async function download(url, dest) {
  if (await exists(dest) && !FORCE) return true;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch (e) {
    console.warn(`  ! image failed ${url} (${e.message})`);
    return false;
  }
}

// ---------- main ----------
async function main() {
  const now = Date.now();
  console.log(`Fetching F1 ${SEASON} ...`);

  // 1. schedule
  const sched = (await jol(`/${SEASON}.json?limit=100`)).MRData.RaceTable.Races;
  const schedule = sched.map((r) => ({
    round: Number(r.round), name: r.raceName, circuitId: r.Circuit.circuitId, circuit: r.Circuit.circuitName,
    locality: r.Circuit.Location.locality, country: r.Circuit.Location.country,
    date: r.date, time: r.time || null, isSprint: !!r.Sprint,
    sessions: {
      fp1: r.FirstPractice || null, fp2: r.SecondPractice || null, fp3: r.ThirdPractice || null,
      sprintQualifying: r.SprintQualifying || r.SprintShootout || null, sprint: r.Sprint || null,
      qualifying: r.Qualifying || null, race: { date: r.date, time: r.time || null },
    },
  }));
  const finishedByDate = (r) => Date.parse(`${r.date}T${r.time || '23:59:59Z'}`) + 3 * 3600e3 < now;

  // 2. OpenF1 sessions -> meeting for each round
  const opfSessions = (await opf(`/sessions?year=${SEASON}`)) || [];
  const meetingFor = (r) => {
    const target = Date.parse(r.date);
    const races = opfSessions.filter((s) => s.session_name === 'Race');
    const hit = races.find((s) => Math.abs(Date.parse(s.date_start.slice(0, 10)) - target) <= 864e5);
    return hit ? opfSessions.filter((s) => s.meeting_key === hit.meeting_key) : [];
  };

  // 3. decide which rounds to fetch
  const todo = [];
  for (const r of schedule) {
    if (ONLY_ROUND && r.round !== ONLY_ROUND) continue;
    if (!ONLY_ROUND && !finishedByDate(r)) continue;
    const has = await exists(join(DATA, `rounds/${r.round}.json`));
    if (has && !FORCE && !ONLY_ROUND) continue;
    todo.push(r);
  }
  console.log(`Rounds to fetch: ${todo.map((r) => r.round).join(', ') || '(none)'}`);

  for (const r of todo) {
    console.log(`Round ${r.round} - ${r.name}`);
    const raceRes = (await jol(`/${SEASON}/${r.round}/results.json?limit=100`, { optional: true }))?.MRData.RaceTable.Races[0];
    if (!raceRes?.Results?.length) { console.log('  (no race results yet, skipped)'); continue; }
    const qual = (await jol(`/${SEASON}/${r.round}/qualifying.json?limit=100`, { optional: true }))?.MRData.RaceTable.Races[0];
    const spr = r.isSprint ? (await jol(`/${SEASON}/${r.round}/sprint.json?limit=100`, { optional: true }))?.MRData.RaceTable.Races[0] : null;

    const idToCode = {};
    for (const x of raceRes.Results) idToCode[x.Driver.driverId] = driverRef(x.Driver).code;

    const out = {
      round: r.round, name: r.name, circuitId: r.circuitId, circuit: r.circuit, country: r.country, locality: r.locality,
      date: r.date, isSprint: r.isSprint, totalLaps: Math.max(...raceRes.Results.map((x) => Number(x.laps))),
      sessions: { race: mapRace(raceRes.Results), qualifying: qual ? mapQuali(qual.QualifyingResults) : [] },
    };
    if (spr) out.sessions.sprint = mapRace(spr.SprintResults);

    // Jolpica extras
    out.lapPositions = await fetchLapPositions(r.round, raceRes);
    out.pitstops = await fetchPitstops(r.round, idToCode);

    // OpenF1 extras
    const meeting = meetingFor(r);
    if (!meeting.length) console.warn('  ! no matching OpenF1 meeting - practice/stints/track unavailable');
    const byName = (n) => meeting.find((s) => s.session_name === n && !s.is_cancelled);
    const raceS = byName('Race');
    const drivers = raceS ? await openF1Drivers(raceS.session_key) : {};
    for (const s of meeting) {
      const key = OPF_SESSION[s.session_name];
      if (!key || ['race', 'qualifying', 'sprint'].includes(key) || s.is_cancelled) continue;
      const rows = await opf(`/session_result?session_key=${s.session_key}`);
      out.sessions[key] = rows ? mapOpenF1Result(rows, drivers, key === 'sprintQualifying') : [];
      console.log(`  + ${key}: ${out.sessions[key].length} rows`);
    }
    if (raceS) {
      out.stints = await fetchStints(raceS.session_key, drivers);
      await fetchTrack(r.circuitId, raceS.session_key, drivers, out.sessions.race[0]?.driver);
    }
    const sprintS = byName('Sprint');
    if (sprintS && spr) {
      out.sprintStints = await fetchStints(sprintS.session_key, drivers);
      const grid = Object.fromEntries(out.sessions.sprint.map((x) => [x.driver, x.grid || null]));
      out.sprintLapPositions = await fetchPositionsOpenF1(sprintS.session_key, drivers, grid);
    }
    await writeJson(`rounds/${r.round}.json`, out);
    console.log(`  saved rounds/${r.round}.json`);
  }

  // 4. standings (always refreshed) + drivers
  const dsRaw = (await jol(`/${SEASON}/driverstandings.json?limit=100`)).MRData.StandingsTable.StandingsLists[0];
  const csRaw = (await jol(`/${SEASON}/constructorstandings.json?limit=100`)).MRData.StandingsTable.StandingsLists[0];

  // per-round points from saved round files
  const roundFiles = (await readdir(join(DATA, 'rounds')).catch(() => [])).filter((f) => f.endsWith('.json'));
  const driverRound = {}, teamDriver = {};
  for (const f of roundFiles) {
    const rd = JSON.parse(await readFile(join(DATA, 'rounds', f), 'utf8'));
    for (const key of ['sprint', 'race']) {
      for (const row of rd.sessions[key] || []) {
        if (!row.points) continue;
        ((driverRound[row.driver] ||= {})[rd.round] ||= 0);
        driverRound[row.driver][rd.round] += row.points;
        ((teamDriver[row.constructorId] ||= {})[row.driver] ||= {});
        teamDriver[row.constructorId][row.driver][rd.round] = (teamDriver[row.constructorId][row.driver][rd.round] || 0) + row.points;
      }
    }
  }

  const standingsRound = Number(dsRaw?.round || 0);
  const driverStandings = (dsRaw?.DriverStandings || []).map((s) => ({
    pos: num(s.position), driver: driverRef(s.Driver).code, points: num(s.points), wins: num(s.wins),
    constructorId: s.Constructors.at(-1)?.constructorId, perRound: driverRound[driverRef(s.Driver).code] || {},
  }));
  const constructorStandings = (csRaw?.ConstructorStandings || []).map((s) => ({
    pos: num(s.position), constructorId: s.Constructor.constructorId, name: s.Constructor.name, points: num(s.points), wins: num(s.wins),
    drivers: Object.entries(teamDriver[s.Constructor.constructorId] || {}).map(([code, per]) => ({
      driver: code, points: Object.values(per).reduce((a, b) => a + b, 0), perRound: per,
    })).sort((a, b) => b.points - a.points),
  }));

  // drivers.json (colours from OpenF1)
  const lastRound = roundFiles.length ? Math.max(...roundFiles.map((f) => parseInt(f))) : null;
  let opfDrivers = {};
  if (lastRound) {
    const sc = schedule.find((s) => s.round === lastRound);
    const rs = meetingFor(sc).find((s) => s.session_name === 'Race');
    if (rs) opfDrivers = await openF1Drivers(rs.session_key);
  }
  const colourByCode = Object.fromEntries(Object.values(opfDrivers).map((d) => [d.code, d.color]));
  const headshotByCode = Object.fromEntries(Object.values(opfDrivers).map((d) => [d.code, d.headshot]));
  const driversOut = {}, teamsOut = {};
  for (const s of dsRaw?.DriverStandings || []) {
    const ref = driverRef(s.Driver), c = s.Constructors.at(-1);
    const color = colourByCode[ref.code] ? `#${colourByCode[ref.code]}` : '#888888';
    let photo = null;
    if (headshotByCode[ref.code]) {
      const rel = `img/drivers/${ref.code}.png`;
      if (await download(headshotByCode[ref.code], join(__dirname, '..', rel))) photo = `assets/${rel}`;
    }
    driversOut[ref.code] = { ...ref, constructorId: c?.constructorId, team: c?.name, color, photo };
    if (c) teamsOut[c.constructorId] ||= { name: c.name, color };
  }
  // country flags (flagcdn.com) for every race on the calendar
  for (const r of schedule) {
    const iso = COUNTRY_ISO[r.country];
    if (!iso) { console.warn(`  ! no ISO code for country "${r.country}" (add it to COUNTRY_ISO)`); continue; }
    r.flag = (await download(`https://flagcdn.com/w80/${iso}.png`, join(IMG, 'flags', `${iso}.png`))) ? `assets/img/flags/${iso}.png` : null;
  }
  // drivers that appear in rounds but have left the standings (rare) keep a neutral entry
  await writeJson('drivers.json', { drivers: driversOut, teams: teamsOut });
  await writeJson('schedule.json', schedule);
  await writeJson('driver_standings.json', { season: SEASON, afterRound: standingsRound, standings: driverStandings });
  await writeJson('constructor_standings.json', { season: SEASON, afterRound: standingsRound, standings: constructorStandings });
  await writeJson('meta.json', {
    season: SEASON, lastUpdated: new Date().toISOString(), roundsAvailable: roundFiles.map((f) => parseInt(f)).sort((a, b) => a - b),
  });
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
