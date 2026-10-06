// 행동 20개의 수치 데이터 (단일 출처). 밸런스 조정은 이 파일만 고친다.
// 범용 효과 스크립트가 아니라 행동별로 필요한 값만 담고, 해석은 effects.ts의 행동별 처리 코드가 한다.
// 누적 회차(use)는 "이번이 몇 회째 사용인지" = 기존 누적 사용 횟수 + 1.
import type { ActionCategory, ActionId } from '../types';

/** 누적 회차 구간. to가 null이면 그 이후 전부. */
export interface Stage {
  from: number;
  to: number | null;
  score: number;
}

export interface GambleStage {
  from: number;
  to: number | null;
  /** 승리 확률 0~1 */
  winChance: number;
  win: number;
  /** 패배 시 점수 (음수) */
  loss: number;
}

export interface StudyStage extends Stage {
  /** 고단계 보상: 하루(낮+밤) 1회만 받고, 이후 같은 날은 baseScore */
  high: boolean;
}

export interface RelationshipStage extends Stage {
  /** 이 단계에 처음 들어서는 회차(from)에 받는 도달 보너스 */
  reachBonus: number;
}

export interface ActionDataMap {
  drink: { stages: Stage[] };
  smoke: { stages: Stage[] };
  gamble: { stages: GambleStage[] };
  sns: { stages: Stage[] };
  shopping: { stages: Stage[]; /** 같은 날(낮+밤) 이미 사용했으면 추가 */ sameDayPenalty: number };
  binge_game: { stages: Stage[]; /** 같은 날 직전 실제 행동도 게임 몰아하기면 추가 */ streakPenalty: number };
  walk: { score: number; /** 낮 전용: 대상 습관 변화 */ targetHabitDelta: number };
  music: { score: number; /** 밤 추첨으로 실행되면 추가 */ nightBonus: number };
  cook: { score: number; /** 그날(낮+밤) 첫 사용이면 추가 */ firstOfDayBonus: number };
  friends: { score: number; /** 낮 전용: 같은 슬롯에서 이 인원 이상이 선택하면 */ minPlayers: number; bonus: number };
  volunteer: { score: number; /** 낮 전용: 슬롯 시작 시 비기권자 중 최저 점수(동점 포함)면 */ bonus: number };
  study: { stages: StudyStage[]; /** 고단계 하루 1회 이후 받는 기본 보상 */ baseScore: number };
  exercise: { stages: Stage[] };
  project: { score: number; /** 누적 회차가 이 수의 배수일 때 완료 보너스 */ every: number; bonus: number };
  create: { score: number; bonus: number; /** 완성 확률 = chancePerUse × 회차, 최대 chanceCap */ chancePerUse: number; chanceCap: number };
  relationship: { stages: RelationshipStage[] };
  rest: { score: number; targetHabitDelta: number };
  meditate: { score: number; targetHabitDelta: number };
  detox: { score: number; habitDeltas: Partial<Record<ActionId, number>> };
  change_env: { score: number /* 낮 전용: 대상 습관을 0으로 */ };
}

export const ACTION_DATA: ActionDataMap = {
  // ── 즉시 ──
  drink: {
    stages: [
      { from: 1, to: 2, score: 8 },
      { from: 3, to: 4, score: 3 },
      { from: 5, to: 6, score: -4 },
      { from: 7, to: null, score: -8 },
    ],
  },
  smoke: {
    stages: [
      { from: 1, to: 2, score: 4 },
      { from: 3, to: 5, score: 1 },
      { from: 6, to: null, score: -2 },
    ],
  },
  gamble: {
    stages: [
      { from: 1, to: 2, winChance: 0.55, win: 9, loss: -3 },
      { from: 3, to: 5, winChance: 0.4, win: 7, loss: -5 },
      { from: 6, to: null, winChance: 0.25, win: 6, loss: -7 },
    ],
  },
  sns: {
    stages: [
      { from: 1, to: 1, score: 5 },
      { from: 2, to: 3, score: 2 },
      { from: 4, to: 5, score: 0 },
      { from: 6, to: null, score: -3 },
    ],
  },
  shopping: {
    stages: [
      { from: 1, to: 2, score: 7 },
      { from: 3, to: 4, score: 2 },
      { from: 5, to: null, score: -5 },
    ],
    sameDayPenalty: -3,
  },
  binge_game: {
    stages: [
      { from: 1, to: 2, score: 7 },
      { from: 3, to: 4, score: 2 },
      { from: 5, to: null, score: -5 },
    ],
    streakPenalty: -3,
  },
  // ── 안정 ──
  walk: { score: 2, targetHabitDelta: -1 },
  music: { score: 3, nightBonus: 2 },
  cook: { score: 3, firstOfDayBonus: 2 },
  friends: { score: 3, minPlayers: 2, bonus: 3 },
  volunteer: { score: 3, bonus: 3 },
  // ── 성장 ──
  study: {
    stages: [
      { from: 1, to: 2, score: 1, high: false },
      { from: 3, to: 4, score: 3, high: false },
      { from: 5, to: 7, score: 7, high: true },
      { from: 8, to: null, score: 10, high: true },
    ],
    baseScore: 1,
  },
  exercise: {
    stages: [
      { from: 1, to: 3, score: 1 },
      { from: 4, to: 6, score: 2 },
      { from: 7, to: 10, score: 3 },
      { from: 11, to: 15, score: 4 },
      { from: 16, to: null, score: 5 },
    ],
  },
  project: { score: 1, every: 3, bonus: 7 },
  create: { score: 1, bonus: 10, chancePerUse: 0.05, chanceCap: 0.4 },
  relationship: {
    stages: [
      { from: 1, to: 2, score: 1, reachBonus: 0 },
      { from: 3, to: 5, score: 2, reachBonus: 3 },
      { from: 6, to: 9, score: 3, reachBonus: 5 },
      { from: 10, to: null, score: 4, reachBonus: 8 },
    ],
  },
  // ── 회복 ──
  rest: { score: 0, targetHabitDelta: -3 },
  meditate: { score: 1, targetHabitDelta: -1 },
  detox: { score: 0, habitDeltas: { sns: -2, binge_game: -2 } },
  change_env: { score: 0 },
};

/** 표시 순서·이름·유형·행동력·대상 필요 여부 */
export const ACTION_BASE: { id: ActionId; name: string; category: ActionCategory; cost: 1 | 2; needsTarget: boolean }[] = [
  { id: 'drink', name: '음주', category: 'instant', cost: 1, needsTarget: false },
  { id: 'smoke', name: '흡연', category: 'instant', cost: 1, needsTarget: false },
  { id: 'gamble', name: '도박', category: 'instant', cost: 1, needsTarget: false },
  { id: 'sns', name: 'SNS', category: 'instant', cost: 1, needsTarget: false },
  { id: 'shopping', name: '쇼핑', category: 'instant', cost: 1, needsTarget: false },
  { id: 'binge_game', name: '게임 몰아하기', category: 'instant', cost: 1, needsTarget: false },
  { id: 'walk', name: '산책', category: 'stable', cost: 1, needsTarget: true },
  { id: 'music', name: '음악 감상', category: 'stable', cost: 1, needsTarget: false },
  { id: 'cook', name: '요리', category: 'stable', cost: 1, needsTarget: false },
  { id: 'friends', name: '친구 만나기', category: 'stable', cost: 1, needsTarget: false },
  { id: 'volunteer', name: '봉사 활동', category: 'stable', cost: 1, needsTarget: false },
  { id: 'study', name: '공부', category: 'growth', cost: 1, needsTarget: false },
  { id: 'exercise', name: '운동', category: 'growth', cost: 1, needsTarget: false },
  { id: 'project', name: '업무·프로젝트', category: 'growth', cost: 1, needsTarget: false },
  { id: 'create', name: '창작 활동', category: 'growth', cost: 1, needsTarget: false },
  { id: 'relationship', name: '관계·연애', category: 'growth', cost: 1, needsTarget: false },
  { id: 'rest', name: '휴식', category: 'recovery', cost: 1, needsTarget: true },
  { id: 'meditate', name: '명상', category: 'recovery', cost: 1, needsTarget: true },
  { id: 'detox', name: '디지털 디톡스', category: 'recovery', cost: 1, needsTarget: false },
  { id: 'change_env', name: '환경 바꾸기', category: 'recovery', cost: 2, needsTarget: true },
];
