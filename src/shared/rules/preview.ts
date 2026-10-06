// 카드 표시·예상 밤 확률. 상태를 변경하지 않는다.
import type { ActionId, ActionPreview, Counts, Plan, PlanSlot, PlayerRuleState } from '../types';
import { ACTION_DATA as D, RULE_DATA as R, type Stage } from './actionData';
import { STUDY_HIGH_FLAG, applyAction, applyNoAction, dayHabitOps, earlyInstantBonus, fatigueNote, isFatigued } from './effects';
import { GAME_CONSTANTS } from './constants';
import { findStage, getAction, isActionId, sign } from './meta';
import { cloneState, resetDaily } from './state';
import { habitDistribution } from './resolve';
import { normalizePlan } from './validate';

const pct = (p: number): string => `${Math.round(p * 100)}%`;

function stageLabel<S extends { from: number; to: number | null }>(stages: S[], use: number, valueOf: (s: S) => string): string {
  const s = findStage(stages, use);
  const idx = stages.indexOf(s);
  const nextStage = stages[idx + 1];
  const head = `${idx + 1}단계`;
  return nextStage ? `${head} · ${nextStage.from}회째부터 ${valueOf(nextStage)}` : `${head} · 최종 단계`;
}
const scoreOf = (s: Stage): string => sign(s.score);

/**
 * 유형 공통 규칙을 미리보기에 반영한다.
 * - 같은 날 반복 피로: player.dailyUses 기준으로 이번 사용이 피로면 결과를 피로 점수 하나로 확정.
 * - 초반 도파민 보너스(day가 주어지고 즉시 행동일 때): 결과 범위의 양수 끝값에 보너스를 더한다
 *   (즉시 행동의 결과는 최대 두 가지이므로 끝값별 적용이 정확하다).
 */
function applyCommonRules(player: PlayerRuleState, pv: ActionPreview, day: number | undefined): ActionPreview {
  const category = getAction(pv.actionId).category;
  const dailyN = (player.dailyUses?.[pv.actionId] ?? 0) + 1;
  if (isFatigued(category, dailyN)) {
    const v = R.sameDayFatigue.score;
    return { ...pv, min: v, max: v, label: `${fatigueNote(dailyN)} (단계·보너스 없음)` };
  }
  const bonus = category === 'instant' ? earlyInstantBonus(day) : 0;
  if (bonus <= 0) return pv;
  const add = (v: number): number => (v > 0 ? v + bonus : v);
  return { ...pv, min: add(pv.min), max: add(pv.max), label: `${pv.label} · 초반 보너스 ${sign(bonus)}(양수일 때)` };
}

/**
 * 이 행동을 다음에 쓸 때의 결과 범위. 상황에 따라 달라지는 보너스·감점(같은 날 재사용, 연속, 밤 보너스,
 * 공동 보너스, 확률, 하루 1회 고단계)은 min~max 범위에 포함하고 label에 조건을 적는다.
 * 같은 날 반복 피로는 player.dailyUses로 판정한다. day(현재 일차)를 주면 초반 도파민 보너스를 반영한다.
 */
export function previewAction(player: PlayerRuleState, actionId: ActionId, day?: number): ActionPreview {
  return applyCommonRules(player, rawPreview(player, actionId), day);
}

/** 행동별 규칙만 반영한 결과 범위 (유형 공통 규칙 제외) */
function rawPreview(player: PlayerRuleState, actionId: ActionId): ActionPreview {
  const use = (player.uses?.[actionId] ?? 0) + 1;
  const r = (min: number, max: number, label: string): ActionPreview => ({ actionId, nextUse: use, min, max, label });

  switch (actionId) {
    case 'drink':
    case 'smoke':
    case 'sns':
    case 'exercise': {
      const stages = D[actionId].stages;
      const v = findStage(stages, use).score;
      return r(v, v, stageLabel(stages, use, scoreOf));
    }
    case 'gamble': {
      const s = findStage(D.gamble.stages, use);
      return r(s.loss, s.win, `승률 ${pct(s.winChance)} · ${stageLabel(D.gamble.stages, use, (n) => `승률 ${pct(n.winChance)}`)}`);
    }
    case 'shopping': {
      const v = findStage(D.shopping.stages, use).score;
      return r(v + D.shopping.sameDayPenalty, v, `${stageLabel(D.shopping.stages, use, scoreOf)} · 같은 날 재사용 ${sign(D.shopping.sameDayPenalty)}`);
    }
    case 'binge_game': {
      const v = findStage(D.binge_game.stages, use).score;
      return r(v + D.binge_game.streakPenalty, v, `${stageLabel(D.binge_game.stages, use, scoreOf)} · 연속 사용 ${sign(D.binge_game.streakPenalty)}`);
    }
    case 'walk': return r(D.walk.score, D.walk.score, `고정 · 낮에 대상 습관 ${sign(D.walk.targetHabitDelta)}`);
    case 'music': return r(D.music.score, D.music.score + D.music.nightBonus, `고정 · 밤 ${sign(D.music.nightBonus)}`);
    case 'cook': return r(D.cook.score, D.cook.score + D.cook.firstOfDayBonus, `고정 · 그날 첫 사용 ${sign(D.cook.firstOfDayBonus)}`);
    case 'friends': return r(D.friends.score, D.friends.score + D.friends.bonus, `고정 · 같은 슬롯 ${D.friends.minPlayers}명↑ ${sign(D.friends.bonus)}`);
    case 'volunteer': return r(D.volunteer.score, D.volunteer.score + D.volunteer.bonus, `고정 · 최저 점수면 ${sign(D.volunteer.bonus)}`);
    case 'study': {
      const s = findStage(D.study.stages, use);
      const label = stageLabel(D.study.stages, use, scoreOf);
      if (!s.high) return r(s.score, s.score, label);
      return r(D.study.baseScore, s.score, `${label} · 고단계 하루 1회`);
    }
    case 'project': {
      const bonus = use % D.project.every === 0;
      const v = D.project.score + (bonus ? D.project.bonus : 0);
      const at = Math.ceil(use / D.project.every) * D.project.every;
      return r(v, v, bonus ? `이번에 완료 보너스 ${sign(D.project.bonus)}` : `${at}회째 완료 ${sign(D.project.bonus)}`);
    }
    case 'create': {
      const chance = Math.min(D.create.chancePerUse * use, D.create.chanceCap);
      return r(D.create.score, D.create.score + D.create.bonus, `완성 확률 ${pct(chance)}`);
    }
    case 'relationship': {
      const s = findStage(D.relationship.stages, use);
      const v = s.score + (use === s.from ? s.reachBonus : 0);
      return r(v, v, stageLabel(D.relationship.stages, use, (n) => `${sign(n.score)}, 도달 ${sign(n.reachBonus)}`));
    }
    case 'rest': return r(D.rest.score, D.rest.score, `낮에 대상 습관 ${sign(D.rest.targetHabitDelta)}`);
    case 'meditate': return r(D.meditate.score, D.meditate.score, `낮에 대상 습관 ${sign(D.meditate.targetHabitDelta)}`);
    case 'detox': return r(D.detox.score, D.detox.score, '낮에 SNS·게임 습관 감소');
    case 'change_env': return r(D.change_env.score, D.change_env.score, '행동력 2 · 대상 습관 0으로');
  }
}

/** 낮 계획이 습관에 주는 변화를 슬롯 순서대로 적용한 습관 (상태 불변) */
export function habitsAfterPlan(player: PlayerRuleState, plan?: Plan | null): Counts {
  const habits: Counts = { ...(player.habits ?? {}) };
  const p = plan ? normalizePlan(plan) : null;
  if (!p) return habits;
  for (const s of p.slots) {
    if (!s) continue;
    for (const op of dayHabitOps(s.actionId, s.targetId)) habits[op.id] = Math.max(0, op.apply(habits[op.id] ?? 0));
  }
  return habits;
}

/** 예상 밤 확률: 현재 습관에 계획(낮 실행분 습관 증가·회복 감소)을 반영한 분포. 0~1, 0인 행동은 생략 */
export function nightOdds(player: PlayerRuleState, plan?: Plan | null): Counts {
  return habitDistribution(habitsAfterPlan(player, plan));
}

/** 미리보기 시뮬레이션용: 점수 부분에만 영향을 주는 난수 (사용 횟수·습관·연속·하루 기록에는 영향 없음) */
const PREVIEW_RNG = { next: () => 0.5 };

/**
 * 오늘 계획에서 앞 칸들(plannedSlotsBefore: 0번 칸부터 순서대로, null=무행동 또는 비용 2가 소비한 칸)을
 * 실제 규칙 처리(낮 시작 초기화 → 앞 칸 적용)로 시뮬레이션한 상태. 입력을 변경하지 않는다.
 * 점수는 공동 효과·확률 결과를 알 수 없으므로 의미가 없다(사용 횟수·하루 횟수·연속·하루 기록·습관만 정확).
 */
export function stateBeforePlannedSlot(player: PlayerRuleState, plannedSlotsBefore: (PlanSlot | null)[]): PlayerRuleState {
  const p = cloneState(player);
  resetDaily(p);
  plannedSlotsBefore.slice(0, 3).forEach((s, i) => {
    if (s && isActionId(s.actionId)) applyAction(p, s.actionId, s.targetId, 'day', i, { friendsCount: 1, isLowest: false }, PREVIEW_RNG);
    else applyNoAction(p, 'day', i, '무행동');
  });
  return p;
}

/**
 * 오늘 계획의 앞 칸들 다음에 이 행동을 낮에 실행할 때의 결과 범위.
 * 하루 횟수·연속 사용·하루 1회 고단계·같은 날 반복 피로처럼 앞 칸으로 확정되는 조건은 정확히 반영하고,
 * 공동 보너스(친구·봉사)와 확률 결과(도박·창작)만 min~max 범위로 남긴다. 밤 보너스는 낮 실행이므로 제외.
 * day(현재 일차)를 주면 초반 도파민 보너스를 반영한다.
 */
export function previewPlannedAction(
  player: PlayerRuleState, actionId: ActionId, plannedSlotsBefore: (PlanSlot | null)[], day?: number,
): ActionPreview {
  const p = stateBeforePlannedSlot(player, plannedSlotsBefore);
  const pv = applyCommonRules(p, plannedRawPreview(p, actionId), day);
  // 낮 칸으로는 피로에 닿지 않아도 밤 추첨까지 합치면 닿을 수 있으면 알려 준다
  const dailyN = (p.dailyUses[actionId] ?? 0) + 1;
  const cat = getAction(actionId).category;
  const from = R.sameDayFatigue.fromDailyUse;
  if (!isFatigued(cat, dailyN) && isFatigued(cat, dailyN + GAME_CONSTANTS.nightDraws)) {
    return { ...pv, label: `${pv.label} · 밤에도 나오면 같은 날 ${from}회째부터 피로` };
  }
  return pv;
}

/** 앞 칸이 반영된 상태 p에서 행동별 규칙만 반영한 결과 범위 */
function plannedRawPreview(p: PlayerRuleState, actionId: ActionId): ActionPreview {
  const base = rawPreview(p, actionId);
  const use = base.nextUse;
  const r = (min: number, max: number, label: string): ActionPreview => ({ actionId, nextUse: use, min, max, label });
  const daily = p.dailyUses[actionId] ?? 0;

  switch (actionId) {
    case 'shopping': {
      const v = findStage(D.shopping.stages, use).score;
      const stage = stageLabel(D.shopping.stages, use, scoreOf);
      return daily > 0
        ? r(v + D.shopping.sameDayPenalty, v + D.shopping.sameDayPenalty, `${stage} · 같은 날 재사용 ${sign(D.shopping.sameDayPenalty)} 적용`)
        : r(v, v, `${stage} · 같은 날 재사용 시 ${sign(D.shopping.sameDayPenalty)}`);
    }
    case 'binge_game': {
      const v = findStage(D.binge_game.stages, use).score;
      const stage = stageLabel(D.binge_game.stages, use, scoreOf);
      return p.streakAction === 'binge_game'
        ? r(v + D.binge_game.streakPenalty, v + D.binge_game.streakPenalty, `${stage} · 연속 사용 ${sign(D.binge_game.streakPenalty)} 적용`)
        : r(v, v, `${stage} · 연속 사용 시 ${sign(D.binge_game.streakPenalty)}`);
    }
    case 'music': return r(D.music.score, D.music.score, `고정 · 밤에 뽑히면 ${sign(D.music.nightBonus)}`);
    case 'cook':
      return daily === 0
        ? r(D.cook.score + D.cook.firstOfDayBonus, D.cook.score + D.cook.firstOfDayBonus, `고정 · 오늘 첫 요리 ${sign(D.cook.firstOfDayBonus)} 포함`)
        : r(D.cook.score, D.cook.score, '고정 · 오늘 첫 요리 보너스 사용함');
    case 'study': {
      const s = findStage(D.study.stages, use);
      const label = stageLabel(D.study.stages, use, scoreOf);
      if (!s.high) return r(s.score, s.score, label);
      return p.flags[STUDY_HIGH_FLAG]
        ? r(D.study.baseScore, D.study.baseScore, `${label} · 오늘 고단계 사용함: 기본`)
        : r(s.score, s.score, `${label} · 고단계 하루 1회`);
    }
    default:
      // 그 밖의 행동은 하루 기록과 무관하거나(누적 단계·고정) 범위가 본질적(확률·공동 보너스)이다
      return base;
  }
}
