import { describe, expect, it } from 'vitest';
import type { ActionId, Plan, PlanSlot, PlayerRuleState, Rng } from '../types';
import {
  ACTION_DATA as D, RULE_DATA, createPlayerState, previewAction, previewPlannedAction, resolveDay, stateBeforePlannedSlot,
} from './index';
import { findStage } from './meta';

const player = (o: Partial<PlayerRuleState> = {}): PlayerRuleState => ({ ...createPlayerState('p1'), ...o });
const S = (actionId: ActionId, targetId?: ActionId): PlanSlot => (targetId ? { actionId, targetId } : { actionId });
const fixedRng = (v: number): Rng => ({ next: () => v });

const B = RULE_DATA.instantEarlyBonus;
const F = RULE_DATA.sameDayFatigue;
/** 초반 도파민 보너스가 끝난 첫 일차 */
const LATE = B.length + 1;

/** 실제 정산으로 계획의 slot번째 칸 낮 점수 변화 (상대 1명은 무행동) */
function actualDelta(p: PlayerRuleState, plan: Plan, slot: number, rng: Rng = fixedRng(0.5), day = LATE): number {
  const r = resolveDay([p, createPlayerState('zz_other')], { [p.playerId]: plan }, day, rng);
  const ev = r.result.dayEvents.find((e) => e.playerId === p.playerId && e.index === slot)!;
  return ev.delta;
}

describe('previewPlannedAction', () => {
  it('does not mutate inputs and resets yesterday daily state first', () => {
    const me = player({ dailyUses: { shopping: 2, cook: 1 }, streakAction: 'binge_game', streakCount: 2, flags: { 'daily:study_high': 1 } });
    const before = JSON.stringify(me);
    const slots = [S('shopping')];
    // 어제 기록은 무시: 첫 칸 요리는 오늘 첫 사용 보너스를 받는다
    const cook = previewPlannedAction(me, 'cook', []);
    expect(cook.min).toBe(D.cook.score + D.cook.firstOfDayBonus);
    expect(cook.max).toBe(cook.min);
    const bg = previewPlannedAction(me, 'binge_game', []);
    expect(bg.min).toBe(findStage(D.binge_game.stages, 1).score);
    previewPlannedAction(me, 'shopping', slots);
    expect(JSON.stringify(me)).toBe(before);
    expect(slots).toEqual([S('shopping')]);
  });

  it('applies the same-day shopping penalty only after an earlier shopping slot', () => {
    const me = player({ uses: { shopping: 1 }, score: 50 });
    const first = previewPlannedAction(me, 'shopping', []);
    expect(first.nextUse).toBe(2);
    expect([first.min, first.max]).toEqual([findStage(D.shopping.stages, 2).score, findStage(D.shopping.stages, 2).score]);
    const second = previewPlannedAction(me, 'shopping', [S('shopping')]);
    const v3 = findStage(D.shopping.stages, 3).score + D.shopping.sameDayPenalty;
    expect(second.nextUse).toBe(3);
    expect([second.min, second.max]).toEqual([v3, v3]);
    expect(actualDelta(me, { slots: [S('shopping'), S('shopping'), null] }, 1)).toBe(v3);
  });

  it('binge_game streak penalty: adjacent only; no-action / recovery breaks the streak', () => {
    const me = player();
    const pen = D.binge_game.streakPenalty;
    const v2 = findStage(D.binge_game.stages, 2).score;
    expect(previewPlannedAction(me, 'binge_game', [S('binge_game')]).min).toBe(v2 + pen);
    expect(previewPlannedAction(me, 'binge_game', [S('binge_game'), null]).min).toBe(v2);
    expect(previewPlannedAction(me, 'binge_game', [S('binge_game'), S('rest', 'drink')]).min).toBe(v2);
    expect(previewPlannedAction(me, 'binge_game', [S('binge_game'), S('music')]).min).toBe(v2);
  });

  it('cook first-of-day bonus only for the first cook of the day', () => {
    const me = player({ uses: { cook: 5 } });
    expect(previewPlannedAction(me, 'cook', [S('music')]).min).toBe(D.cook.score + D.cook.firstOfDayBonus);
    const later = previewPlannedAction(me, 'cook', [S('cook')]);
    expect([later.min, later.max]).toEqual([D.cook.score, D.cook.score]);
  });

  it('music placed in the day has no night bonus', () => {
    const pv = previewPlannedAction(player(), 'music', []);
    expect([pv.min, pv.max]).toEqual([D.music.score, D.music.score]);
    expect(previewAction(player(), 'music').max).toBe(D.music.score + D.music.nightBonus);
  });

  it('study high stage is once per day', () => {
    const high = D.study.stages.find((s) => s.high)!;
    const me = player({ uses: { study: high.from - 1 }, score: 50 });
    const first = previewPlannedAction(me, 'study', []);
    expect([first.min, first.max]).toEqual([high.score, high.score]);
    const second = previewPlannedAction(me, 'study', [S('study')]);
    expect([second.min, second.max]).toEqual([D.study.baseScore, D.study.baseScore]);
    expect(actualDelta(me, { slots: [S('study'), S('study'), null] }, 1)).toBe(D.study.baseScore);
  });

  it('counts earlier slots toward cumulative stage (nextUse)', () => {
    const me = player({ uses: { drink: 1 } });
    const pv = previewPlannedAction(me, 'drink', [S('drink'), S('drink')]);
    expect(pv.nextUse).toBe(4);
    expect(pv.min).toBe(findStage(D.drink.stages, 4).score);
  });

  it('keeps co-op and probabilistic outcomes as ranges', () => {
    const me = player();
    const f = previewPlannedAction(me, 'friends', [S('music')]);
    expect([f.min, f.max]).toEqual([D.friends.score, D.friends.score + D.friends.bonus]);
    const v = previewPlannedAction(me, 'volunteer', []);
    expect([v.min, v.max]).toEqual([D.volunteer.score, D.volunteer.score + D.volunteer.bonus]);
    const g = previewPlannedAction(me, 'gamble', [S('gamble')]);
    const gs = findStage(D.gamble.stages, 2);
    expect([g.min, g.max]).toEqual([gs.loss, gs.win]);
  });

  it('cost-2 consumed slot (null) is treated as a non-action between slots', () => {
    const s = stateBeforePlannedSlot(player({ habits: { sns: 4 } }), [S('change_env', 'sns'), null]);
    expect(s.habits.sns).toBe(0);
    expect(s.uses.change_env).toBe(1);
    expect(s.streakAction).toBeNull();
    expect(s.dailyUses.change_env).toBe(1);
  });

  it('matches the real engine for deterministic actions across many prefixes', () => {
    const ids: ActionId[] = ['drink', 'smoke', 'sns', 'shopping', 'binge_game', 'music', 'cook', 'study', 'exercise', 'project', 'relationship', 'meditate'];
    const me = player({ uses: { study: 5, shopping: 2, binge_game: 1, project: 1, relationship: 2 }, score: 50 });
    for (const day of [1, 2, LATE]) {
      for (const a of ids) {
        for (const b of ids) {
          const plan: Plan = { slots: [S(a, a === 'meditate' ? 'drink' : undefined), S(b, b === 'meditate' ? 'drink' : undefined), null] };
          const pv = previewPlannedAction(me, b, [plan.slots[0]], day);
          expect(pv.min, `${day}일 ${a} → ${b}`).toBe(pv.max);
          expect(actualDelta(me, plan, 1, fixedRng(0.5), day), `${day}일 ${a} → ${b}`).toBe(pv.min);
        }
      }
    }
  });

  it('matches the real engine on the third slot (same-day repetition)', () => {
    const ids: ActionId[] = ['drink', 'shopping', 'music', 'cook', 'study', 'exercise', 'project', 'relationship'];
    const me = player({ uses: { study: 3, project: 1, relationship: 5, exercise: 6 }, score: 60 });
    for (const day of [1, LATE]) {
      for (const a of ids) {
        const plan: Plan = { slots: [S(a), S(a), S(a)] };
        const pv = previewPlannedAction(me, a, [S(a), S(a)], day);
        expect(pv.min, `${day}일 ${a}×3`).toBe(pv.max);
        expect(actualDelta(me, plan, 2, fixedRng(0.5), day), `${day}일 ${a}×3`).toBe(pv.min);
      }
    }
  });
});

describe('초반 도파민 보너스 미리보기', () => {
  it('previewAction: day가 있으면 즉시 행동의 양수 끝값에만 보너스, 없으면 기본', () => {
    const base = findStage(D.drink.stages, 1).score;
    expect(previewAction(player(), 'drink')).toMatchObject({ min: base, max: base });
    expect(previewAction(player(), 'drink', 1)).toMatchObject({ min: base + B[0], max: base + B[0] });
    expect(previewAction(player(), 'drink', 1).label).toContain(`초반 보너스 +${B[0]}`);
    expect(previewAction(player(), 'drink', LATE)).toMatchObject({ min: base, max: base });
    const g = findStage(D.gamble.stages, 1);
    expect(previewAction(player(), 'gamble', 1)).toMatchObject({ min: g.loss, max: g.win + B[0] });
    const neg = D.drink.stages.find((s) => s.score < 0)!;
    expect(previewAction(player({ uses: { drink: neg.from - 1 } }), 'drink', 1)).toMatchObject({ min: neg.score, max: neg.score });
    // 안정·성장에는 보너스 없음
    expect(previewAction(player(), 'cook', 1)).toEqual(previewAction(player(), 'cook'));
  });
  it('previewPlannedAction: 현재 일차의 보너스를 반영한다', () => {
    const base = findStage(D.shopping.stages, 1).score;
    expect(previewPlannedAction(player(), 'shopping', [], 1).min).toBe(base + B[0]);
    expect(previewPlannedAction(player(), 'shopping', [], LATE).min).toBe(base);
    expect(previewPlannedAction(player(), 'shopping', []).min).toBe(base);
  });
});

describe('같은 날 반복 피로 미리보기', () => {
  it('previewAction은 player.dailyUses로 피로를 판정한다', () => {
    const tired = player({ dailyUses: { relationship: F.fromDailyUse - 1 }, uses: { relationship: 10 } });
    const pv = previewAction(tired, 'relationship');
    expect([pv.min, pv.max]).toEqual([F.score, F.score]);
    expect(pv.label).toContain(`같은 날 ${F.fromDailyUse}회째 피로`);
    const fresh = previewAction(player({ dailyUses: { relationship: F.fromDailyUse - 2 }, uses: { relationship: 10 } }), 'relationship');
    expect(fresh.label).not.toContain('피로');
    // 계획 미리보기: 낮 칸만으로는 피로가 아니어도 밤 2회까지 합쳐 닿으면 경고 문구
    const warnAt = Math.max(0, F.fromDailyUse - 3); // 이 칸 수만큼 앞에 같은 행동이 있으면 (이번 + 밤 2회)로 닿는다
    if (warnAt <= 2) {
      const pre = Array.from({ length: warnAt }, () => S('music'));
      expect(previewPlannedAction(player(), 'music', pre).label).toContain(`같은 날 ${F.fromDailyUse}회째부터 피로`);
    }
    expect(previewPlannedAction(player(), 'drink', [S('drink'), S('drink')]).label).not.toContain('피로');
    // 즉시 행동은 피로 대상이 아니다
    expect(previewAction(player({ dailyUses: { drink: 5 } }), 'drink').label).not.toContain('피로');
  });
});
