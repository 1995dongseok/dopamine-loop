// 규칙 함수 안전 래퍼와 계획(슬롯) 편집 도우미. 규칙 함수가 아직 미구현이어도 화면이 죽지 않게 한다.
import { ACTIONS, habitsAfterPlan, nightOdds, previewPlannedAction } from '../../shared/rules';
import type {
  ActionCategory, ActionId, ActionMeta, ActionPreview, Counts, Plan, PlanSlot, PlayerRuleState,
} from '../../shared/types';

export const CATEGORY_LABEL: Record<ActionCategory, string> = {
  instant: '즉시',
  stable: '안정',
  growth: '성장',
  recovery: '회복',
};
export const CATEGORY_ORDER: ActionCategory[] = ['instant', 'stable', 'growth', 'recovery'];

const META = new Map<ActionId, ActionMeta>(ACTIONS.map((a) => [a.id, a]));
export const meta = (id: ActionId): ActionMeta | undefined => META.get(id);
export const actionName = (id: ActionId | null | undefined): string =>
  id ? META.get(id)?.name ?? id : '무행동';

export const HABIT_ACTIONS = ACTIONS.filter((a) => a.formsHabit);

/** 계획 편집용 셀: 비용 2 행동이 놓인 다음 칸은 'used' */
export type Cell = PlanSlot | null | 'used';
export type Cells = [Cell, Cell, Cell];

export const emptyCells = (): Cells => [null, null, null];

export function cellsFromPlan(plan: Plan): Cells {
  const cells: Cells = [plan.slots[0], plan.slots[1], plan.slots[2]];
  for (let i = 0; i < 2; i++) {
    const c = cells[i];
    if (c && c !== 'used' && meta(c.actionId)?.cost === 2) cells[i + 1] = 'used';
  }
  return cells;
}

export function planFromCells(cells: Cells): Plan {
  const s = cells.map((c) => (c && c !== 'used' ? { ...c } : null));
  return { slots: [s[0], s[1], s[2]] };
}

/** 이 행동을 놓을 수 있는 첫 칸 (없으면 -1) */
export function nextFreeIndex(cells: Cells, cost: number): number {
  for (let i = 0; i < 3; i++) {
    if (cells[i] !== null) continue;
    if (cost === 1) return i;
    if (i + 1 < 3 && cells[i + 1] === null) return i;
  }
  return -1;
}

export function placeAction(cells: Cells, slot: PlanSlot): Cells | null {
  const cost = meta(slot.actionId)?.cost ?? 1;
  const i = nextFreeIndex(cells, cost);
  if (i < 0) return null;
  const next = [...cells] as Cells;
  next[i] = slot;
  if (cost === 2) next[i + 1] = 'used';
  return next;
}

export function clearCell(cells: Cells, index: number): Cells {
  const next = [...cells] as Cells;
  let owner = index;
  if (next[index] === 'used') owner = index - 1;
  const c = next[owner];
  next[owner] = null;
  if (c && c !== 'used' && meta(c.actionId)?.cost === 2 && owner + 1 < 3) next[owner + 1] = null;
  return next;
}

export function usedPoints(cells: Cells): number {
  return cells.filter((c) => c !== null).length;
}

export function plannedSlots(cells: Cells): PlanSlot[] {
  return cells.filter((c): c is PlanSlot => c !== null && c !== 'used');
}

/** 이 행동을 다음 빈 칸에 놓는다고 할 때 그 칸보다 앞선 칸들 (비용 2가 소비한 칸·빈 칸은 null) */
export function slotsBefore(cells: Cells, cost: number): (PlanSlot | null)[] {
  const i = nextFreeIndex(cells, cost);
  const upto = i < 0 ? 3 : i;
  return cells.slice(0, upto).map((c) => (c && c !== 'used' ? c : null));
}

/**
 * 카드 미리보기: 오늘 계획의 앞 칸들을 실제 규칙으로 시뮬레이션한 뒤 이 행동이 다음 빈 칸에 놓일 때의 결과.
 * 공동 보너스·확률 결과만 범위로 남는다(실제 결과는 서버가 확정). day는 현재 일차(초반 보너스 반영용).
 */
export function safePlannedPreview(me: PlayerRuleState, id: ActionId, cells: Cells, day?: number): ActionPreview | null {
  try { return previewPlannedAction(me, id, slotsBefore(cells, meta(id)?.cost ?? 1), day); } catch { return null; }
}

/** 계획을 낮에 실행한 뒤의 습관 (대상 선택 화면 표시용) */
export function safeHabitsAfter(me: PlayerRuleState, cells: Cells): Counts {
  try { return habitsAfterPlan(me, planFromCells(cells)); } catch { return me.habits; }
}

export function safeNightOdds(p: PlayerRuleState, plan?: Plan | null): Counts | null {
  try { return nightOdds(p, plan); } catch { return null; }
}

export function signed(n: number): string {
  if (n > 0) return `+${n}`;
  return `${n}`;
}

export function rangeText(p: ActionPreview): string {
  return p.min === p.max ? signed(p.min) : `${signed(p.min)} ~ ${signed(p.max)}`;
}

export function pct(x: number | undefined): string {
  if (!x) return '0%';
  const v = x * 100;
  return v < 1 ? '<1%' : `${Math.round(v)}%`;
}

/** 확률 분포를 내림차순 [id, p] 목록으로 */
export function sortedOdds(odds: Counts | null | undefined): [ActionId, number][] {
  if (!odds) return [];
  return (Object.entries(odds) as [ActionId, number][])
    .filter(([, v]) => (v ?? 0) > 0)
    .sort((a, b) => b[1] - a[1]);
}
