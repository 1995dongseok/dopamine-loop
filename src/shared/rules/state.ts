import type { PlayerRuleState, Rng } from '../types';
import { DAILY_FLAG_PREFIX } from './constants';

/** 점수 0, 사용 횟수·습관 0인 초기 상태 */
export function createPlayerState(playerId: string): PlayerRuleState {
  return {
    playerId,
    score: 0,
    uses: {},
    habits: {},
    dailyUses: {},
    streakAction: null,
    streakCount: 0,
    flags: {},
    forfeited: false,
  };
}

export function cloneState(p: PlayerRuleState): PlayerRuleState {
  return {
    ...p,
    uses: { ...p.uses },
    habits: { ...p.habits },
    dailyUses: { ...p.dailyUses },
    flags: { ...p.flags },
  };
}

/** 낮 시작: 하루 사용 횟수·연속 사용·하루 단위 flags 초기화 (복사본을 변경) */
export function resetDaily(p: PlayerRuleState): void {
  p.dailyUses = {};
  p.streakAction = null;
  p.streakCount = 0;
  for (const k of Object.keys(p.flags)) if (k.startsWith(DAILY_FLAG_PREFIX)) delete p.flags[k];
}

/** 시드 고정 난수원 (mulberry32). 같은 시드는 항상 같은 수열. */
export function seededRng(seed: number): Rng {
  let a = (Math.floor(seed) >>> 0) || 0x9e3779b9;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
