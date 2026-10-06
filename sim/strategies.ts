// 봇 전략. 각 전략은 (자기 상태, 전체 상태, 일차, 난수) → 유효한 Plan 을 만든다.
// 실제 결과는 규칙 함수가 계산하고, 봇은 model.ts 의 예상치만 보고 고른다.
import type { ActionId, Plan, PlanSlot, PlayerRuleState, Rng } from '../src/shared/types';
import { GAME_CONSTANTS, getAction } from '../src/shared/rules';
import {
  GROWTH, INSTANT, STABLE, applyPlanned, badHabits, ev, nightEv, planStateOf, type PlanState,
} from './model';

export interface BotCtx {
  me: PlayerRuleState;
  players: PlayerRuleState[];
  day: number;
  rng: Rng;
}

export interface Strategy {
  id: string;
  label: string;
  description: string;
  plan: (ctx: BotCtx) => Plan;
}

/** 슬롯을 앞에서부터 채우는 계획 작성기. 친구 만나기는 관례상 가운데 칸(슬롯 1)에 둔다. */
class Builder {
  slots: (PlanSlot | null)[] = [null, null, null];
  i = 0;
  ps: PlanState;
  constructor(me: PlayerRuleState, day: number) { this.ps = planStateOf(me, day); }
  get free(): number { return 3 - this.i; }
  add(actionId: ActionId, targetId?: ActionId): this {
    const cost = getAction(actionId).cost;
    if (this.free < cost) return this;
    this.slots[this.i] = targetId ? { actionId, targetId } : { actionId };
    this.i += cost;
    applyPlanned(this.ps, actionId, targetId);
    return this;
  }
  plan(): Plan { return { slots: [this.slots[0], this.slots[1], this.slots[2]] }; }
}

const isLowest = (ctx: BotCtx): boolean => {
  const active = ctx.players.filter((p) => !p.forfeited);
  return ctx.me.score <= Math.min(...active.map((p) => p.score));
};

/** 가장 기대 점수가 높은 행동 (동점이면 목록 앞쪽) */
function bestOf(ps: PlanState, list: ActionId[], ctx: Parameters<typeof ev>[2]): { id: ActionId; v: number } {
  let id = list[0];
  let v = -Infinity;
  for (const a of list) {
    const x = ev(ps, a, ctx);
    if (x > v) { v = x; id = a; }
  }
  return { id, v };
}

/** 즉시 행동 중 기대 점수 최대인 것을 슬롯마다 고른다 (회복 없음) */
function instantSlot(b: Builder): void {
  b.add(bestOf(b.ps, INSTANT, { phase: 'day' }).id);
}

/** 손해 습관이 위험 수준이면 회복 1칸(필요하면 환경 바꾸기 2칸)을 쓴다. 썼으면 true */
function recoverIfRisky(b: Builder, shareLimit: number): boolean {
  const bad = badHabits(b.ps);
  if (!bad.worst || bad.share < shareLimit) return false;
  if (bad.worstHabit >= 4 && b.free >= 2) b.add('change_env', bad.worst);
  else if (bad.worstHabit >= 2) b.add('rest', bad.worst);
  else b.add('meditate', bad.worst);
  return true;
}

// ── 전략 ──

const stable: Strategy = {
  id: 'stable',
  label: '안정형 반복',
  description: '매일 [요리(최저 점수면 봉사), 친구 만나기, 음악 감상] 반복',
  plan: (ctx) => new Builder(ctx.me, ctx.day).add(isLowest(ctx) ? 'volunteer' : 'cook').add('friends').add('music').plan(),
};

const growth: Strategy = {
  id: 'growth',
  label: '성장형 집중',
  description: '매일 [공부, 관계·연애, 관계·연애] 반복 (하루 1회 제한이 있는 공부 + 한 성장 행동에 집중)',
  plan: (ctx) => new Builder(ctx.me, ctx.day).add('study').add('relationship').add('relationship').plan(),
};

const instant: Strategy = {
  id: 'instant',
  label: '즉시 보상 순환',
  description: '슬롯마다 즉시 행동 6개 중 다음 회차 기대 점수가 가장 높은 것 (회복 없음)',
  plan: (ctx) => {
    const b = new Builder(ctx.me, ctx.day);
    while (b.free > 0) instantSlot(b);
    return b.plan();
  },
};

const earlyInstant: Strategy = {
  id: 'early_instant',
  label: '초반 즉시 후 성장 전환',
  description: '1~2일째 공부 1칸 + 남은 칸은 기대 점수 ≥5인 즉시 행동(없으면 성장 행동). 3일째부터 밤에 손해인 습관을 하루 1칸 회복(명상/휴식/디톡스/환경 바꾸기)하며 [공부, 프로젝트, 관계]',
  plan: (ctx) => {
    const b = new Builder(ctx.me, ctx.day);
    const growthFill = (): void => { for (const a of ['study', 'project', 'relationship'] as ActionId[]) b.add(a); };
    if (ctx.day <= 2) {
      // 공부로 성장 투자를 시작하고 나머지 칸은 기대 점수 ≥5인 즉시 행동(첫 사용 위주)
      b.add('study');
      while (b.free > 0 && bestOf(b.ps, INSTANT, { phase: 'day' }).v >= 5) instantSlot(b);
      growthFill();
      return b.plan();
    }
    // 밤에 손해인 습관을 하루 1번 회복 (SNS·게임이 함께 손해면 디지털 디톡스, 크면 환경 바꾸기)
    const bad = badHabits(b.ps);
    if (bad.worst) {
      const snsBad = ev(b.ps, 'sns', { phase: 'night' }) <= 0 ? b.ps.habits.sns ?? 0 : 0;
      const gameBad = ev(b.ps, 'binge_game', { phase: 'night' }) <= 0 ? b.ps.habits.binge_game ?? 0 : 0;
      if (snsBad > 0 && gameBad > 0) b.add('detox');
      else if (bad.worstHabit >= 4) b.add('change_env', bad.worst);
      else if (bad.worstHabit >= 2) b.add('rest', bad.worst);
      else b.add('meditate', bad.worst);
    }
    growthFill();
    return b.plan();
  },
};

const mixed: Strategy = {
  id: 'mixed',
  label: '위험 증가 시 회복 혼합',
  description: '높은 초반 즉시 보상(기대 ≥5)은 하루 1개까지 쓰고, 손해 습관 비중 ≥30%면 명상/휴식/환경 바꾸기, 나머지는 [공부, 요리, 음악]',
  plan: (ctx) => {
    const b = new Builder(ctx.me, ctx.day);
    recoverIfRisky(b, 0.3);
    const inst = bestOf(b.ps, INSTANT, { phase: 'day' });
    if (b.free > 0 && inst.v >= 5) b.add(inst.id);
    for (const a of ['study', isLowest(ctx) ? 'volunteer' : 'cook', 'music'] as ActionId[]) b.add(a);
    return b.plan();
  },
};

/** 탐욕형: (이번 낮 기대 점수) + (습관 변화로 생기는 밤 기대 점수 변화 × 남은 일수 가중) 최대 */
const greedy: Strategy = {
  id: 'greedy',
  label: '기대값 탐욕형',
  description: '슬롯마다 낮 기대 점수 + 밤 기대 점수 변화(남은 일수 가중, 최대 3일)를 최대화. 회복 포함',
  plan: (ctx) => {
    const b = new Builder(ctx.me, ctx.day);
    const remaining = GAME_CONSTANTS.maxDays - ctx.day + 1;
    const w = 2 * Math.min(3, remaining); // 하루 밤 2회 × 가중 일수
    const lowest = isLowest(ctx);
    const candidates: { id: ActionId; target?: ActionId }[] = [
      ...[...INSTANT, ...STABLE.filter((a) => a !== 'walk'), ...GROWTH].map((id) => ({ id })),
    ];
    while (b.free > 0) {
      const bad = badHabits(b.ps);
      const opts = [...candidates];
      if (bad.worst) {
        opts.push({ id: 'rest', target: bad.worst }, { id: 'meditate', target: bad.worst }, { id: 'walk', target: bad.worst });
        if (b.free >= 2) opts.push({ id: 'change_env', target: bad.worst });
      }
      const base = nightEv(b.ps);
      let best = opts[0];
      let bestV = -Infinity;
      for (const o of opts) {
        const tmp: PlanState = { ...b.ps, uses: { ...b.ps.uses }, habits: { ...b.ps.habits }, daily: { ...b.ps.daily } };
        const dayV = ev(tmp, o.id, { phase: 'day', lowest: lowest && b.i === 0, friendsChance: 0 });
        applyPlanned(tmp, o.id, o.target);
        const cost = getAction(o.id).cost;
        const v = (dayV + (nightEv(tmp) - base) * w) / cost;
        if (v > bestV) { bestV = v; best = o; }
      }
      b.add(best.id, best.target);
    }
    return b.plan();
  },
};

/** 한 행동만 매일 3칸 반복 (집중 습관 → 밤 추첨도 같은 행동으로 몰리는지 점검용) */
const repeat = (id: ActionId, label: string): Strategy => ({
  id: `repeat_${id}`,
  label: `${label}만 반복`,
  description: `매일 [${label}, ${label}, ${label}] 반복`,
  plan: (ctx) => new Builder(ctx.me, ctx.day).add(id).add(id).add(id).plan(),
});

export const STRATEGIES: Strategy[] = [
  stable, growth, instant, earlyInstant, mixed, greedy,
  repeat('relationship', '관계·연애'), repeat('exercise', '운동'), repeat('study', '공부'), repeat('music', '음악 감상'),
];
export const STRATEGY_BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));
