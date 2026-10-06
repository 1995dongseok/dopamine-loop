// 행동별 처리 코드. 한 참가자의 한 행동을 (복사된) 상태에 적용하고 ResolutionEvent를 만든다.
import type { ActionId, PlayerRuleState, ResolutionEvent, Rng } from '../types';
import { ACTION_DATA as D } from './actionData';
import { DAILY_FLAG_PREFIX } from './constants';
import { findStage, getAction, sign } from './meta';

export const STUDY_HIGH_FLAG = `${DAILY_FLAG_PREFIX}study_high`;

export type Phase = 'day' | 'night';

/** 같은 슬롯 공동 효과 판정 결과 (슬롯 처리 직전 상태 기준). 밤에는 사용하지 않는다. */
export interface CoopContext {
  /** 이 슬롯에서 친구 만나기를 고른 비기권자 수 (자신 포함) */
  friendsCount: number;
  /** 이 참가자가 슬롯 시작 시 비기권자 중 공동 최저 점수인지 */
  isLowest: boolean;
}

interface Part { value: number; note: string }

const pctText = (p: number): string => `${Math.round(p * 100)}%`;

/** 점수 부분(보상·보너스·감점) 계산. 상태는 읽기만 한다(study flag 제외). */
function scoreParts(
  p: PlayerRuleState, id: ActionId, phase: Phase, coop: CoopContext | null, rng: Rng,
): Part[] {
  const use = (p.uses[id] ?? 0) + 1;
  const daily = p.dailyUses[id] ?? 0;
  const streakSame = p.streakAction === id;
  const staged = (stages: { from: number; to: number | null; score: number }[]): Part => {
    const s = findStage(stages, use);
    return { value: s.score, note: `${use}회째 ${sign(s.score)}` };
  };
  const fixed = (score: number): Part => ({ value: score, note: `기본 ${sign(score)}` });

  switch (id) {
    case 'drink': return [staged(D.drink.stages)];
    case 'smoke': return [staged(D.smoke.stages)];
    case 'sns': return [staged(D.sns.stages)];
    case 'exercise': return [staged(D.exercise.stages)];
    case 'gamble': {
      const s = findStage(D.gamble.stages, use);
      const win = rng.next() < s.winChance;
      return [{ value: win ? s.win : s.loss, note: `${use}회째 ${win ? '승리' : '패배'}(승률 ${pctText(s.winChance)}) ${sign(win ? s.win : s.loss)}` }];
    }
    case 'shopping': {
      const parts = [staged(D.shopping.stages)];
      if (daily > 0) parts.push({ value: D.shopping.sameDayPenalty, note: `같은 날 재사용 ${sign(D.shopping.sameDayPenalty)}` });
      return parts;
    }
    case 'binge_game': {
      const parts = [staged(D.binge_game.stages)];
      if (streakSame) parts.push({ value: D.binge_game.streakPenalty, note: `연속 사용 ${sign(D.binge_game.streakPenalty)}` });
      return parts;
    }
    case 'walk': return [fixed(D.walk.score)];
    case 'music': {
      const parts = [fixed(D.music.score)];
      if (phase === 'night') parts.push({ value: D.music.nightBonus, note: `밤 보너스 ${sign(D.music.nightBonus)}` });
      return parts;
    }
    case 'cook': {
      const parts = [fixed(D.cook.score)];
      if (daily === 0) parts.push({ value: D.cook.firstOfDayBonus, note: `오늘 첫 요리 ${sign(D.cook.firstOfDayBonus)}` });
      return parts;
    }
    case 'friends': {
      const parts = [fixed(D.friends.score)];
      if (phase === 'day' && coop && coop.friendsCount >= D.friends.minPlayers) {
        parts.push({ value: D.friends.bonus, note: `친구 ${coop.friendsCount}명 보너스 ${sign(D.friends.bonus)}` });
      }
      return parts;
    }
    case 'volunteer': {
      const parts = [fixed(D.volunteer.score)];
      if (phase === 'day' && coop && coop.isLowest) {
        parts.push({ value: D.volunteer.bonus, note: `최저 점수 보너스 ${sign(D.volunteer.bonus)}` });
      }
      return parts;
    }
    case 'study': {
      const s = findStage(D.study.stages, use);
      if (!s.high) return [{ value: s.score, note: `${use}회째 ${sign(s.score)}` }];
      if (p.flags[STUDY_HIGH_FLAG]) {
        return [{ value: D.study.baseScore, note: `${use}회째 고단계는 하루 1회: 기본 ${sign(D.study.baseScore)}` }];
      }
      p.flags[STUDY_HIGH_FLAG] = 1;
      return [{ value: s.score, note: `${use}회째 ${sign(s.score)} (오늘 고단계 사용)` }];
    }
    case 'project': {
      const parts = [fixed(D.project.score)];
      if (use % D.project.every === 0) parts.push({ value: D.project.bonus, note: `${use}회째 완료 보너스 ${sign(D.project.bonus)}` });
      return parts;
    }
    case 'create': {
      const chance = Math.min(D.create.chancePerUse * use, D.create.chanceCap);
      const parts = [fixed(D.create.score)];
      if (rng.next() < chance) parts.push({ value: D.create.bonus, note: `완성(확률 ${pctText(chance)}) ${sign(D.create.bonus)}` });
      else parts.push({ value: 0, note: `미완성(확률 ${pctText(chance)})` });
      return parts;
    }
    case 'relationship': {
      const s = findStage(D.relationship.stages, use);
      const idx = D.relationship.stages.indexOf(s);
      const parts: Part[] = [{ value: s.score, note: `${use}회째 ${idx + 1}단계 ${sign(s.score)}` }];
      if (use === s.from && s.reachBonus > 0) parts.push({ value: s.reachBonus, note: `${idx + 1}단계 도달 ${sign(s.reachBonus)}` });
      return parts;
    }
    case 'rest': return D.rest.score ? [fixed(D.rest.score)] : [];
    case 'meditate': return D.meditate.score ? [fixed(D.meditate.score)] : [];
    case 'detox': return D.detox.score ? [fixed(D.detox.score)] : [];
    case 'change_env': return D.change_env.score ? [fixed(D.change_env.score)] : [];
  }
}

export interface HabitOp { id: ActionId; apply: (habit: number) => number }

/**
 * 낮에 실행할 때의 습관 변화 목록 (순서대로 적용, 결과는 0 하한). 자기 습관 +1(일반 행동)이 먼저,
 * 대상 감소가 나중이다. 밤에는 사용하지 않는다. nightOdds 예측도 같은 함수를 쓴다.
 */
export function dayHabitOps(actionId: ActionId, targetId: ActionId | undefined): HabitOp[] {
  const ops: HabitOp[] = [];
  if (getAction(actionId).formsHabit) ops.push({ id: actionId, apply: (h) => h + 1 });
  if (targetId) {
    switch (actionId) {
      case 'walk': ops.push({ id: targetId, apply: (h) => h + D.walk.targetHabitDelta }); break;
      case 'rest': ops.push({ id: targetId, apply: (h) => h + D.rest.targetHabitDelta }); break;
      case 'meditate': ops.push({ id: targetId, apply: (h) => h + D.meditate.targetHabitDelta }); break;
      case 'change_env': ops.push({ id: targetId, apply: () => 0 }); break;
      default: break;
    }
  }
  if (actionId === 'detox') {
    for (const [k, v] of Object.entries(D.detox.habitDeltas)) ops.push({ id: k as ActionId, apply: (h) => h + (v ?? 0) });
  }
  return ops;
}

/**
 * 한 행동을 적용한다 (p를 직접 변경). 순서: 점수(하한 보정) → 사용 횟수·하루 횟수 → 연속 사용
 * → (낮) 자기 습관 +1 → (낮) 대상 습관 감소.
 */
export function applyAction(
  p: PlayerRuleState,
  actionId: ActionId,
  targetId: ActionId | undefined,
  phase: Phase,
  index: number,
  coop: CoopContext | null,
  rng: Rng,
): ResolutionEvent {
  const meta = getAction(actionId);
  const parts = scoreParts(p, actionId, phase, coop, rng);
  const notes = parts.map((x) => x.note);
  const raw = parts.reduce((a, x) => a + x.value, 0);
  const before = p.score;
  p.score = Math.max(0, before + raw);
  if (before + raw < 0) notes.push('점수 하한 0 보정');

  p.uses[actionId] = (p.uses[actionId] ?? 0) + 1;
  p.dailyUses[actionId] = (p.dailyUses[actionId] ?? 0) + 1;

  if (meta.category === 'recovery') {
    p.streakAction = null;
    p.streakCount = 0;
  } else if (p.streakAction === actionId) {
    p.streakCount += 1;
  } else {
    p.streakAction = actionId;
    p.streakCount = 1;
  }

  if (phase === 'day') {
    for (const op of dayHabitOps(actionId, targetId)) {
      const before = p.habits[op.id] ?? 0;
      const after = Math.max(0, op.apply(before));
      p.habits[op.id] = after;
      const diff = after - before;
      notes.push(op.id === actionId
        ? `${meta.name} 습관 ${sign(diff)}`
        : `${meta.name}: ${getAction(op.id).name} 습관 ${diff === 0 ? '변화 없음' : sign(diff)}`);
    }
  }

  return {
    phase,
    index,
    playerId: p.playerId,
    actionId,
    ...(meta.needsTarget && targetId ? { targetId } : {}),
    delta: p.score - before,
    scoreAfter: p.score,
    notes,
  };
}

/** 무행동(또는 비용 2 행동이 소비한 칸). 연속 사용을 끊는다. */
export function applyNoAction(p: PlayerRuleState, phase: Phase, index: number, note: string): ResolutionEvent {
  p.streakAction = null;
  p.streakCount = 0;
  return { phase, index, playerId: p.playerId, actionId: null, delta: 0, scoreAfter: p.score, notes: [note] };
}
