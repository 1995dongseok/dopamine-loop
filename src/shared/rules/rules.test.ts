import { describe, expect, it } from 'vitest';
import { ACTION_IDS, type ActionId, type Counts, type Plan, type PlanSlot, type PlayerRuleState, type Rng } from '../types';
import {
  ACTIONS, GAME_CONSTANTS, checkWinner, createPlayerState, emptyPlan, getAction, nightOdds, previewAction,
  resolveDay, seededRng, validatePlan,
} from './index';

// ── 도우미 ──
type SlotIn = ActionId | [ActionId, ActionId] | null;
const plan = (...a: SlotIn[]): Plan => ({
  slots: [0, 1, 2].map((i) => {
    const x = a[i] ?? null;
    if (x === null) return null;
    return Array.isArray(x) ? { actionId: x[0], targetId: x[1] } : { actionId: x };
  }) as Plan['slots'],
});
const player = (id: string, o: Partial<PlayerRuleState> = {}): PlayerRuleState => ({ ...createPlayerState(id), ...o });
/** 항상 같은 값을 내는 난수원 (0 → 도박 승리·창작 완성, 0.999 → 패배) */
const fixedRng = (v: number): Rng => ({ next: () => v });
const dayEv = (r: ReturnType<typeof resolveDay>, pid: string) => r.result.dayEvents.filter((e) => e.playerId === pid);
const nightEv = (r: ReturnType<typeof resolveDay>, pid: string) => r.result.nightEvents.filter((e) => e.playerId === pid);
const stateOf = (r: ReturnType<typeof resolveDay>, pid: string) => r.players.find((p) => p.playerId === pid)!;
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
};

describe('메타데이터', () => {
  it('ACTIONS는 ACTION_IDS와 같은 순서의 20개이고 설명이 비어 있지 않다', () => {
    expect(ACTIONS.map((a) => a.id)).toEqual([...ACTION_IDS]);
    for (const a of ACTIONS) expect(a.description.length).toBeGreaterThan(3);
    expect(getAction('change_env').cost).toBe(2);
    expect(ACTIONS.filter((a) => a.needsTarget).map((a) => a.id).sort()).toEqual(['change_env', 'meditate', 'rest', 'walk']);
    expect(ACTIONS.filter((a) => !a.formsHabit).every((a) => a.category === 'recovery')).toBe(true);
  });
  it('설명에 실제 수치가 들어 있다', () => {
    expect(getAction('drink').description).toBe('1~2회 +8 → 3~4회 +3 → 5~6회 -4 → 7회~ -8');
  });
});

describe('보상 단계 경계', () => {
  const drinkAt = (uses: number) => {
    const r = resolveDay([player('a', { score: 50, uses: { drink: uses } }), player('b')], { a: plan('drink') }, 1, seededRng(1));
    return dayEv(r, 'a')[0];
  };
  it('음주: 1~2회 +8, 3~4회 +3, 5~6회 -4, 7회~ -8', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((u) => drinkAt(u).delta)).toEqual([8, 8, 3, 3, -4, -4, -8, -8]);
    expect(drinkAt(2).notes[0]).toBe('3회째 +3');
  });
  it('사용 후 누적 횟수가 1 증가하고 낮 실행이면 습관 +1', () => {
    const r = resolveDay([player('a', { uses: { drink: 2 } })], { a: plan('drink') }, 1, seededRng(1));
    const s = stateOf(r, 'a');
    // 낮 1회 + 밤 2회(습관이 음주뿐)
    expect(s.uses.drink).toBe(5);
    expect(s.habits.drink).toBe(1);
  });
  it('공부: 고단계(5회~)는 하루 1회, 이후 같은 날은 기본 +1', () => {
    const r = resolveDay([player('a', { uses: { study: 4 } })], { a: plan('study', 'study', 'study') }, 1, seededRng(1));
    expect(dayEv(r, 'a').map((e) => e.delta)).toEqual([7, 1, 1]);
  });
  it('프로젝트: 3의 배수 회째 완료 보너스', () => {
    const r = resolveDay([player('a', { uses: { project: 1 } })], { a: plan('project', 'project', 'project') }, 1, seededRng(1));
    expect(dayEv(r, 'a').map((e) => e.delta)).toEqual([1, 8, 1]);
  });
  it('관계: 단계 진입 회차에 도달 보너스', () => {
    const r = resolveDay([player('a', { uses: { relationship: 1 } })], { a: plan('relationship', 'relationship', 'relationship') }, 1, seededRng(1));
    expect(dayEv(r, 'a').map((e) => e.delta)).toEqual([1, 2 + 3, 2]);
  });
  it('도박·창작은 난수로 결과가 갈린다', () => {
    const win = resolveDay([player('a', { score: 10 })], { a: plan('gamble', 'create') }, 1, fixedRng(0));
    expect(dayEv(win, 'a').slice(0, 2).map((e) => e.delta)).toEqual([9, 11]);
    const lose = resolveDay([player('a', { score: 10 })], { a: plan('gamble', 'create') }, 1, fixedRng(0.999));
    expect(dayEv(lose, 'a').slice(0, 2).map((e) => e.delta)).toEqual([-3, 1]);
  });
});

describe('점수 하한', () => {
  it('개별 행동마다 0 미만을 0으로 보정한다', () => {
    const r = resolveDay([player('a', { score: 2, uses: { drink: 6, smoke: 2 } })], { a: plan('drink', 'smoke') }, 1, seededRng(1));
    const [e0, e1] = dayEv(r, 'a');
    expect(e0.delta).toBe(-2);
    expect(e0.scoreAfter).toBe(0);
    expect(e0.notes).toContain('점수 하한 0 보정');
    // 다음 행동은 0에서 시작 (보정이 누적되지 않음)
    expect(e1.delta).toBe(1);
    expect(e1.scoreAfter).toBe(1);
  });
});

describe('회복', () => {
  it('습관만 줄이고 누적 사용 횟수는 그대로 둔다', () => {
    const r = resolveDay(
      [player('a', { uses: { drink: 5 }, habits: { drink: 4, music: 1 } })],
      { a: plan(['rest', 'drink'], ['meditate', 'music']) }, 1, fixedRng(0.999),
    );
    const s = stateOf(r, 'a');
    expect(s.habits.drink).toBe(1);
    expect(s.habits.music).toBe(0);
    expect(s.habits.rest).toBeUndefined();
    expect(dayEv(r, 'a')[0].notes).toContain('휴식: 음주 습관 -3');
    // 밤에 음주(1/1)가 뽑혀 uses만 증가 — 5 이하로 내려가지 않는다
    expect(s.uses.drink).toBe(7);
    expect(s.uses.rest).toBe(1);
  });
  it('습관은 0 미만으로 내려가지 않는다', () => {
    const r = resolveDay([player('a', { habits: { sns: 1 } })], { a: plan('detox') }, 1, seededRng(1));
    const s = stateOf(r, 'a');
    expect(s.habits.sns).toBe(0);
    expect(s.habits.binge_game).toBe(0);
    expect(r.result.nightOdds.a).toEqual({});
  });
  it('산책은 자기 습관 +1 뒤 대상 -1 (자기 자신 대상이면 순변화 0)', () => {
    const r = resolveDay([player('a', { habits: { walk: 2, drink: 3 } })], { a: plan(['walk', 'walk'], ['walk', 'drink']) }, 1, seededRng(1));
    const s = stateOf(r, 'a');
    expect(s.habits.walk).toBe(3);
    expect(s.habits.drink).toBe(2);
    expect(dayEv(r, 'a')[1].notes).toContain('산책: 음주 습관 -1');
  });
});

describe('밤 정산', () => {
  it('같은 행동이 두 번 뽑히면 각각 다음 단계 보상', () => {
    const r = resolveDay([player('a', { score: 20, uses: { drink: 1 }, habits: { drink: 3 } })], { a: emptyPlan() }, 1, seededRng(7));
    const ev = nightEv(r, 'a');
    expect(ev.map((e) => e.actionId)).toEqual(['drink', 'drink']);
    expect(ev.map((e) => e.delta)).toEqual([8, 3]);
    expect(stateOf(r, 'a').uses.drink).toBe(3);
    // 밤에는 습관이 변하지 않는다
    expect(stateOf(r, 'a').habits.drink).toBe(3);
    expect(r.result.nightOdds.a).toEqual({ drink: 1 });
  });
  it('습관 합계 0이면 밤 2회 모두 무행동', () => {
    const r = resolveDay([player('a', { score: 5 })], { a: plan(['rest', 'drink']) }, 1, seededRng(1));
    const ev = nightEv(r, 'a');
    expect(ev).toHaveLength(2);
    expect(ev.every((e) => e.actionId === null && e.delta === 0)).toBe(true);
    expect(r.result.nightOdds.a).toEqual({});
  });
  it('분포는 낮 효과를 모두 적용한 습관 / 합계', () => {
    const r = resolveDay([player('a', { habits: { drink: 2, music: 1 } })], { a: plan('music', 'study', ['walk', 'drink']) }, 1, seededRng(1));
    expect(r.result.nightOdds.a).toEqual({ drink: 1 / 5, music: 2 / 5, study: 1 / 5, walk: 1 / 5 });
  });
  it('낮 전용 부가효과는 밤에 없다 (산책 대상·친구·봉사), 음악 밤 보너스는 있다', () => {
    const run = (id: ActionId) => nightEv(resolveDay([player('a', { habits: { [id]: 1, drink: 0 } }), player('b')], {}, 1, seededRng(3)), 'a');
    expect(run('music').map((e) => e.delta)).toEqual([5, 5]);
    expect(run('friends').map((e) => e.delta)).toEqual([3, 3]); // 둘 다 무행동이 아니어도 밤엔 보너스 없음
    expect(run('volunteer').map((e) => e.delta)).toEqual([3, 3]); // 최저 점수여도 밤엔 보너스 없음
    const w = resolveDay([player('a', { habits: { walk: 1 } })], {}, 1, seededRng(3));
    expect(stateOf(w, 'a').habits).toEqual({ walk: 1 });
    expect(nightEv(w, 'a').every((e) => e.targetId === undefined)).toBe(true);
  });
});

describe('하루 단위 기록 (일일 제한·연속 사용)', () => {
  it('공부 고단계 하루 1회 제한은 밤까지 포함하고 다음 날 초기화된다', () => {
    const p = player('a', { uses: { study: 4 }, habits: { study: 10 } });
    const r1 = resolveDay([p], { a: plan('study') }, 1, seededRng(1));
    expect(dayEv(r1, 'a')[0].delta).toBe(7);
    expect(nightEv(r1, 'a').map((e) => e.delta)).toEqual([1, 1]);
    const r2 = resolveDay(r1.players, { a: emptyPlan() }, 2, seededRng(2));
    expect(nightEv(r2, 'a').map((e) => e.delta)).toEqual([10, 1]);
  });
  it('쇼핑 같은 날 재사용 감점은 낮·밤을 합산한다', () => {
    const r = resolveDay([player('a', { score: 30, habits: { shopping: 5 } })], { a: plan('shopping') }, 1, seededRng(1));
    expect(dayEv(r, 'a')[0].delta).toBe(7);
    expect(nightEv(r, 'a').map((e) => e.delta)).toEqual([7 - 3, 2 - 3]);
    expect(stateOf(r, 'a').dailyUses.shopping).toBe(3);
  });
  it('요리 첫 사용 보너스는 그날 한 번', () => {
    const r = resolveDay([player('a')], { a: plan('cook', 'cook') }, 1, seededRng(1));
    expect(dayEv(r, 'a').slice(0, 2).map((e) => e.delta)).toEqual([5, 3]);
  });
  it('게임 몰아하기 연속 감점: 낮→밤으로 이어지고 무행동·회복이 끊는다', () => {
    const r = resolveDay([player('a', { score: 30, habits: { binge_game: 9 } })], { a: plan('binge_game', 'binge_game', null) }, 1, seededRng(1));
    expect(dayEv(r, 'a').map((e) => e.delta)).toEqual([7, 7 - 3, 0]);
    // 슬롯 2 무행동이 연속을 끊었으므로 밤 첫 회는 감점 없음, 두 번째는 연속
    expect(nightEv(r, 'a').map((e) => e.delta)).toEqual([2, 2 - 3]);

    const r2 = resolveDay([player('a', { score: 30, habits: { binge_game: 9 } })], { a: plan('binge_game', ['meditate', 'drink'], 'binge_game') }, 1, seededRng(1));
    expect(dayEv(r2, 'a').map((e) => e.delta)).toEqual([7, 1, 7]);
    expect(nightEv(r2, 'a')[0].delta).toBe(2 - 3); // 낮 마지막 → 밤 첫 회 연속
  });
  it('다음 낮 시작 시 하루 횟수·연속 초기화', () => {
    const r1 = resolveDay([player('a', { habits: { binge_game: 3 } })], { a: plan(null, null, 'binge_game') }, 1, seededRng(1));
    expect(stateOf(r1, 'a').streakAction).toBe('binge_game');
    const r2 = resolveDay(r1.players, { a: plan('binge_game') }, 2, seededRng(1));
    expect(dayEv(r2, 'a')[0].notes.some((n) => n.includes('연속'))).toBe(false);
    expect(stateOf(r2, 'a').dailyUses.binge_game).toBe(3);
  });
});

describe('공동 효과', () => {
  it('친구 만나기: 같은 슬롯 2명 이상이면 각각 보너스', () => {
    const r = resolveDay([player('a'), player('b'), player('c')], {
      a: plan('friends', 'friends'), b: plan('friends', 'music'), c: plan('music', 'music'),
    }, 1, seededRng(1));
    expect(dayEv(r, 'a').map((e) => e.delta).slice(0, 2)).toEqual([6, 3]);
    expect(dayEv(r, 'b')[0].delta).toBe(6);
    expect(dayEv(r, 'a')[0].notes).toContain('친구 2명 보너스 +3');
  });
  it('봉사: 슬롯 시작 시점의 공동 최저 점수로 동시에 판정', () => {
    const r = resolveDay([player('a', { score: 0 }), player('b', { score: 0 }), player('c', { score: 5 })], {
      a: plan('volunteer', 'volunteer'), b: plan('volunteer', 'drink'), c: plan('volunteer', 'volunteer'),
    }, 1, seededRng(1));
    // 슬롯0: a·b 공동 최저(0) → +6, c → +3. 슬롯1 시작: a 6, b 6, c 8 → a 최저
    expect(dayEv(r, 'a').slice(0, 2).map((e) => e.delta)).toEqual([6, 6]);
    expect(dayEv(r, 'b')[0].delta).toBe(6);
    expect(dayEv(r, 'c').slice(0, 2).map((e) => e.delta)).toEqual([3, 3]);
  });
  it('참가자 배열 순서를 섞어도 결과가 같다', () => {
    const base = [
      player('p1', { score: 3, habits: { drink: 2, music: 1 }, uses: { drink: 2 } }),
      player('p2', { score: 3, habits: { friends: 1 } }),
      player('p3', { score: 0, habits: { gamble: 2, create: 1 } }),
      player('p4', { score: 9 }),
    ];
    const plans = {
      p1: plan('friends', 'volunteer', 'gamble'),
      p2: plan('friends', 'friends', ['walk', 'friends']),
      p3: plan('volunteer', 'friends', 'create'),
      p4: plan(['change_env', 'drink'], null, 'friends'),
    };
    const ref = resolveDay(base, plans, 3, seededRng(42));
    const perms = [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]];
    for (const perm of perms) {
      const r = resolveDay(perm.map((i) => base[i]), plans, 3, seededRng(42));
      expect(r.result).toEqual(ref.result);
      for (const p of ref.players) expect(stateOf(r, p.playerId)).toEqual(p);
      expect(r.players.map((p) => p.playerId)).toEqual(perm.map((i) => base[i].playerId));
    }
  });
});

describe('비용 2 (환경 바꾸기)', () => {
  it('첫 슬롯에서 적용하고 다음 칸은 소비된 칸', () => {
    const r = resolveDay([player('a', { habits: { drink: 5, music: 1 } })], { a: plan(['change_env', 'drink'], null, 'music') }, 1, seededRng(1));
    const ev = dayEv(r, 'a');
    expect(ev[0].actionId).toBe('change_env');
    expect(ev[0].targetId).toBe('drink');
    expect(ev[1].actionId).toBeNull();
    expect(ev[1].notes).toEqual(['환경 바꾸기 진행 중']);
    expect(stateOf(r, 'a').habits.drink).toBe(0);
    expect(r.result.nightOdds.a).toEqual({ music: 1 });
  });
  it('슬롯 1에도 둘 수 있다', () => {
    expect(validatePlan(plan('music', ['change_env', 'drink'], null))).toEqual({ ok: true });
  });
});

describe('validatePlan', () => {
  const bad: unknown[] = [
    null, undefined, 3, 'plan', [], {}, { slots: null }, { slots: [null, null] }, { slots: [null, null, null, null] },
    { slots: [1, null, null] }, { slots: [{}, null, null] }, { slots: [{ actionId: 'nope' }, null, null] },
    { slots: [{ actionId: 'walk' }, null, null] }, // 대상 없음
    { slots: [{ actionId: 'rest', targetId: 'meditate' }, null, null] }, // 회복 행동은 대상 불가
    { slots: [{ actionId: 'rest', targetId: 'xx' }, null, null] },
    { slots: [{ actionId: 'music', targetId: 'drink' }, null, null] }, // 대상 불필요 행동에 대상
    { slots: [null, null, { actionId: 'change_env', targetId: 'drink' }] }, // 마지막 칸 비용 2
    { slots: [{ actionId: 'change_env', targetId: 'drink' }, { actionId: 'music' }, null] }, // 다음 칸 점유
    { slots: [{ actionId: 'change_env', targetId: 'drink' }, null, { actionId: 'change_env', targetId: 'sns' }] },
    { slots: [{ actionId: 'drink' }, undefined, null] },
    // eslint-disable-next-line no-sparse-arrays
    { slots: [, null, null] },
  ];
  it.each(bad.map((b, i) => [i, b]))('잘못된 입력 #%i 거부', (_i, b) => {
    const v = validatePlan(b);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(typeof v.reason).toBe('string');
  });
  it('throw 하지 않는다 (getter가 예외를 던지는 객체)', () => {
    const evil = { get slots(): never { throw new Error('boom'); } };
    expect(validatePlan(evil).ok).toBe(false);
    const proxy = new Proxy({}, { get() { throw new Error('boom'); } });
    expect(validatePlan(proxy).ok).toBe(false);
  });
  it('정상 계획 허용', () => {
    expect(validatePlan(emptyPlan()).ok).toBe(true);
    expect(validatePlan(plan('drink', 'drink', 'drink')).ok).toBe(true);
    expect(validatePlan(plan(['walk', 'walk'], ['rest', 'sns'], ['meditate', 'binge_game'])).ok).toBe(true);
    expect(validatePlan({ slots: [{ actionId: 'music', targetId: null }, null, null] }).ok).toBe(true);
  });
  it('resolveDay는 잘못된 계획을 무행동으로 처리한다', () => {
    const r = resolveDay([player('a')], { a: { slots: [{ actionId: 'walk' } as PlanSlot, null, null] } }, 1, seededRng(1));
    expect(dayEv(r, 'a').every((e) => e.actionId === null)).toBe(true);
  });
});

describe('승리 판정', () => {
  const ps = (...scores: number[]) => scores.map((s, i) => player(`p${i}`, { score: s }));
  it('목표 이상 최고 점수 동점은 공동 승리', () => {
    expect(checkWinner(ps(100, 100, 40), 4)).toEqual({ finished: true, winnerIds: ['p0', 'p1'] });
    expect(checkWinner(ps(104, 100, 40), 4)).toEqual({ finished: true, winnerIds: ['p0'] });
  });
  it('목표 미달이면 계속, 10일째에는 최고 점수 승리', () => {
    expect(checkWinner(ps(99, 50), 9)).toEqual({ finished: false, winnerIds: [] });
    expect(checkWinner(ps(60, 60, 10), GAME_CONSTANTS.maxDays)).toEqual({ finished: true, winnerIds: ['p0', 'p1'] });
  });
  it('기권자는 제외: 남은 1명 승리, 0명은 승자 없음', () => {
    const a = ps(150, 20, 10);
    a[0].forfeited = true;
    expect(checkWinner(a, 3)).toEqual({ finished: false, winnerIds: [] });
    a[1].forfeited = true;
    expect(checkWinner(a, 3)).toEqual({ finished: true, winnerIds: ['p2'] });
    a[2].forfeited = true;
    expect(checkWinner(a, 3)).toEqual({ finished: true, winnerIds: [] });
  });
  it('기권자는 정산에서 건너뛰고 상태가 그대로다', () => {
    const f = player('f', { forfeited: true, score: 30, habits: { drink: 3 }, dailyUses: { drink: 1 } });
    const r = resolveDay([player('a'), f], { a: plan('music'), f: plan('drink') }, 2, seededRng(1));
    expect(r.result.dayEvents.some((e) => e.playerId === 'f')).toBe(false);
    expect(r.result.nightEvents.some((e) => e.playerId === 'f')).toBe(false);
    expect(stateOf(r, 'f')).toEqual(f);
    expect(r.result.nightOdds.f).toBeUndefined();
    expect(r.result.scoresAfter).toEqual({ a: stateOf(r, 'a').score, f: 30 });
  });
});

describe('미리보기·예상 확률', () => {
  it('previewAction은 다음 회차의 범위를 준다', () => {
    expect(previewAction(player('a', { uses: { drink: 2 } }), 'drink')).toMatchObject({ nextUse: 3, min: 3, max: 3 });
    expect(previewAction(player('a'), 'gamble')).toMatchObject({ nextUse: 1, min: -3, max: 9 });
    expect(previewAction(player('a'), 'shopping')).toMatchObject({ min: 4, max: 7 });
    expect(previewAction(player('a', { uses: { study: 7 } }), 'study')).toMatchObject({ min: 1, max: 10 });
    expect(previewAction(player('a', { uses: { project: 2 } }), 'project')).toMatchObject({ min: 8, max: 8 });
    for (const id of ACTION_IDS) {
      const pv = previewAction(player('a'), id);
      expect(pv.min).toBeLessThanOrEqual(pv.max);
      expect(pv.label.length).toBeGreaterThan(0);
    }
  });
  it('nightOdds는 계획의 낮 습관 변화를 슬롯 순서대로 반영하고 resolveDay와 일치한다', () => {
    const p = player('a', { habits: { drink: 4, sns: 1, music: 1 } });
    const pl = plan(['rest', 'drink'], 'detox', 'music');
    const predicted: Counts = nightOdds(p, pl);
    expect(predicted).toEqual({ drink: 1 / 3, music: 2 / 3 });
    expect(resolveDay([p], { a: pl }, 1, seededRng(5)).result.nightOdds.a).toEqual(predicted);
    expect(nightOdds(p)).toEqual({ drink: 4 / 6, sns: 1 / 6, music: 1 / 6 });
    expect(nightOdds(player('a'))).toEqual({});
  });
});

describe('결정성·불변성', () => {
  const setup = () => [player('a', { habits: { gamble: 2, create: 2 } }), player('b', { habits: { drink: 1 } })];
  const plans = { a: plan('gamble', 'create', 'gamble'), b: plan('gamble', 'friends', 'create') };
  it('같은 시드는 같은 결과', () => {
    expect(resolveDay(setup(), plans, 1, seededRng(99))).toEqual(resolveDay(setup(), plans, 1, seededRng(99)));
    const seq = (s: number) => { const r = seededRng(s); return [r.next(), r.next(), r.next()]; };
    expect(seq(5)).toEqual(seq(5));
    expect(seq(5)).not.toEqual(seq(6));
    for (const v of seq(123)) expect(v >= 0 && v < 1).toBe(true);
  });
  it('입력을 변경하지 않는다', () => {
    const ps = deepFreeze(setup());
    const frozenPlans = deepFreeze(structuredClone(plans));
    expect(() => resolveDay(ps, frozenPlans, 1, seededRng(1))).not.toThrow();
    expect(() => nightOdds(ps[0], frozenPlans.a)).not.toThrow();
    expect(ps[0].score).toBe(0);
  });
});

describe('UI 없는 전체 게임 (낮→밤→승리 판정 반복)', () => {
  const strategies: Record<string, (p: PlayerRuleState, day: number) => Plan> = {
    stable: () => plan('music', 'cook', 'volunteer'),
    growth: () => plan('study', 'exercise', 'project'),
    instantThenRecover: (p, day) => {
      if (day <= 2) return plan('drink', 'shopping', 'gamble');
      const worst = (['drink', 'shopping', 'gamble'] as ActionId[]).sort((x, y) => (p.habits[y] ?? 0) - (p.habits[x] ?? 0))[0];
      return plan(['change_env', worst], null, 'exercise');
    },
    social: () => plan('friends', 'friends', ['walk', 'friends']),
  };
  it.each([1, 2, 3, 4, 5])('시드 %i: 10일 이내에 승자가 결정된다', (seed) => {
    const ids = Object.keys(strategies);
    let players = ids.map((id) => createPlayerState(id));
    const rng = seededRng(seed);
    let day = 1;
    let check = checkWinner(players, 0);
    expect(check.finished).toBe(false);
    for (; day <= GAME_CONSTANTS.maxDays; day++) {
      const before = structuredClone(players);
      const plans = Object.fromEntries(players.map((p) => [p.playerId, strategies[p.playerId](p, day)]));
      for (const pl of Object.values(plans)) expect(validatePlan(pl).ok).toBe(true);
      const { players: next, result } = resolveDay(players, plans, day, rng);
      expect(players).toEqual(before);
      expect(result.dayEvents).toHaveLength(ids.length * 3);
      expect(result.nightEvents).toHaveLength(ids.length * 2);
      for (const e of [...result.dayEvents, ...result.nightEvents]) expect(e.scoreAfter).toBeGreaterThanOrEqual(0);
      for (const p of next) expect(result.scoresAfter[p.playerId]).toBe(p.score);
      players = next;
      check = checkWinner(players, day);
      if (check.finished) break;
    }
    expect(check.finished).toBe(true);
    expect(check.winnerIds.length).toBeGreaterThan(0);
    const max = Math.max(...players.map((p) => p.score));
    for (const w of check.winnerIds) expect(players.find((p) => p.playerId === w)!.score).toBe(max);
    expect(day).toBeLessThanOrEqual(GAME_CONSTANTS.maxDays);
  });
  it('중간 기권: 남은 한 명이 승리', () => {
    let players = [createPlayerState('a'), createPlayerState('b')];
    const r = resolveDay(players, { a: plan('music'), b: plan('drink') }, 1, seededRng(1));
    players = r.players.map((p) => (p.playerId === 'b' ? { ...p, forfeited: true } : p));
    const r2 = resolveDay(players, { a: plan('music'), b: plan('drink') }, 2, seededRng(2));
    expect(checkWinner(r2.players, 2)).toEqual({ finished: true, winnerIds: ['a'] });
  });
});

describe('docs/RULES.md 예시 한 턴', () => {
  it('문서의 손계산과 같은 결과', () => {
    const vals = [0.6, 0.2, 0.1, 0.7];
    let i = 0;
    const rng: Rng = { next: () => vals[i++] };
    const A = player('A', { score: 30, uses: { drink: 3, music: 2, study: 4 }, habits: { drink: 3, music: 2, study: 2 } });
    const B = player('B', { score: 24, uses: { shopping: 2, friends: 1 }, habits: { shopping: 2, friends: 1 } });
    const r = resolveDay([B, A], {
      A: plan('study', 'friends', ['rest', 'drink']),
      B: plan('volunteer', 'friends', 'shopping'),
    }, 3, rng);
    expect(dayEv(r, 'A').map((e) => e.scoreAfter)).toEqual([37, 43, 43]);
    expect(dayEv(r, 'B').map((e) => e.scoreAfter)).toEqual([30, 36, 38]);
    expect(nightEv(r, 'A').map((e) => [e.actionId, e.scoreAfter])).toEqual([['study', 44], ['music', 49]]);
    expect(nightEv(r, 'B').map((e) => [e.actionId, e.scoreAfter])).toEqual([['shopping', 37], ['friends', 40]]);
    expect(stateOf(r, 'A').habits).toEqual({ drink: 0, music: 2, study: 3, friends: 1 });
    expect(checkWinner(r.players, 3).finished).toBe(false);
  });
});
