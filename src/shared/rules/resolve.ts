import { ACTION_IDS, type ActionId, type Counts, type DayResult, type Plan, type PlayerRuleState, type ResolutionEvent, type Rng, type WinCheck } from '../types';
import { GAME_CONSTANTS } from './constants';
import { applyAction, applyNoAction } from './effects';
import { getAction } from './meta';
import { cloneState, resetDaily } from './state';
import { emptyPlan, normalizePlan } from './validate';

/** 습관 → 밤 추첨 확률 (0 초과인 행동만). 합계 0이면 빈 객체. */
export function habitDistribution(habits: Counts): Counts {
  let total = 0;
  for (const id of ACTION_IDS) total += Math.max(0, habits[id] ?? 0);
  const out: Counts = {};
  if (total <= 0) return out;
  for (const id of ACTION_IDS) {
    const h = Math.max(0, habits[id] ?? 0);
    if (h > 0) out[id] = h / total;
  }
  return out;
}

/** 습관 가중 복원 추출 1회. 합계 0이면 null. ACTION_IDS 순서로 누적한다. */
function drawHabit(habits: Counts, rng: Rng): ActionId | null {
  let total = 0;
  for (const id of ACTION_IDS) total += Math.max(0, habits[id] ?? 0);
  if (total <= 0) return null;
  let r = rng.next() * total;
  let last: ActionId | null = null;
  for (const id of ACTION_IDS) {
    const h = Math.max(0, habits[id] ?? 0);
    if (h <= 0) continue;
    last = id;
    if (r < h) return id;
    r -= h;
  }
  return last;
}

/**
 * 하루 전체 정산. 처리 순서는 입력 배열 순서와 무관하게 playerId 정렬 순서로 고정한다
 * (같은 시드면 참가자 배열을 섞어도 결과가 같다). 반환 players는 입력과 같은 순서.
 */
export function resolveDay(
  players: PlayerRuleState[],
  plans: Record<string, Plan | null | undefined>,
  day: number,
  rng: Rng,
): { players: PlayerRuleState[]; result: DayResult } {
  const next = players.map(cloneState);
  const active = next
    .filter((p) => !p.forfeited)
    .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));

  for (const p of active) resetDaily(p);
  const planOf = new Map<string, Plan>();
  for (const p of active) {
    const raw = Object.prototype.hasOwnProperty.call(plans ?? {}, p.playerId) ? plans[p.playerId] : null;
    planOf.set(p.playerId, (raw ? normalizePlan(raw) : null) ?? emptyPlan());
  }

  const dayEvents: ResolutionEvent[] = [];
  for (let slot = 0; slot < 3; slot++) {
    // 공동 효과는 이 슬롯 처리 직전 상태로 동시에 판정
    const minScore = active.length ? Math.min(...active.map((p) => p.score)) : 0;
    const lowest = new Set(active.filter((p) => p.score === minScore).map((p) => p.playerId));
    const friendsCount = active.filter((p) => planOf.get(p.playerId)!.slots[slot]?.actionId === 'friends').length;

    for (const p of active) {
      const slots = planOf.get(p.playerId)!.slots;
      const s = slots[slot];
      if (s) {
        dayEvents.push(applyAction(p, s.actionId, s.targetId, 'day', slot, { friendsCount, isLowest: lowest.has(p.playerId) }, rng));
      } else {
        const prev = slot > 0 ? slots[slot - 1] : null;
        const consumed = prev !== null && getAction(prev.actionId).cost === 2;
        dayEvents.push(applyNoAction(p, 'day', slot, consumed ? `${getAction(prev!.actionId).name} 진행 중` : '무행동'));
      }
    }
  }

  const nightOdds: Record<string, Counts> = {};
  const nightEvents: ResolutionEvent[] = [];
  for (const p of active) {
    // 밤에는 습관이 바뀌지 않으므로 분포는 두 번의 추첨 내내 동일
    nightOdds[p.playerId] = habitDistribution(p.habits);
    for (let d = 0; d < GAME_CONSTANTS.nightDraws; d++) {
      const drawn = drawHabit(p.habits, rng);
      if (drawn === null) nightEvents.push(applyNoAction(p, 'night', d, '습관 없음: 무행동'));
      else nightEvents.push(applyAction(p, drawn, undefined, 'night', d, null, rng));
    }
  }

  const scoresAfter: Record<string, number> = {};
  for (const p of next) scoresAfter[p.playerId] = p.score;

  return { players: next, result: { day, dayEvents, nightEvents, nightOdds, scoresAfter } };
}

/**
 * 밤 정산 이후 승리 판정 (기권자 제외).
 * - 비기권자 0명: 종료, 승자 없음 / 1명: 그 참가자 승리
 * - 최고 점수 ≥ 목표: 최고 점수자 전원 승리 (동점 공동)
 * - day ≥ maxDays: 목표 미달이어도 최고 점수자 전원 승리
 */
export function checkWinner(players: PlayerRuleState[], day: number): WinCheck {
  const active = players.filter((p) => !p.forfeited);
  if (active.length === 0) return { finished: true, winnerIds: [] };
  if (active.length === 1) return { finished: true, winnerIds: [active[0].playerId] };
  const max = Math.max(...active.map((p) => p.score));
  if (max >= GAME_CONSTANTS.targetScore || day >= GAME_CONSTANTS.maxDays) {
    return { finished: true, winnerIds: active.filter((p) => p.score === max).map((p) => p.playerId) };
  }
  return { finished: false, winnerIds: [] };
}
