// Socket.IO 통신 계약. 서버와 클라이언트가 공유한다.
// 모든 명령은 ack 콜백으로 Ack<T>를 받는다. room:resume을 제외한 명령은 requestId로 재전송을 식별한다. 상태는 'room:snapshot' 전체 스냅샷으로만 동기화한다.
import type { DayResult, Plan, PlayerRuleState } from './types';

export type Phase = 'LOBBY' | 'DAY' | 'RESOLVING' | 'NIGHT_RESULT' | 'FINISHED';

export type ErrorCode =
  | 'BAD_REQUEST'        // 형식 오류·입력 크기 초과
  | 'RATE_LIMITED'
  | 'NICKNAME_INVALID'   // 공백 정리 후 1~12자 아님
  | 'NICKNAME_TAKEN'
  | 'ROOM_NOT_FOUND'     // 존재한 적 없는 코드
  | 'ROOM_EXPIRED'       // 만료·정리된 방 (코드·토큰 모두)
  | 'ROOM_FULL'
  | 'GAME_IN_PROGRESS'   // 시작 후 신규 입장
  | 'TOKEN_INVALID'      // 복귀 실패 (폐기·알 수 없는 토큰)
  | 'NOT_AUTHENTICATED'  // 이 소켓에 바인딩된 참가자 없음 / 다른 연결에 권한 이전됨
  | 'NOT_HOST'
  | 'NOT_READY'          // 시작 조건 미충족 (인원·연결·준비)
  | 'BAD_PHASE'
  | 'STALE_GAME'         // gameId 불일치
  | 'STALE_DAY'          // day 불일치
  | 'ALREADY_SUBMITTED'
  | 'INVALID_PLAN'
  | 'FORFEITED'
  | 'INTERNAL';          // 서버 내부 오류 (예상하지 못한 예외)

export type Ack<T = {}> = ({ ok: true } & T) | { ok: false; code: ErrorCode; message: string };

export interface PublicPlayer {
  playerId: string;
  nickname: string;
  /** 입장 순서 (방장 이전 기준) */
  joinOrder: number;
  connected: boolean;
  ready: boolean;
  forfeited: boolean;
  /** 현재 일차 계획 제출 여부 (내용은 비공개) */
  submitted: boolean;
}

export interface PublicGame {
  gameId: string;
  rulesVersion: string;
  day: number;
  maxDays: number;
  targetScore: number;
  /** 현재 단계 마감 시각 (서버 epoch ms). DAY·NIGHT_RESULT에서만 의미 */
  deadline: number | null;
  /** 참가자 규칙 상태 (점수·사용 횟수·습관 등). 기권자 포함 */
  players: PlayerRuleState[];
  /** 가장 최근 하루 결과 (NIGHT_RESULT·FINISHED·다음 DAY에서 표시) */
  lastResult: DayResult | null;
  /** 지난 일차 결과 기록 (오래된 것부터) */
  history: DayResult[];
  /** FINISHED일 때만 의미. 비어 있으면 승자 없음 */
  winnerIds: string[];
}

export interface RoomSnapshot {
  /** 방 단위 단조 증가. 클라이언트는 이미 반영한 값 이하의 스냅샷을 버린다 */
  revision: number;
  code: string;
  phase: Phase;
  hostPlayerId: string;
  players: PublicPlayer[];
  game: PublicGame | null;
  /** 스냅샷 생성 시각 (서버 epoch ms) — 클라이언트 시계 보정용 */
  serverNow: number;
  /** 수신자 본인 정보 (수신자별로 다르게 보냄) */
  you: { playerId: string; submittedPlan: Plan | null };
}

export interface JoinResult {
  playerId: string;
  /** 참가자 비밀 토큰. sessionStorage에만 보관 */
  token: string;
  snapshot: RoomSnapshot;
}

export interface ClientToServerEvents {
  'room:create': (p: { requestId: string; nickname: string }, ack: (r: Ack<JoinResult>) => void) => void;
  'room:join': (p: { requestId: string; code: string; nickname: string }, ack: (r: Ack<JoinResult>) => void) => void;
  'room:resume': (p: { token: string }, ack: (r: Ack<JoinResult>) => void) => void;
  'room:leave': (p: { requestId: string }, ack: (r: Ack) => void) => void;
  'lobby:ready': (p: { requestId: string; ready: boolean }, ack: (r: Ack) => void) => void;
  'game:start': (p: { requestId: string }, ack: (r: Ack) => void) => void;
  'game:submit': (p: { requestId: string; gameId: string; day: number; plan: Plan }, ack: (r: Ack) => void) => void;
  'game:rematch': (p: { requestId: string; gameId: string }, ack: (r: Ack) => void) => void;
}

export interface ServerToClientEvents {
  'room:snapshot': (s: RoomSnapshot) => void;
  /** 이 연결의 조작 권한이 해제됨 (같은 토큰의 새 연결이 인증됨 / 방 정리됨) */
  'session:revoked': (p: { reason: 'REPLACED' | 'ROOM_EXPIRED' | 'LEFT' }) => void;
}
