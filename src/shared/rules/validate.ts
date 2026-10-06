import type { Plan, PlanSlot, PlanValidation } from '../types';
import { GAME_CONSTANTS } from './constants';
import { getAction, isActionId } from './meta';

const fail = (reason: string): PlanValidation => ({ ok: false, reason });

/**
 * 계획 형식·행동 ID·대상·행동력·비용 2 배치 검사. 어떤 입력에도 throw 하지 않는다.
 * - slots: 길이 정확히 3인 배열, 각 칸은 null 또는 { actionId, targetId? }
 * - needsTarget 행동은 targetId 필수이며 formsHabit 행동이어야 함. 그 외 행동은 targetId 없음(undefined/null만 허용)
 * - 비용 2 행동은 slots[i] (i ≤ 1)에 두고 slots[i+1]은 null
 * - 행동력 합계 ≤ 3
 */
export function validatePlan(plan: unknown): PlanValidation {
  try {
    if (typeof plan !== 'object' || plan === null) return fail('계획 형식이 아닙니다');
    const slots = (plan as { slots?: unknown }).slots;
    if (!Array.isArray(slots) || slots.length !== 3) return fail('슬롯은 정확히 3칸이어야 합니다');
    let total = 0;
    let consumedNext = -1;
    for (let i = 0; i < 3; i++) {
      const s: unknown = slots[i];
      if (s === null) continue;
      if (i === consumedNext) return fail(`${i + 1}번째 칸은 비용 2 행동이 사용 중이어야 합니다`);
      if (typeof s !== 'object' || s === undefined || Array.isArray(s)) return fail(`${i + 1}번째 칸 형식 오류`);
      const { actionId, targetId } = s as { actionId?: unknown; targetId?: unknown };
      if (!isActionId(actionId)) return fail(`${i + 1}번째 칸: 알 수 없는 행동`);
      const meta = getAction(actionId);
      if (meta.needsTarget) {
        if (!isActionId(targetId)) return fail(`${meta.name}: 대상을 지정해야 합니다`);
        if (!getAction(targetId).formsHabit) return fail(`${meta.name}: 습관이 생기는 행동만 대상으로 지정할 수 있습니다`);
      } else if (targetId !== undefined && targetId !== null) {
        return fail(`${meta.name}: 대상을 지정할 수 없는 행동입니다`);
      }
      if (meta.cost === 2) {
        if (i >= 2) return fail(`${meta.name}: 연속 2칸이 필요합니다`);
        if (slots[i + 1] !== null) return fail(`${meta.name}: 다음 칸이 비어 있어야 합니다`);
        consumedNext = i + 1;
      }
      total += meta.cost;
    }
    if (total > GAME_CONSTANTS.actionPoints) return fail('행동력 합계가 3을 넘습니다');
    return { ok: true };
  } catch {
    return fail('계획 형식이 아닙니다');
  }
}

/** 검증된 계획을 정규화된 새 객체로 복사 (불필요한 필드 제거). 유효하지 않으면 null. */
export function normalizePlan(plan: unknown): Plan | null {
  if (!validatePlan(plan).ok) return null;
  const src = (plan as Plan).slots;
  const slots = src.map((s): PlanSlot | null => {
    if (s === null) return null;
    const meta = getAction(s.actionId);
    return meta.needsTarget ? { actionId: s.actionId, targetId: s.targetId } : { actionId: s.actionId };
  });
  return { slots: [slots[0], slots[1], slots[2]] };
}

/** 무행동 계획 (미제출자용) */
export function emptyPlan(): Plan {
  return { slots: [null, null, null] };
}
