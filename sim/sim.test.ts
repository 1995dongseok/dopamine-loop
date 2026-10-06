import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS } from '../src/shared/rules';
import { mixSeed, playGame, summarize } from './engine';
import { numbersHash, runPool } from './run';
import { STRATEGIES } from './strategies';

const IDS = STRATEGIES.map((s) => s.id);

describe('시뮬레이션 재현성', () => {
  it('같은 시드·구성은 완전히 같은 판을 만든다', () => {
    for (const seed of [1, 2, 3]) {
      const a = playGame(IDS, mixSeed(seed));
      const b = playGame(IDS, mixSeed(seed));
      expect(a).toEqual(b);
    }
  });
  it('시드나 좌석 순서가 바뀌면 다른 판이 된다', () => {
    const a = playGame(IDS, mixSeed(10));
    expect(playGame(IDS, mixSeed(11))).not.toEqual(a);
    expect(playGame([...IDS].reverse(), mixSeed(10)).seats.map((s) => s.strategy)).toEqual([...IDS].reverse());
  });
  it('무작위 구성 풀과 요약도 결정적이다', () => {
    expect(summarize(runPool(4, 20))).toEqual(summarize(runPool(4, 20)));
    expect(numbersHash()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('봇과 게임 진행', () => {
  it('모든 전략이 매일 유효한 계획을 내고 판이 규칙대로 끝난다', () => {
    // 잘못된 계획이면 playGame 이 예외를 던진다
    for (let i = 0; i < 10; i++) {
      for (const n of [2, 4, 6]) {
        const comp = Array.from({ length: n }, (_, k) => IDS[(i + k) % IDS.length]);
        const g = playGame(comp, mixSeed(n, i));
        expect(g.endDay).toBeGreaterThanOrEqual(1);
        expect(g.endDay).toBeLessThanOrEqual(GAME_CONSTANTS.maxDays);
        expect(g.winners.length).toBeGreaterThan(0);
        const max = Math.max(...g.seats.map((s) => s.finalScore));
        for (const s of g.seats) expect(s.won).toBe(s.finalScore === max);
        if (g.endDay < GAME_CONSTANTS.maxDays) expect(max).toBeGreaterThanOrEqual(GAME_CONSTANTS.targetScore);
      }
    }
  });
  it('행동 선택률은 합이 1이다', () => {
    const s = summarize(runPool(2, 30));
    const total = Object.values(s.actionRate).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 1);
  });
});
