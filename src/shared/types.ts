// 게임 규칙 계층의 공용 타입. 서버·클라이언트·규칙 함수가 모두 이 파일을 기준으로 한다.

export const ACTION_IDS = [
  // 즉시
  'drink', 'smoke', 'gamble', 'sns', 'shopping', 'binge_game',
  // 안정
  'walk', 'music', 'cook', 'friends', 'volunteer',
  // 성장
  'study', 'exercise', 'project', 'create', 'relationship',
  // 회복
  'rest', 'meditate', 'detox', 'change_env',
] as const;

export type ActionId = (typeof ACTION_IDS)[number];
export type ActionCategory = 'instant' | 'stable' | 'growth' | 'recovery';

/** 화면 표시와 검증에 필요한 행동 메타데이터. 수치 규칙은 rules 쪽 데이터가 별도로 가진다. */
export interface ActionMeta {
  id: ActionId;
  name: string;
  category: ActionCategory;
  cost: 1 | 2;
  /** 낮 실행 시 습관 감소 대상 행동을 지정해야 하는지 (산책·휴식·명상·환경 바꾸기) */
  needsTarget: boolean;
  /** 습관을 만드는 일반 행동인지 (회복 행동은 false). 회복 대상은 이 값이 true인 행동만 가능 */
  formsHabit: boolean;
  /** 카드에 표시할 한 줄 설명 (실제 수치와 일치해야 함) */
  description: string;
}

/** 계획의 한 칸. 비용 2 행동은 slots[i]에 놓이고 slots[i+1]은 반드시 null(소비된 칸)이다. */
export interface PlanSlot {
  actionId: ActionId;
  /** needsTarget 행동의 대상. 대상은 formsHabit 행동 중 하나 */
  targetId?: ActionId;
}

/** 낮 계획. slots 길이는 항상 3. null은 무행동(또는 비용 2 행동이 소비한 칸). */
export interface Plan {
  slots: [PlanSlot | null, PlanSlot | null, PlanSlot | null];
}

export type Counts = Partial<Record<ActionId, number>>;

/** 한 참가자의 규칙상 상태. 공개 스냅샷에 그대로 실린다(비공개 정보 없음). */
export interface PlayerRuleState {
  playerId: string;
  score: number;
  /** 누적 사용 횟수 (보상 단계에 사용, 회복으로 되돌리지 않음) */
  uses: Counts;
  /** 습관 수치 (밤 추첨 확률에만 사용) */
  habits: Counts;
  /** 오늘 사용 횟수 (낮+밤 합산, 다음 낮 시작 시 초기화) */
  dailyUses: Counts;
  /** 같은 날 직전 실제 행동과 연속 횟수. 무행동·회복 행동·다음 낮에 초기화 */
  streakAction: ActionId | null;
  streakCount: number;
  /** 규칙 구현이 필요로 하는 추가 기록(예: 하루 1회 고보상 사용 여부). 키는 rules가 정의 */
  flags: Record<string, number>;
  forfeited: boolean;
}

/** 정산 중 발생한 개별 처리 기록. 화면은 이 목록을 순서대로 재생한다. */
export interface ResolutionEvent {
  phase: 'day' | 'night';
  /** 낮: 슬롯 번호 0~2, 밤: 추첨 번호 0~1 */
  index: number;
  playerId: string;
  /** null = 무행동 */
  actionId: ActionId | null;
  targetId?: ActionId;
  /** 하한 보정 후 실제 점수 변화 */
  delta: number;
  scoreAfter: number;
  /** 사람이 읽는 한국어 설명 조각. 예: ["3회째 보상 +4", "친구 보너스 +2"] */
  notes: string[];
}

export interface DayResult {
  day: number;
  dayEvents: ResolutionEvent[];
  nightEvents: ResolutionEvent[];
  /** 밤 추첨에 쓰인 확률 분포 (playerId → actionId → 0~1) */
  nightOdds: Record<string, Counts>;
  /** 하루 종료 후 점수 (playerId → score) */
  scoresAfter: Record<string, number>;
}

export interface WinCheck {
  finished: boolean;
  /** 공동 승리 가능. finished인데 비어 있으면 승자 없음 */
  winnerIds: string[];
}

/** [0,1) 난수원. 테스트·시뮬레이션에서 시드 고정 가능해야 한다. */
export interface Rng {
  next(): number;
}

/** 카드에 표시할 "이번 사용 시" 예상 */
export interface ActionPreview {
  actionId: ActionId;
  /** 다음 사용이 몇 회째인지 (uses+1) */
  nextUse: number;
  /** 결과 범위 (확률 행동이면 min<max) */
  min: number;
  max: number;
  /** 예: "2단계 · 다음 4회째부터 감소" 같은 짧은 설명 */
  label: string;
}

export type PlanValidation = { ok: true } | { ok: false; reason: string };

export const RULES_VERSION = '1.0.0';
