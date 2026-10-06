export const GAME_CONSTANTS = {
  targetScore: 100,
  maxDays: 10,
  actionPoints: 3,
  nightDraws: 2,
  daySeconds: 45,
  nightResultSeconds: 8,
  minPlayers: 2,
  maxPlayers: 6,
} as const;

/** flags 중 이 접두사를 가진 키는 매일 낮 시작 시 삭제된다 (하루 단위 기록). */
export const DAILY_FLAG_PREFIX = 'daily:';
