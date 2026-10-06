// 한 판 진행과 지표 집계. 정산·승리 판정은 전부 실제 규칙 함수(resolveDay, checkWinner)를 쓴다.
import type { ActionId, Plan, PlayerRuleState } from '../src/shared/types';
import { ACTION_IDS } from '../src/shared/types';
import { GAME_CONSTANTS, checkWinner, createPlayerState, getAction, resolveDay, seededRng, validatePlan } from '../src/shared/rules';
import { STRATEGY_BY_ID } from './strategies';

/** 손실 후 회복 판정 기준: 최고점 대비 이만큼 이상 떨어진 적이 있는 참가자 */
export const DRAWDOWN_X = 8;

export interface SeatRecord {
  playerId: string;
  strategy: string;
  finalScore: number;
  won: boolean;
  /** 처음 목표 점수에 도달한 일차 (없으면 null) */
  reachedDay: number | null;
  maxDrawdown: number;
  /** 첫 음수 점수 변화가 일어난 일차 (없으면 null) */
  firstLossDay: number | null;
  recoveryDays: number;
  daySlots: number;
  /** 각 일차 밤 종료 후 점수 */
  scoreByDay: number[];
}

export interface GameRecord {
  seed: number;
  endDay: number;
  winners: string[];
  seats: SeatRecord[];
  /** 밤 이전 단독 선두가 밤 이후 선두가 아니게 된 횟수 */
  nightComebacks: number;
  /** 마지막 날 밤에 선두가 바뀌어 승자가 결정된 경우 */
  finalNightComeback: boolean;
  /** 낮에 고른 행동 횟수 */
  dayActions: Partial<Record<ActionId, number>>;
}

/** 일차·시드·좌석을 섞어 결정적으로 만든 32비트 시드 */
export function mixSeed(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h ^= x >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
  }
  return h >>> 0;
}

const leaders = (scores: Record<string, number>): string[] => {
  const max = Math.max(...Object.values(scores));
  return Object.keys(scores).filter((k) => scores[k] === max);
};

/**
 * strategies[i] 가 좌석 i(playerId = `p${i}`)를 맡는다. playerId 순서가 규칙의 난수 사용 순서이므로
 * 좌석 순서를 바꾸면 같은 시드라도 다른 판이 된다.
 * ignoreWinner: 목표 도달 후에도 10일째까지 진행 (속도 측정용)
 */
export function playGame(strategies: string[], seed: number, opts: { ignoreWinner?: boolean } = {}): GameRecord {
  const ids = strategies.map((_, i) => `p${i}`);
  let players: PlayerRuleState[] = ids.map((id) => createPlayerState(id));
  const rng = seededRng(seed);
  const botRngs = ids.map((_, i) => seededRng(mixSeed(seed, 7919, i)));
  const peak: Record<string, number> = {};
  const seat: Record<string, SeatRecord> = {};
  ids.forEach((id, i) => {
    peak[id] = 0;
    seat[id] = {
      playerId: id, strategy: strategies[i], finalScore: 0, won: false, reachedDay: null,
      maxDrawdown: 0, firstLossDay: null, recoveryDays: 0, daySlots: 0, scoreByDay: [],
    };
  });
  const dayActions: GameRecord['dayActions'] = {};
  let nightComebacks = 0;
  let finalNightComeback = false;
  let winners: string[] = [];
  let endDay: number = GAME_CONSTANTS.maxDays;

  for (let day = 1; day <= GAME_CONSTANTS.maxDays; day++) {
    const plans: Record<string, Plan> = {};
    players.forEach((me, i) => {
      const plan = STRATEGY_BY_ID.get(strategies[i])!.plan({ me, players, day, rng: botRngs[i] });
      const v = validatePlan(plan);
      if (!v.ok) throw new Error(`invalid plan from ${strategies[i]} day ${day}: ${v.reason} ${JSON.stringify(plan)}`);
      plans[me.playerId] = plan;
      let rec = false;
      for (const s of plan.slots) {
        if (!s) continue;
        dayActions[s.actionId] = (dayActions[s.actionId] ?? 0) + 1;
        seat[me.playerId].daySlots += 1;
        if (getAction(s.actionId).category === 'recovery') rec = true;
      }
      if (rec) seat[me.playerId].recoveryDays += 1;
    });

    const { players: next, result } = resolveDay(players, plans, day, rng);
    const beforeNight: Record<string, number> = {};
    for (const p of players) beforeNight[p.playerId] = p.score;
    for (const e of [...result.dayEvents, ...result.nightEvents]) {
      if (e.phase === 'day') beforeNight[e.playerId] = e.scoreAfter;
      const s = seat[e.playerId];
      if (e.delta < 0 && s.firstLossDay === null) s.firstLossDay = day;
      peak[e.playerId] = Math.max(peak[e.playerId], e.scoreAfter);
      s.maxDrawdown = Math.max(s.maxDrawdown, peak[e.playerId] - e.scoreAfter);
    }
    const lb = leaders(beforeNight);
    const la = leaders(result.scoresAfter);
    const comeback = lb.length === 1 && !la.includes(lb[0]);
    if (comeback) nightComebacks += 1;
    players = next;
    for (const p of players) {
      seat[p.playerId].scoreByDay.push(p.score);
      if (p.score >= GAME_CONSTANTS.targetScore && seat[p.playerId].reachedDay === null) seat[p.playerId].reachedDay = day;
    }

    const w = checkWinner(players, day);
    if (w.finished && winners.length === 0) {
      winners = w.winnerIds;
      endDay = day;
      finalNightComeback = comeback;
      if (!opts.ignoreWinner) break;
    }
  }
  for (const p of players) {
    seat[p.playerId].finalScore = p.score;
    seat[p.playerId].won = winners.includes(p.playerId);
  }
  return { seed, endDay, winners, seats: ids.map((id) => seat[id]), nightComebacks, finalNightComeback, dayActions };
}

// ── 집계 ──

export interface StrategyStats {
  games: number;
  wins: number;
  winRate: number;
  soloWins: number;
  avgFinal: number;
  reachRate: number;
  avgReachDay: number | null;
  recoveryDayRate: number;
  /** 첫 손실 전에 이긴 비율 (판 수 대비) */
  winBeforeLossRate: number;
}

export interface Summary {
  games: number;
  jointWinRate: number;
  avgEndDay: number;
  endDayDist: Record<number, number>;
  day10Rate: number;
  strategies: Record<string, StrategyStats>;
  actionRate: Record<string, number>;
  categoryRate: Record<string, number>;
  recoverySlotRate: number;
  recoveryDayRate: number;
  nightComebacksPerGame: number;
  gamesWithNightComeback: number;
  finalNightComebackRate: number;
  lossRecovery: { x: number; players: number; wonRate: number; reachedRate: number };
  /** 즉시 보상 순환 봇을 뺀 손실 후 회복 */
  lossRecoveryExInstant: { x: number; players: number; wonRate: number; reachedRate: number };
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export function summarize(games: GameRecord[]): Summary {
  const endDayDist: Record<number, number> = {};
  let endSum = 0;
  let joint = 0;
  let comebacks = 0;
  let withComeback = 0;
  let finalCb = 0;
  const acts: Record<string, number> = {};
  const st: Record<string, { games: number; wins: number; solo: number; final: number; reach: number; reachDay: number; recDays: number; days: number; wbl: number }> = {};
  let ddPlayers = 0, ddWon = 0, ddReached = 0;
  let exPlayers = 0, exWon = 0, exReached = 0;
  let recDays = 0, playerDays = 0;

  for (const g of games) {
    endDayDist[g.endDay] = (endDayDist[g.endDay] ?? 0) + 1;
    endSum += g.endDay;
    if (g.winners.length > 1) joint++;
    comebacks += g.nightComebacks;
    if (g.nightComebacks > 0) withComeback++;
    if (g.finalNightComeback) finalCb++;
    for (const [k, v] of Object.entries(g.dayActions)) acts[k] = (acts[k] ?? 0) + (v ?? 0);
    for (const s of g.seats) {
      const t = (st[s.strategy] ??= { games: 0, wins: 0, solo: 0, final: 0, reach: 0, reachDay: 0, recDays: 0, days: 0, wbl: 0 });
      t.games++;
      if (s.won) { t.wins++; if (g.winners.length === 1) t.solo++; }
      if (s.won && (s.firstLossDay === null || s.firstLossDay > g.endDay)) t.wbl++;
      t.final += s.finalScore;
      if (s.reachedDay !== null) { t.reach++; t.reachDay += s.reachedDay; }
      t.recDays += s.recoveryDays;
      t.days += g.endDay;
      recDays += s.recoveryDays;
      playerDays += g.endDay;
      if (s.maxDrawdown >= DRAWDOWN_X) {
        ddPlayers++;
        if (s.won) ddWon++;
        if (s.reachedDay !== null) ddReached++;
        if (s.strategy !== 'instant') {
          exPlayers++;
          if (s.won) exWon++;
          if (s.reachedDay !== null) exReached++;
        }
      }
    }
  }
  const totalActs = Object.values(acts).reduce((a, b) => a + b, 0);
  const actionRate: Record<string, number> = {};
  const categoryRate: Record<string, number> = {};
  for (const id of ACTION_IDS) {
    const rate = (acts[id] ?? 0) / totalActs;
    actionRate[id] = r3(rate);
    const c = getAction(id).category;
    categoryRate[c] = (categoryRate[c] ?? 0) + rate;
  }
  for (const k of Object.keys(categoryRate)) categoryRate[k] = r3(categoryRate[k]);
  const strategies: Record<string, StrategyStats> = {};
  for (const [k, t] of Object.entries(st)) {
    strategies[k] = {
      games: t.games,
      wins: t.wins,
      winRate: r3(t.wins / t.games),
      soloWins: t.solo,
      avgFinal: Math.round((t.final / t.games) * 10) / 10,
      reachRate: r3(t.reach / t.games),
      avgReachDay: t.reach ? Math.round((t.reachDay / t.reach) * 100) / 100 : null,
      recoveryDayRate: r3(t.recDays / t.days),
      winBeforeLossRate: r3(t.wbl / t.games),
    };
  }
  const n = games.length;
  return {
    games: n,
    jointWinRate: r3(joint / n),
    avgEndDay: Math.round((endSum / n) * 100) / 100,
    endDayDist,
    day10Rate: r3((endDayDist[GAME_CONSTANTS.maxDays] ?? 0) / n),
    strategies,
    actionRate,
    categoryRate,
    recoverySlotRate: r3(((acts.rest ?? 0) + (acts.meditate ?? 0) + (acts.detox ?? 0) + (acts.change_env ?? 0)) / totalActs),
    recoveryDayRate: r3(recDays / playerDays),
    nightComebacksPerGame: r3(comebacks / n),
    gamesWithNightComeback: r3(withComeback / n),
    finalNightComebackRate: r3(finalCb / n),
    lossRecovery: { x: DRAWDOWN_X, players: ddPlayers, wonRate: ddPlayers ? r3(ddWon / ddPlayers) : 0, reachedRate: ddPlayers ? r3(ddReached / ddPlayers) : 0 },
    lossRecoveryExInstant: { x: DRAWDOWN_X, players: exPlayers, wonRate: exPlayers ? r3(exWon / exPlayers) : 0, reachedRate: exPlayers ? r3(exReached / exPlayers) : 0 },
  };
}
