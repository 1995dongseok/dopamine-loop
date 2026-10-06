import type { ErrorCode } from '../../shared/protocol';

const MESSAGES: Record<ErrorCode | 'TIMEOUT', string> = {
  BAD_REQUEST: '요청 형식이 올바르지 않습니다.',
  RATE_LIMITED: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  NICKNAME_INVALID: '닉네임은 공백을 제외하고 1~12자로 입력해 주세요.',
  NICKNAME_TAKEN: '이미 방에서 사용 중인 닉네임입니다.',
  ROOM_NOT_FOUND: '해당 초대코드의 방을 찾을 수 없습니다.',
  ROOM_EXPIRED: '방이 만료되었습니다.',
  ROOM_FULL: '방이 가득 찼습니다. (최대 6명)',
  GAME_IN_PROGRESS: '이미 게임이 시작된 방입니다.',
  TOKEN_INVALID: '접속 정보가 유효하지 않습니다.',
  NOT_AUTHENTICATED: '접속이 확인되지 않았습니다. 다시 연결하는 중입니다.',
  NOT_HOST: '방장만 할 수 있습니다.',
  NOT_READY: '시작 조건(2~6명, 전원 연결·준비)이 충족되지 않았습니다.',
  BAD_PHASE: '지금은 할 수 없는 동작입니다.',
  STALE_GAME: '이미 지난 게임에 대한 요청입니다.',
  STALE_DAY: '이미 지난 일차에 대한 요청입니다.',
  ALREADY_SUBMITTED: '이미 오늘 계획을 확정했습니다.',
  INVALID_PLAN: '계획이 올바르지 않습니다.',
  FORFEITED: '기권한 참가자는 조작할 수 없습니다.',
  TIMEOUT: '서버 응답이 없습니다. 연결 상태를 확인해 주세요.',
};

export function errorText(code: string): string {
  return (MESSAGES as Record<string, string>)[code] ?? '알 수 없는 오류가 발생했습니다.';
}
