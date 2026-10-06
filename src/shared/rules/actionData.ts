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
      { from: 1, to: 1, score: 7 },
      { from: 2, to: 2, score: 3 },
      { from: 3, to: 4, score: -4 },
      { from: 5, to: null, score: -8 },
    ],
  },
  smoke: {
    stages: [
      { from: 1, to: 2, score: 3 },
      { from: 3, to: 4, score: 0 },
      { from: 5, to: null, score: -3 },
    ],
  },
  gamble: {
    stages: [
      { from: 1, to: 2, winChance: 0.5, win: 9, loss: -3 },
      { from: 3, to: 4, winChance: 0.35, win: 8, loss: -5 },
      { from: 5, to: null, winChance: 0.2, win: 7, loss: -8 },
    ],
  },
  sns: {
    stages: [
      { from: 1, to: 1, score: 4 },
      { from: 2, to: 2, score: 1 },
      { from: 3, to: 4, score: -1 },
      { from: 5, to: null, score: -4 },
    ],
  },
  shopping: {
    stages: [
      { from: 1, to: 1, score: 7 },
      { from: 2, to: 2, score: 2 },
      { from: 3, to: 3, score: -3 },
      { from: 4, to: null, score: -6 },
    ],
    sameDayPenalty: -3,
  },
  binge_game: {
    stages: [
      { from: 1, to: 1, score: 7 },
      { from: 2, to: 2, score: 2 },
      { from: 3, to: 3, score: -3 },
      { from: 4, to: null, score: -6 },
    ],
    streakPenalty: -3,
  },
  // ── 안정 ──
  walk: { score: 2, targetHabitDelta: -1 },
  music: { score: 2, nightBonus: 3 },
  cook: { score: 2, firstOfDayBonus: 3 },
  friends: { score: 3, minPlayers: 2, bonus: 3 },
  volunteer: { score: 2, bonus: 5 },
  // ── 성장 ──
  study: {
    stages: [
      { from: 1, to: 2, score: 1, high: false },
      { from: 3, to: 4, score: 3, high: false },
      { from: 5, to: 7, score: 5, high: true },
      { from: 8, to: null, score: 9, high: true },
    ],
    baseScore: 2,
  },
  exercise: {
    stages: [
      { from: 1, to: 3, score: 1 },
      { from: 4, to: 7, score: 2 },
      { from: 8, to: 12, score: 3 },
      { from: 13, to: null, score: 4 },
    ],
  },
  project: { score: 2, every: 3, bonus: 7 },
  create: { score: 1, bonus: 10, chancePerUse: 0.04, chanceCap: 0.3 },
  relationship: {
    stages: [
      { from: 1, to: 2, score: 1, reachBonus: 0 },
      { from: 3, to: 6, score: 2, reachBonus: 2 },
      { from: 7, to: 12, score: 3, reachBonus: 3 },
      { from: 13, to: null, score: 4, reachBonus: 4 },
    ],
  },
  // ── 회복 ──
  rest: { score: 0, targetHabitDelta: -3 },
  meditate: { score: 1, targetHabitDelta: -1 },
  detox: { score: 0, habitDeltas: { sns: -2, binge_game: -2 } },
  change_env: { score: 0 },
};

/**
 * 행동 하나가 아니라 유형 전체에 걸리는 규칙 수치 (단일 출처).
 * - instantEarlyBonus: 초반 도파민 보너스. 즉시 행동의 결과(보상·감점 합)가 양수면 그날 일차의 값을 더한다.
 *   index 0 = 1일째. 배열 밖 일차는 0. 낮·밤 모두 적용.
 * - sameDayFatigue: 같은 날 반복 피로. 안정·성장 행동을 같은 날(낮+밤 합산) fromDailyUse회째 이상 쓰면
 *   그 사용의 보상(단계·보너스·감점 전부)을 score로 대체한다. 낮·밤 모두 적용.
 */
export interface RuleData {
  instantEarlyBonus: number[];
  sameDayFatigue: { fromDailyUse: number; score: number };
}

export const RULE_DATA: RuleData = {
  instantEarlyBonus: [3, 2],
  sameDayFatigue: { fromDailyUse: 5, score: 1 },
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
