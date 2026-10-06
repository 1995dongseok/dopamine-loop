// 봇이 계획을 세울 때 쓰는 "예상치" 계산. 실제 정산은 항상 규칙 함수(resolveDay)가 한다.
// 여기서는 ACTION_DATA 수치를 읽어 다음 사용의 기대 점수만 추정한다 (상태 변경 없음).
import { ACTION_IDS, type ActionId, type Counts, type PlayerRuleState } from '../src/shared/types';
import { ACTION_DATA as D, getAction } from '../src/shared/rules';

export const INSTANT: ActionId[] = ['drink', 'smoke', 'gamble', 'sns', 'shopping', 'binge_game'];
export const STABLE: ActionId[] = ['walk', 'music', 'cook', 'friends', 'volunteer'];
export const GROWTH: ActionId[] = ['study', 'exercise', 'project', 'create', 'relationship'];
export const RECOVERY: ActionId[] = ['rest', 'meditate', 'detox', 'change_env'];
export const HABIT_ACTIONS: ActionId[] = ACTION_IDS.filter((id) => getAction(id).formsHabit);

/** 계획 중인 하루의 가상 상태 (낮 시작 기준: 하루 기록 초기화) */
export interface PlanState {
  score: number;
  uses: Counts;
  habits: Counts;
  daily: Counts;
  streak: ActionId | null;
  studyHigh: boolean;
}

export function planStateOf(p: PlayerRuleState): PlanState {
  return { score: p.score, uses: { ...p.uses }, habits: { ...p.habits }, daily: {}, streak: null, studyHigh: false };
}

function stage<S extends { from: number; to: number | null }>(stages: S[], use: number): S {
  return stages.find((s) => use >= s.from && (s.to === null || use <= s.to)) ?? stages[stages.length - 1];
}

export interface EvCtx {
  phase: 'day' | 'night';
  /** 낮 슬롯 시작 시 최저 점수일 것으로 보는지 */
  lowest?: boolean;
  /** 친구 만나기 보너스를 받을 확률 추정 */
  friendsChance?: number;
}

/** 다음 1회 사용의 기대 점수 (하한 보정 무시) */
export function ev(ps: PlanState, id: ActionId, ctx: EvCtx): number {
  const use = (ps.uses[id] ?? 0) + 1;
  const daily = ps.daily[id] ?? 0;
  switch (id) {
    case 'drink': case 'smoke': case 'sns': case 'exercise':
      return stage(D[id].stages, use).score;
    case 'gamble': {
      const s = stage(D.gamble.stages, use);
      return s.winChance * s.win + (1 - s.winChance) * s.loss;
    }
    case 'shopping': return stage(D.shopping.stages, use).score + (daily > 0 ? D.shopping.sameDayPenalty : 0);
    case 'binge_game': return stage(D.binge_game.stages, use).score + (ps.streak === 'binge_game' ? D.binge_game.streakPenalty : 0);
    case 'walk': return D.walk.score;
    case 'music': return D.music.score + (ctx.phase === 'night' ? D.music.nightBonus : 0);
    case 'cook': return D.cook.score + (daily === 0 ? D.cook.firstOfDayBonus : 0);
    case 'friends': return D.friends.score + (ctx.phase === 'day' ? (ctx.friendsChance ?? 0) * D.friends.bonus : 0);
    case 'volunteer': return D.volunteer.score + (ctx.phase === 'day' && ctx.lowest ? D.volunteer.bonus : 0);
    case 'study': {
      const s = stage(D.study.stages, use);
      return s.high && ps.studyHigh ? D.study.baseScore : s.score;
    }
    case 'project': return D.project.score + (use % D.project.every === 0 ? D.project.bonus : 0);
    case 'create': return D.create.score + Math.min(D.create.chancePerUse * use, D.create.chanceCap) * D.create.bonus;
    case 'relationship': {
      const s = stage(D.relationship.stages, use);
      return s.score + (use === s.from ? s.reachBonus : 0);
    }
    case 'rest': return D.rest.score;
    case 'meditate': return D.meditate.score;
    case 'detox': return D.detox.score;
    case 'change_env': return D.change_env.score;
  }
}

/** 가상 상태에 낮 행동 1개를 반영 (계획 수립용) */
export function applyPlanned(ps: PlanState, id: ActionId, target?: ActionId): void {
  const meta = getAction(id);
  ps.score = Math.max(0, ps.score + ev(ps, id, { phase: 'day' }));
  if (id === 'study' && stage(D.study.stages, (ps.uses.study ?? 0) + 1).high) ps.studyHigh = true;
  ps.uses[id] = (ps.uses[id] ?? 0) + 1;
  ps.daily[id] = (ps.daily[id] ?? 0) + 1;
  ps.streak = meta.category === 'recovery' ? null : id;
  if (meta.formsHabit) ps.habits[id] = (ps.habits[id] ?? 0) + 1;
  const h = (k: ActionId, f: (x: number) => number) => { ps.habits[k] = Math.max(0, f(ps.habits[k] ?? 0)); };
  if (target) {
    if (id === 'walk') h(target, (x) => x + D.walk.targetHabitDelta);
    if (id === 'rest') h(target, (x) => x + D.rest.targetHabitDelta);
    if (id === 'meditate') h(target, (x) => x + D.meditate.targetHabitDelta);
    if (id === 'change_env') h(target, () => 0);
  }
  if (id === 'detox') for (const [k, v] of Object.entries(D.detox.habitDeltas)) h(k as ActionId, (x) => x + (v ?? 0));
}

export function habitTotal(habits: Counts): number {
  return HABIT_ACTIONS.reduce((a, id) => a + Math.max(0, habits[id] ?? 0), 0);
}

/** 밤 1회 추첨의 기대 점수 (현재 습관·사용 횟수 기준 근사) */
export function nightEv(ps: PlanState): number {
  const total = habitTotal(ps.habits);
  if (total <= 0) return 0;
  let s = 0;
  for (const id of HABIT_ACTIONS) {
    const h = ps.habits[id] ?? 0;
    if (h > 0) s += (h / total) * ev(ps, id, { phase: 'night' });
  }
  return s;
}

/** 밤에 나오면 손해(기대 점수 ≤ 0)인 습관들의 비중과 가장 큰 것 */
export function badHabits(ps: PlanState, threshold = 0): { share: number; worst: ActionId | null; worstHabit: number } {
  const total = habitTotal(ps.habits);
  let bad = 0;
  let worst: ActionId | null = null;
  let worstScore = Infinity;
  let worstHabit = 0;
  for (const id of HABIT_ACTIONS) {
    const h = ps.habits[id] ?? 0;
    if (h <= 0) continue;
    const v = ev(ps, id, { phase: 'night' });
    if (v <= threshold) {
      bad += h;
      // 손해 크기 × 습관이 가장 큰 것을 우선 제거
      const sc = v * h;
      if (sc < worstScore) { worstScore = sc; worst = id; worstHabit = h; }
    }
  }
  return { share: total > 0 ? bad / total : 0, worst, worstHabit };
}
