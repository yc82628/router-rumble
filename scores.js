// Score storage for the leaderboards. Server-only.
//
//   Upstash Redis (free tier), when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set:
//     survives restarts and deploys (needed on Render's free tier, which wipes its disk).
//   Otherwise a JSON file (data/scores.json): survives restarts on a normal machine.
//
// Every finished run is one entry; boards (today / week / all-time / daily) are computed from them.
import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = 'rr:scores';
const KEEP = 5000; // most recent runs kept
const CACHE_MS = 10000;

export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export function createScoreStore({ file, url, token }) {
  const upstash = Boolean(url && token);
  let cache = null;
  let cacheAt = 0;

  async function redis(commands) {
    const res = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}`);
    const out = await res.json();
    const failed = out.find((r) => r.error);
    if (failed) throw new Error(`Upstash: ${failed.error}`);
    return out.map((r) => r.result);
  }

  async function readFile() {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return []; // first run, or an unreadable file: start fresh rather than crash
    }
  }

  async function writeFile(entries) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entries));
    await fs.rename(tmp, file); // atomic swap: a crash mid-write never leaves half a file
  }

  /** All stored runs, newest first. */
  async function all() {
    if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
    const entries = upstash
      ? (await redis([['LRANGE', KEY, 0, -1]]))[0].map((s) => JSON.parse(s))
      : await readFile();
    cache = entries;
    cacheAt = Date.now();
    return entries;
  }

  async function add(entry) {
    if (upstash) {
      await redis([['LPUSH', KEY, JSON.stringify(entry)], ['LTRIM', KEY, 0, KEEP - 1]]);
    } else {
      const entries = await readFile();
      entries.unshift(entry);
      await writeFile(entries.slice(0, KEEP));
    }
    cache = null;
  }

  return { all, add, kind: upstash ? 'upstash' : 'file' };
}

export const BOARDS = ['today', 'week', 'all', 'daily'];

/** Top runs for one board. */
export function board(entries, name, now = Date.now(), limit = 10) {
  const today = utcDay(now);
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const keep = {
    today: (e) => e.mode !== 'daily' && e.day === today,
    week: (e) => e.mode !== 'daily' && e.at >= weekAgo,
    all: (e) => e.mode !== 'daily',
    daily: (e) => e.mode === 'daily' && e.day === today,
  }[name] || (() => false);
  return entries
    .filter(keep)
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, limit)
    .map(({ team, score, level, stars, at }) => ({ team, score, level, stars, at }));
}
