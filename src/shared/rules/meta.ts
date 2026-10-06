// ACTIONS 메타데이터. 카드 설명은 actionData의 수치에서 생성하므로 항상 실제 효과와 일치한다.
import { ACTION_IDS, type ActionId, type ActionMeta } from '../types';
import { ACTION_BASE, ACTION_DATA as D, RULE_DATA as R, type Stage } from './actionData';

export const sign = (n: number): string => (n > 0 ? `+${n}` : `${n}`);
const pct = (p: number): string => `${Math.round(p * 100)}%`;
const range = (s: { from: number; to: number | null }): string =>
  s.to === null ? `${s.from}회~` : s.from === s.to ? `${s.from}회` : `${s.from}~${s.to}회`;
const stagesText = (stages: Stage[]): string => stages.map((s) => `${range(s)} ${sign(s.score)}`).join(' → ');

const nameOf = (id: ActionId): string => ACTION_BASE.find((a) => a.id === id)!.name;

function describe(id: ActionId): string {
  switch (id) {
    case 'drink': return stagesText(D.drink.stages);
    case 'smoke': return stagesText(D.smoke.stages);
    case 'gamble':
      return D.gamble.stages.map((s) => `${range(s)} ${pct(s.winChance)} ${sign(s.win)}/${sign(s.loss)}`).join(' → ');
    case 'sns': return stagesText(D.sns.stages);
    case 'shopping': return `${stagesText(D.shopping.stages)}, 같은 날 재사용 ${sign(D.shopping.sameDayPenalty)}`;
    case 'binge_game': return `${stagesText(D.binge_game.stages)}, 연속 사용 ${sign(D.binge_game.streakPenalty)}`;
    case 'walk': return `${sign(D.walk.score)}, 낮에 대상 습관 ${sign(D.walk.targetHabitDelta)}`;
    case 'music': return `${sign(D.music.score)}, 밤에 나오면 ${sign(D.music.nightBonus)} 추가`;
    case 'cook': return `${sign(D.cook.score)}, 그날 첫 사용 ${sign(D.cook.firstOfDayBonus)} 추가`;
    case 'friends': return `${sign(D.friends.score)}, 낮 같은 슬롯에 ${D.friends.minPlayers}명 이상이면 각 ${sign(D.friends.bonus)}`;
    case 'volunteer': return `${sign(D.volunteer.score)}, 낮 슬롯 시작 때 최저 점수(동점 포함)면 ${sign(D.volunteer.bonus)}`;
    case 'study': {
      const high = D.study.stages.filter((s) => s.high).map((s) => sign(s.score)).join('·');
      return `${stagesText(D.study.stages)} (${high} 보상은 하루 1회, 이후 ${sign(D.study.baseScore)})`;
    }
    case 'exercise': return `${stagesText(D.exercise.stages)}, 하루 1회 제한 없음`;
    case 'project': return `${sign(D.project.score)}, 누적 ${D.project.every}의 배수 회째 완료 ${sign(D.project.bonus)}`;
    case 'create':
      return `${sign(D.create.score)}, 완성 ${sign(D.create.bonus)} 확률 회차×${pct(D.create.chancePerUse)} (최대 ${pct(D.create.chanceCap)})`;
    case 'relationship': {
      const reach = D.relationship.stages.filter((s) => s.reachBonus > 0).map((s) => `${s.from}회 ${sign(s.reachBonus)}`).join(', ');
      return `${stagesText(D.relationship.stages)}, 단계 도달 ${reach}`;
    }
    case 'rest': return `점수 ${D.rest.score}, 낮에 대상 습관 ${sign(D.rest.targetHabitDelta)}`;
    case 'meditate': return `${sign(D.meditate.score)}, 낮에 대상 습관 ${sign(D.meditate.targetHabitDelta)}`;
    case 'detox': {
      const parts = Object.entries(D.detox.habitDeltas).map(([k, v]) => `${nameOf(k as ActionId)} ${sign(v!)}`).join('·');
      return `점수 ${D.detox.score}, 낮에 습관 ${parts}`;
    }
    case 'change_env': return `행동력 2, 점수 ${D.change_env.score}, 낮에 대상 습관을 0으로`;
  }
}

/** 유형 공통 규칙 문구: 즉시 = 초반 도파민 보너스, 안정·성장 = 같은 날 반복 피로 */
function commonRuleText(category: ActionMeta['category']): string {
  if (category === 'instant') {
    const b = R.instantEarlyBonus.filter((v) => v > 0);
    if (!b.length) return '';
    const days = b.length === 1 ? '1일째' : `1~${b.length}일째`;
    return ` · 초반 보너스: ${days} 결과가 양수면 ${b.map(sign).join('/')}`;
  }
  if (category === 'stable' || category === 'growth') {
    return ` · 같은 날 ${R.sameDayFatigue.fromDailyUse}회째부터 피로: ${sign(R.sameDayFatigue.score)}만`;
  }
  return '';
}

export const ACTIONS: ActionMeta[] = ACTION_BASE.map((b) => ({
  ...b,
  formsHabit: b.category !== 'recovery',
  description: describe(b.id) + commonRuleText(b.category),
}));

const BY_ID = new Map<string, ActionMeta>(ACTIONS.map((a) => [a.id, a]));

export function isActionId(v: unknown): v is ActionId {
  return typeof v === 'string' && (ACTION_IDS as readonly string[]).includes(v);
}

export function getAction(id: ActionId): ActionMeta {
  const a = BY_ID.get(id);
  if (!a) throw new Error(`unknown action: ${String(id)}`);
  return a;
}

export function findStage<S extends { from: number; to: number | null }>(stages: S[], use: number): S {
  return stages.find((s) => use >= s.from && (s.to === null || use <= s.to)) ?? stages[stages.length - 1];
}
