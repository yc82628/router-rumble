// Balance check: plays every level headlessly with an idle team and a competent bot team.
//
//   npm test                    # all levels, 2/6/10 players, 5 seeds each
//   node scripts/balance.js 3   # only level 3
//
// Rules (fail the run if broken):
//   - a team that plays well must clear the level in at least 80% of runs
//   - a team that does nothing must not average more than 1.5 stars (no free wins)
// The bot only uses controls the level unlocks, like a real player.
import { createState, tick, effectiveCapacity, starsFor } from '../public/screen/sim.js';
import { LEVELS } from '../public/screen/levels.js';

const SEEDS = [1, 2, 3, 4, 5];
const TEAM_SIZES = [2, 6, 10];
const MIN_PLAY_PASS_RATE = 0.8;
const MAX_IDLE_AVG_STARS = 1.5;

const onlyLevel = Number(process.argv[2]) || null;
const ratio = (r) => (r.status === 'crashed' ? 9 : r.load / effectiveCapacity(r));

/** A competent team: FIX problems, BOOST when about to crash, move big devices, push to quieter neighbours. */
function botInputs(s, teamSize) {
  const can = (c) => !s.level.controls || s.level.controls.includes(c);
  const out = [];
  const bossOn = s.boss && ['arriving', 'attacking'].includes(s.boss.phase);
  for (const r of s.routers) {
    const act = (action) => out.push({ routerId: r.id, action });
    if (r.status === 'crashed') { act('fix'); act('fix'); continue; }
    const enemyHere = s.bots.some((b) => b.routerId === r.id && b.state === 'attached');
    const cableHere = s.links.some((l) => l.cut && (l.a === r.index || l.b === r.index));
    if (enemyHere || cableHere || (bossOn && r.index < teamSize)) { act('fix'); act('fix'); }
    const load = ratio(r);
    if (load > 0.95) {
      if (can('boost') && r.boostCooldown <= 0 && r.overTime > 1) act('boost');
      if (can('send')) {
        const big = [...r.devices].filter((d) => d.reconnect <= 0).sort((a, b) => b.demand - a.demand)[0];
        const quiet = [...s.routers].sort((a, b) => ratio(a) - ratio(b))[0];
        if (big && quiet !== r && ratio(quiet) < 0.7) { out.push({ action: 'moveDevice', deviceId: big.id, routerId: quiet.id }); continue; }
      }
      const L = s.routers[r.index - 1];
      const R = s.routers[r.index + 1];
      const lr = L ? ratio(L) : 9;
      const rr = R ? ratio(R) : 9;
      if (Math.min(lr, rr) < 0.85) act(lr <= rr ? 'pushLeft' : 'pushRight');
    } else if (load < 0.6 && (r.shareL || r.shareR)) {
      act('pullBack');
    }
  }
  return out;
}

function run(levelIndex, teamSize, seed, playing) {
  const players = Array.from({ length: teamSize }, (_, i) => ({ playerId: `p${i}`, name: `P${i}`, color: '#58e6ff', colorName: 'CYAN' }));
  const s = createState({ level: LEVELS[levelIndex], levelIndex, players, seed });
  for (let n = 0; !s.result && s.time < 400; n++) tick(s, 0.1, playing && n % 4 === 0 ? botInputs(s, teamSize) : []);
  return { passed: s.result === 'passed', stars: starsFor(s), health: Math.round(s.health), crashes: s.crashes };
}

let problems = 0;
for (const [i, level] of LEVELS.entries()) {
  if (onlyLevel && onlyLevel !== i + 1) continue;
  for (const size of TEAM_SIZES) {
    const play = SEEDS.map((seed) => run(i, size, seed, true));
    const idle = SEEDS.map((seed) => run(i, size, seed, false));
    const passRate = play.filter((r) => r.passed).length / play.length;
    const idleStars = idle.reduce((n, r) => n + r.stars, 0) / idle.length;
    const ok = passRate >= MIN_PLAY_PASS_RATE && idleStars <= MAX_IDLE_AVG_STARS;
    if (!ok) problems++;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} L${i + 1} ${level.name.padEnd(13)} ${String(size).padStart(2)} players | ` +
      `play: ${Math.round(passRate * 100)}% cleared (${play.map((r) => `${r.stars}★`).join(' ')}) | ` +
      `idle: ${idleStars.toFixed(1)}★ avg (${idle.map((r) => (r.passed ? `${r.health}%` : 'lost')).join(' ')})`,
    );
  }
}
console.log(problems ? `\n${problems} balance problem(s).` : '\nBalance OK.');
process.exit(problems ? 1 : 0);
