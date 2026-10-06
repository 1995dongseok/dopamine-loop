// 규칙 계층 공개 API (계약). 서버·클라이언트·시뮬레이션은 이 파일에서만 import 한다.
// 구현 담당: rules 세션. 시그니처를 바꿀 때는 서버·클라이언트 사용처도 함께 고쳐야 한다.
import type {
  ActionId, ActionMeta, ActionPreview, Counts, DayResult, Plan, PlanValidation, PlayerRuleState, Rng, WinCheck,
} from '../types';

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

const notImplemented = (): never => { throw new Error('rules: not implemented yet'); };

/** 20개 행동 메타데이터 (표시 순서). description은 rules 세션이 확정 수치에 맞춰 갱신한다. */
const m = (id: ActionId, name: string, category: ActionMeta['category'], description: string, o: Partial<ActionMeta> = {}): ActionMeta =>
  ({ id, name, category, cost: 1, needsTarget: false, formsHabit: category !== 'recovery', description, ...o });
export const ACTIONS: ActionMeta[] = [
  m('drink', '음주', 'instant', '초반 큰 보상, 반복하면 손실'),
  m('smoke', '흡연', 'instant', '작은 초반 보상, 반복 시 작은 손실'),
  m('gamble', '도박', 'instant', '확률적 이득/손실, 반복할수록 기대값 감소'),
  m('sns', 'SNS', 'instant', '작은 보상, 빠르게 감소 후 손실'),
  m('shopping', '쇼핑', 'instant', '초반 고보상, 누적 손실, 같은 날 재사용 감점'),
  m('binge_game', '게임 몰아하기', 'instant', '초반 고보상, 누적 손실, 연속 사용 감점'),
  m('walk', '산책', 'stable', '작은 고정 점수, 낮에 대상 습관 -1', { needsTarget: true }),
  m('music', '음악 감상', 'stable', '고정 점수, 밤에 나오면 추가 점수'),
  m('cook', '요리', 'stable', '고정 점수, 그날 첫 사용 보너스'),
  m('friends', '친구 만나기', 'stable', '고정 점수, 같은 슬롯 2명 이상이면 보너스'),
  m('volunteer', '봉사 활동', 'stable', '고정 점수, 슬롯 시작 시 최저 점수면 보너스'),
  m('study', '공부', 'growth', '사용할수록 보상 상승, 고보상은 하루 1회'),
  m('exercise', '운동', 'growth', '완만하게 상승, 일일 제한 없음'),
  m('project', '업무·프로젝트', 'growth', '작은 기본 점수, 일정 횟수마다 완료 보너스'),
  m('create', '창작 활동', 'growth', '작은 기본 점수, 완성 보너스 확률 상승'),
  m('relationship', '관계·연애', 'growth', '관계 단계에 따른 보상과 단계 도달 보너스'),
  m('rest', '휴식', 'recovery', '점수 0, 대상 습관 -3', { needsTarget: true }),
  m('meditate', '명상', 'recovery', '작은 점수, 대상 습관 -1', { needsTarget: true }),
  m('detox', '디지털 디톡스', 'recovery', '점수 0, SNS·게임 습관 각 -2'),
  m('change_env', '환경 바꾸기', 'recovery', '행동력 2, 대상 습관을 0으로', { cost: 2, needsTarget: true }),
];
export const getAction = (id: ActionId): ActionMeta => ACTIONS.find((a) => a.id === id) ?? notImplemented();

/** 점수 0, 사용 횟수·습관 0인 초기 상태 */
export function createPlayerState(playerId: string): PlayerRuleState { return notImplemented(); }

/** 계획 형식·행동 ID·대상·행동력·비용 2 배치 검사 (순수 함수, 서버가 호출) */
export function validatePlan(plan: unknown): PlanValidation { return notImplemented(); }

/** 무행동 계획 (미제출자용) */
export function emptyPlan(): Plan { return { slots: [null, null, null] }; }

/**
 * 하루 전체 정산: 하루 기록 초기화 → 낮 슬롯 0,1,2 순 처리 → 습관 분포 확정 → 밤 2회 추첨.
 * players의 forfeited 참가자는 건너뛴다. 입력을 변경하지 않고 새 상태를 반환한다.
 * plans[playerId]가 없거나 null이면 무행동.
 */
export function resolveDay(
  players: PlayerRuleState[],
  plans: Record<string, Plan | null | undefined>,
  day: number,
  rng: Rng,
): { players: PlayerRuleState[]; result: DayResult } { return notImplemented(); }

/** 밤 정산 이후 승리 판정 (목표 점수 이상 최고점, 동점 공동, maxDays 도달 시 최고점, 기권자 제외) */
export function checkWinner(players: PlayerRuleState[], day: number): WinCheck { return notImplemented(); }

/** 카드 표시용: 현재 상태에서 이 행동을 다음에 쓸 때의 결과 범위 */
export function previewAction(player: PlayerRuleState, actionId: ActionId): ActionPreview { return notImplemented(); }

/** 예상 밤 확률: 현재 습관에 계획(낮 실행분 습관 증가·회복 감소)을 반영한 분포. 0~1 */
export function nightOdds(player: PlayerRuleState, plan?: Plan | null): Counts { return notImplemented(); }

/** 시드 고정 난수원 */
export function seededRng(seed: number): Rng { return notImplemented(); }
