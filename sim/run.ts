// 밸런스 시뮬레이션 실행기: `npm run sim` (옵션: -- --seeds 1000 --out sim/results/summary.json)
// 같은 규칙 수치 + 같은 옵션이면 항상 같은 결과가 나온다 (모든 난수는 시드 고정).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RULES_VERSION } from '../src/shared/types';
import { ACTION_DATA, GAME_CONSTANTS, RULE_DATA, getAction, seededRng } from '../src/shared/rules';
import { mixSeed, playGame, summarize, type GameRecord, type Summary } from './engine';
import { STRATEGIES } from './strategies';

export function numbersHash(): string {
  return createHash('sha256').update(JSON.stringify({ ACTION_DATA, RULE_DATA, GAME_CONSTANTS })).digest('hex').slice(0, 16);
}

const IDS = STRATEGIES.map((s) => s.id);

/** n인 판, 좌석마다 전략을 무작위(시드 고정)로 배정 → 구성·좌석 순서가 모두 달라진다 */
export function runPool(n: number, seeds: number): GameRecord[] {
  const games: GameRecord[] = [];
  for (let i = 0; i < seeds; i++) {
    const seed = mixSeed(n, i);
    const comp = seededRng(mixSeed(seed, 99));
    const strategies = Array.from({ length: n }, () => IDS[Math.floor(comp.next() * IDS.length)]);
    games.push(playGame(strategies, seed));
  }
  return games;
}

/** 2인 1:1 대전표. 짝수 시드는 a가 p0, 홀수 시드는 b가 p0 (좌석 교대) */
export function runHeadToHead(seeds: number): Record<string, Record<string, number>> {
  const m: Record<string, Record<string, number>> = {};
  for (const a of IDS) {
    m[a] = {};
    for (const b of IDS) {
      if (a === b) continue;
      let score = 0;
      for (let i = 0; i < seeds; i++) {
        const seed = mixSeed(2000, IDS.indexOf(a), IDS.indexOf(b), i);
        const flip = i % 2 === 1;
        const g = playGame(flip ? [b, a] : [a, b], seed);
        const aId = flip ? 'p1' : 'p0';
        if (g.winners.includes(aId)) score += g.winners.length > 1 ? 0.5 : 1;
      }
      m[a][b] = Math.round((score / seeds) * 1000) / 1000;
    }
  }
  return m;
}

/** 속도: 같은 전략 2명이 10일 끝까지 진행했을 때 목표 도달 일차 */
export function runPace(seeds: number): Record<string, { reachRate: number; avgReachDay: number | null; avgDay10Score: number }> {
  const out: Record<string, { reachRate: number; avgReachDay: number | null; avgDay10Score: number }> = {};
  for (const id of IDS) {
    let reach = 0, daySum = 0, scoreSum = 0, cnt = 0;
    for (let i = 0; i < seeds; i++) {
      const g = playGame([id, id], mixSeed(3000, IDS.indexOf(id), i), { ignoreWinner: true });
      for (const s of g.seats) {
        cnt++;
        scoreSum += s.finalScore;
        if (s.reachedDay !== null) { reach++; daySum += s.reachedDay; }
      }
    }
    out[id] = {
      reachRate: Math.round((reach / cnt) * 1000) / 1000,
      avgReachDay: reach ? Math.round((daySum / reach) * 100) / 100 : null,
      avgDay10Score: Math.round(scoreSum / cnt),
    };
  }
  return out;
}

export interface SimOutput {
  rulesVersion: string;
  numbersHash: string;
  generatedBy: string;
  seedsPerPool: number;
  seedScheme: string;
  strategies: { id: string; label: string; description: string }[];
  pace: ReturnType<typeof runPace>;
  headToHead2p: ReturnType<typeof runHeadToHead>;
  pools: Record<string, Summary>;
}

export function runAll(seeds: number): SimOutput {
  const pools: Record<string, Summary> = {};
  for (const n of [2, 4, 6]) pools[`${n}p`] = summarize(runPool(n, seeds));
  return {
    rulesVersion: RULES_VERSION,
    numbersHash: numbersHash(),
    generatedBy: `npm run sim -- --seeds ${seeds}`,
    seedsPerPool: seeds,
    seedScheme: 'pool: gameSeed=mixSeed(n,i), 좌석 전략=seededRng(mixSeed(gameSeed,99)); h2h: mixSeed(2000,a,b,i) 홀수 i 좌석 교대; pace: mixSeed(3000,s,i); bot rng=mixSeed(gameSeed,7919,seat), i=0..seeds-1',
    strategies: STRATEGIES.map(({ id, label, description }) => ({ id, label, description })),
    pace: runPace(seeds),
    headToHead2p: runHeadToHead(seeds),
    pools,
  };
}

// ── 출력 ──
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pad = (s: string | number, w: number): string => String(s).padStart(w);

function print(o: SimOutput): void {
  const lines: string[] = [];
  lines.push(`규칙 ${o.rulesVersion} · 수치 해시 ${o.numbersHash} · 풀당 시드 ${o.seedsPerPool}`);
  lines.push('', '[속도] 같은 전략 2명, 10일 끝까지: 도달률 / 평균 도달 일차 / 10일 점수');
  for (const s of STRATEGIES) {
    const p = o.pace[s.id];
    lines.push(`  ${s.id.padEnd(14)} ${pad(pct(p.reachRate), 7)} ${pad(p.avgReachDay ?? '-', 6)} ${pad(p.avgDay10Score, 5)}`);
  }
  lines.push('', '[2인 1:1] 행 전략의 승점 (승 1, 공동 0.5)');
  lines.push('  ' + ''.padEnd(14) + IDS.map((id) => pad(id.slice(0, 8), 9)).join(''));
  for (const a of IDS) {
    lines.push('  ' + a.padEnd(14) + IDS.map((b) => pad(a === b ? '-' : pct(o.headToHead2p[a][b]), 9)).join(''));
  }
  for (const [k, s] of Object.entries(o.pools)) {
    lines.push('', `[${k} 무작위 구성 ${s.games}판] 평균 종료 ${s.avgEndDay}일 · 10일 종료 ${pct(s.day10Rate)} · 공동 승리 ${pct(s.jointWinRate)}`);
    lines.push(`  종료 일차 분포: ${Object.entries(s.endDayDist).map(([d, c]) => `${d}일 ${c}`).join(', ')}`);
    lines.push(`  밤 역전 ${s.nightComebacksPerGame}/판 (역전 있는 판 ${pct(s.gamesWithNightComeback)}, 마지막 밤 역전 승리 ${pct(s.finalNightComebackRate)})`);
    lines.push(`  회복: 슬롯 ${pct(s.recoverySlotRate)}, 회복 쓴 참가자-일 ${pct(s.recoveryDayRate)} · 손실(최고점-${s.lossRecovery.x}↓) 경험 ${s.lossRecovery.players}명 중 승리 ${pct(s.lossRecovery.wonRate)}, 목표 도달 ${pct(s.lossRecovery.reachedRate)} (즉시 순환 제외 ${s.lossRecoveryExInstant.players}명: 승리 ${pct(s.lossRecoveryExInstant.wonRate)}, 도달 ${pct(s.lossRecoveryExInstant.reachedRate)})`);
    lines.push(`  유형 선택률: ${Object.entries(s.categoryRate).map(([c, r]) => `${c} ${pct(r)}`).join(', ')}`);
    lines.push(`  행동 선택률: ${Object.entries(s.actionRate).filter(([, r]) => r > 0).map(([a, r]) => `${getAction(a as never).name} ${pct(r)}`).join(', ')}`);
    lines.push('  전략           판수   승률  단독승  평균점수 도달률 도달일 회복일 손실전승');
    for (const id of IDS) {
      const t = s.strategies[id];
      if (!t) continue;
      lines.push(`  ${id.padEnd(14)}${pad(t.games, 5)} ${pad(pct(t.winRate), 6)} ${pad(t.soloWins, 6)} ${pad(t.avgFinal, 8)} ${pad(pct(t.reachRate), 6)} ${pad(t.avgReachDay ?? '-', 6)} ${pad(pct(t.recoveryDayRate), 6)} ${pad(pct(t.winBeforeLossRate), 7)}`);
    }
  }
  console.log(lines.join('\n'));
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const isMain = process.argv[1] && /run\.ts$/.test(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const seeds = Number(arg('seeds', '1000'));
  const out = arg('out', 'sim/results/summary.json');
  const t0 = Date.now();
  const o = runAll(seeds);
  print(o);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(o, null, 2) + '\n', 'utf8');
  console.log(`\n저장: ${out} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
