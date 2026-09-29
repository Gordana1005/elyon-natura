// Integrations tab words for the 15-minute schedules (migrations 20260942001300 / 1400). Exact-line edits.
import { readFileSync, writeFileSync } from 'node:fs';
const root = 'D:/Dev/archives/elyon-natura/src/i18n/locales/';
const T = {
  mk: {
    mex_bio_natural: 'Пратки на Affiliate (Lead in и Lead out) — на секои 15 мин, 06:00–23:00',
    mex_natura: 'Пратки на телешоп, социјални мрежи и веб — на секои 15 мин, 06:00–23:00',
    collabbox: 'Документи од collabBox — целосно на секои 15 мин (07:00–23:00) и ноќно во 00:00 (последните 3 дена)',
    daytime_15m: 'на секои 15 мин, 06:00–23:00',
    cbx_15m: 'на секои 15 мин, 07:00–23:00',
  },
  en: {
    mex_bio_natural: 'Affiliate parcels (Lead in and Lead out) — every 15 min, 06:00–23:00',
    mex_natura: 'Teleshop, social media and web parcels — every 15 min, 06:00–23:00',
    collabbox: 'collabBox documents — a full pass every 15 min (07:00–23:00) and nightly at 00:00 (last 3 days)',
    daytime_15m: 'every 15 min, 06:00–23:00',
    cbx_15m: 'every 15 min, 07:00–23:00',
  },
  sq: {
    mex_bio_natural: 'Pakot e Affiliate (Lead in dhe Lead out) — çdo 15 min, 06:00–23:00',
    mex_natura: 'Pakot e teleshopit, rrjeteve sociale dhe uebit — çdo 15 min, 06:00–23:00',
    collabbox: 'Dokumentet e collabBox — kalim i plotë çdo 15 min (07:00–23:00) dhe natën në 00:00 (3 ditët e fundit)',
    daytime_15m: 'çdo 15 min, 06:00–23:00',
    cbx_15m: 'çdo 15 min, 07:00–23:00',
  },
  bg: {
    mex_bio_natural: 'Пратки на Affiliate (Lead in и Lead out) — на всеки 15 мин, 06:00–23:00',
    mex_natura: 'Пратки на телешоп, социални мрежи и уеб — на всеки 15 мин, 06:00–23:00',
    collabbox: 'Документи от collabBox — пълно минаване на всеки 15 мин (07:00–23:00) и нощно в 00:00 (последните 3 дни)',
    daytime_15m: 'на всеки 15 мин, 06:00–23:00',
    cbx_15m: 'на всеки 15 мин, 07:00–23:00',
  },
};
for (const [lng, t] of Object.entries(T)) {
  const p = root + lng + '.json';
  let s = readFileSync(p, 'utf8');
  const j = JSON.parse(s);
  const fd = j.settings?.integrations?.feedDesc, ex = j.settings?.integrations?.expect;
  if (!fd || !ex) throw new Error(`${lng}: settings.integrations.feedDesc/expect missing`);
  const swap = (key, val) => {
    const old = JSON.stringify(fd[key]);
    const re = new RegExp(`("${key}": )${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    const n = (s.match(re) || []).length;
    if (n !== 1) throw new Error(`${lng}.${key}: ${n} matches`);
    s = s.replace(re, `$1${JSON.stringify(val)}`);
  };
  swap('mex_bio_natural', t.mex_bio_natural);
  swap('mex_natura', t.mex_natura);
  swap('collabbox', t.collabbox);
  if (!ex.daytime_15m) {
    const anchor = `"daytime_30m": ${JSON.stringify(ex.daytime_30m)},`;
    if (s.split(anchor).length !== 2) throw new Error(`${lng}: daytime_30m anchor`);
    const indent = s.slice(0, s.indexOf(anchor)).split('\n').pop();
    s = s.replace(anchor, `${anchor}\n${indent}"daytime_15m": ${JSON.stringify(t.daytime_15m)},\n${indent}"cbx_15m": ${JSON.stringify(t.cbx_15m)},`);
  }
  const back = JSON.parse(s);   // still valid JSON, and the values landed
  const ok = back.settings.integrations.feedDesc.collabbox === t.collabbox && back.settings.integrations.expect.cbx_15m === t.cbx_15m;
  if (!ok) throw new Error(`${lng}: verify failed`);
  writeFileSync(p, s);
  console.log(lng, 'ok');
}
