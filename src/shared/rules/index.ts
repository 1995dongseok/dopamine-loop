// 규칙 계층 공개 API (계약). 서버·클라이언트·시뮬레이션은 이 파일에서만 import 한다.
// 구현 담당: rules 세션. 시그니처를 바꿀 때는 서버·클라이언트 사용처도 함께 고쳐야 한다.
// 모든 함수는 순수 함수(Node/DOM API 미사용)이며 입력을 변경하지 않는다.
//
// export 목록:
//   GAME_CONSTANTS, ACTIONS, getAction, createPlayerState, validatePlan, emptyPlan,
//   resolveDay(players, plans, day, rng), checkWinner(players, day),
//   previewAction(player, actionId, day?), nightOdds(player, plan?), seededRng(seed)
//   (추가) previewPlannedAction(player, actionId, plannedSlotsBefore, day?), stateBeforePlannedSlot, habitsAfterPlan
//   (추가) ACTION_DATA·RULE_DATA — 수치 원본(RULE_DATA: 초반 도파민 보너스·같은 날 반복 피로), isActionId — 타입 가드
export { GAME_CONSTANTS } from './constants';
export { ACTIONS, getAction, isActionId } from './meta';
export { ACTION_DATA, RULE_DATA } from './actionData';
export { createPlayerState, seededRng } from './state';
export { validatePlan, emptyPlan } from './validate';
export { resolveDay, checkWinner } from './resolve';
export { previewAction, nightOdds, habitsAfterPlan, previewPlannedAction, stateBeforePlannedSlot } from './preview';
