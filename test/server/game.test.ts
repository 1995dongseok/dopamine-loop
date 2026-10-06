// 게임 진행 통신 테스트 (실제 규칙 함수 사용). 실제 서버 + socket.io-client 2개 이상.
import { afterEach, describe, expect, it } from 'vitest';
import type { GameServer } from '../../src/server/gameServer';
import { seededRng } from '../../src/shared/rules';
import type { Plan } from '../../src/shared/types';
import { PLAN_A, PLAN_B, TestClient, newRequestId, sleep, startGame, startServer } from './helpers';

let servers: GameServer[] = [];
let clients: TestClient[] = [];

async function server(opts: Parameters<typeof startServer>[0] = {}) {
  const s = await startServer({ createRng: () => seededRng(42), ...opts });
  servers.push(s.gs);
  return s;
}
async function client(url: string) {
  const c = await TestClient.connect(url);
  clients.push(c);
  return c;
}

afterEach(async () => {
  clients.forEach((c) => c.close());
  clients = [];
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

const EMPTY: Plan = { slots: [null, null, null] };

describe('game flow', () => {
  it('runs DAY → NIGHT_RESULT → DAY with private plans and per-recipient snapshots', async () => {
    const { url, gs } = await server({ timings: { nightResultMs: 300 } });
    const { host: a, all, gameId, code } = await startGame(url, 2, clients);
    const b = all[1];
    const s0 = a.latest!;
    expect(s0.game!.rulesVersion).toBeTruthy();
    expect(s0.game!.maxDays).toBe(10);
    expect(s0.game!.targetScore).toBe(100);
    expect(s0.game!.deadline).toBeGreaterThan(s0.serverNow);
    expect(s0.game!.players.map((p) => p.score)).toEqual([0, 0]);

    expect((await a.submit(gameId, 1, PLAN_A)).ok).toBe(true);
    const sa = await a.waitFor((s) => s.you.submittedPlan !== null);
    expect(sa.you.submittedPlan).toEqual(PLAN_A);
    const sb = await b.waitFor((s) => s.players[0].submitted);
    expect(sb.you.submittedPlan).toBeNull();
    // B가 정산 전에 받은 어떤 스냅샷에도 A의 계획 내용이 없음
    const beforeB = JSON.stringify(b.snapshots);
    expect(beforeB).not.toContain('drink');
    expect(beforeB).not.toContain('study');

    expect((await b.submit(gameId, 1, PLAN_B)).ok).toBe(true);
    const night = await a.waitFor((s) => s.phase === 'NIGHT_RESULT');
    expect(night.game!.day).toBe(1);
    expect(night.game!.lastResult!.day).toBe(1);
    expect(night.game!.history.length).toBe(1);
    expect(night.game!.deadline).not.toBeNull();
    const dayEvents = night.game!.lastResult!.dayEvents;
    expect(dayEvents.some((e) => e.playerId === a.playerId && e.actionId === 'drink')).toBe(true);
    expect(dayEvents.some((e) => e.playerId === b.playerId && e.actionId === 'friends')).toBe(true);

    const d2 = await b.waitFor((s) => s.phase === 'DAY' && s.game!.day === 2, 3000);
    expect(d2.you.submittedPlan).toBeNull();
    expect(d2.players.every((p) => !p.submitted)).toBe(true);
    expect(d2.game!.lastResult!.day).toBe(1);
    expect(gs.debugRoom(code)!.historyDays).toEqual([1]);
  });

  it('rejects joining after start', async () => {
    const { url } = await server();
    const { code } = await startGame(url, 2, clients);
    const late = await client(url);
    expect((await late.join(code, 'late')).code).toBe('GAME_IN_PROGRESS');
    expect((await clients[0].ready(false)).code).toBe('BAD_PHASE');
    expect((await clients[0].start()).code).toBe('BAD_PHASE');
  });

  it('rejects duplicate, stale-day, stale-game, invalid and wrong-phase submits', async () => {
    const { url } = await server({ timings: { nightResultMs: 2000 } });
    const { host: a, all, gameId } = await startGame(url, 2, clients);
    const b = all[1];
    expect((await a.submit(gameId, 1, { slots: [{ actionId: 'nope' }, null, null] } as any)).code).toBe('INVALID_PLAN');
    expect((await a.submit(gameId, 1, { slots: [null, null] } as any)).code).toBe('INVALID_PLAN');
    expect((await a.submit(gameId, 1, { slots: [{ actionId: 'rest' }, null, null] })).code).toBe('INVALID_PLAN'); // 대상 없음
    expect((await a.submit(gameId, 2, PLAN_A)).code).toBe('STALE_DAY');
    expect((await a.submit(gameId, 0, PLAN_A)).code).toBe('STALE_DAY');
    expect((await a.submit('g_old', 1, PLAN_A)).code).toBe('STALE_GAME');
    expect((await a.emit('game:submit', { requestId: newRequestId(), gameId, day: '1', plan: PLAN_A })).code).toBe('BAD_REQUEST');

    const rid = newRequestId();
    expect(await a.submit(gameId, 1, PLAN_A, rid)).toEqual({ ok: true });
    // 같은 requestId 재전송 → 저장된 응답 재생 (내용이 달라도 다시 실행 안 함)
    expect(await a.submit(gameId, 1, EMPTY, rid)).toEqual({ ok: true });
    // 다른 requestId 중복 제출 → 차단
    expect((await a.submit(gameId, 1, EMPTY)).code).toBe('ALREADY_SUBMITTED');
    expect((await a.waitFor((s) => s.you.submittedPlan !== null)).you.submittedPlan).toEqual(PLAN_A);

    await b.submit(gameId, 1, PLAN_B);
    await b.waitFor((s) => s.phase === 'NIGHT_RESULT');
    expect((await b.submit(gameId, 1, PLAN_B)).code).toBe('BAD_PHASE');
    expect(await a.submit(gameId, 1, EMPTY, rid)).toEqual({ ok: true }); // 재생은 단계와 무관
  });

  it('locks at the deadline; unsubmitted players get an empty plan', async () => {
    const { url } = await server({ timings: { dayMs: 400 } });
    const { host: a, all, gameId } = await startGame(url, 2, clients);
    const b = all[1];
    await a.submit(gameId, 1, PLAN_A);
    const night = await b.waitFor((s) => s.phase === 'NIGHT_RESULT', 3000);
    const bDay = night.game!.lastResult!.dayEvents.filter((e) => e.playerId === b.playerId);
    expect(bDay.every((e) => e.actionId === null && e.delta === 0)).toBe(true);
    expect((await b.submit(gameId, 1, PLAN_B)).code).toBe('BAD_PHASE');
  });

  it('deadline vs all-submitted race resolves exactly once', async () => {
    const { url, gs } = await server({ timings: { dayMs: 300, nightResultMs: 400 } });
    const { host: a, all, gameId, code } = await startGame(url, 2, clients);
    const b = all[1];
    await a.submit(gameId, 1, PLAN_A);
    // 마감 직전·직후에 걸쳐 제출 (어느 쪽이 먼저든 한 번만 정산)
    await sleep(290);
    const rb = await b.submit(gameId, 1, PLAN_B);
    expect(rb.ok || rb.code === 'BAD_PHASE').toBe(true);
    await a.waitFor((s) => s.phase === 'NIGHT_RESULT');
    // 오래된 마감 타이머가 늦게 실행되어도 무시
    gs.fireDayDeadline(code, gameId, 1);
    gs.fireDayDeadline(code, gameId, 1);
    expect(gs.debugRoom(code)!.historyDays).toEqual([1]);
    expect(gs.debugRoom(code)!.phase).toBe('NIGHT_RESULT');

    // 2일차: 전원 제출 경로 직후 마감 콜백이 겹쳐도 한 번
    await a.waitFor((s) => s.phase === 'DAY' && s.game!.day === 2, 3000);
    gs.fireDayDeadline(code, gameId, 1); // 이전 일차 타이머 → 무시
    expect(gs.debugRoom(code)!.phase).toBe('DAY');
    await a.submit(gameId, 2, PLAN_A);
    await b.submit(gameId, 2, PLAN_B);
    gs.fireDayDeadline(code, gameId, 2);
    gs.fireDayDeadline('g_other', gameId, 2);
    expect(gs.debugRoom(code)!.historyDays).toEqual([1, 2]);
    const s = await a.waitFor((x) => x.phase === 'NIGHT_RESULT' && x.game!.day === 2);
    expect(s.game!.history.map((h) => h.day)).toEqual([1, 2]);
    // revision 단조 증가
    const revs = a.snapshots.map((x) => x.revision);
    for (let i = 1; i < revs.length; i++) expect(revs[i]).toBeGreaterThan(revs[i - 1]);
  });
});

describe('reconnect during game', () => {
  it('resume returns same player, score and submitted plan with no double resolution', async () => {
    const { url, gs } = await server({ timings: { nightResultMs: 300 } });
    const { host: a, all, gameId, code } = await startGame(url, 2, clients);
    const b = all[1];
    await a.submit(gameId, 1, PLAN_A);
    await b.submit(gameId, 1, PLAN_B);
    await a.waitFor((s) => s.phase === 'DAY' && s.game!.day === 2, 3000);

    // 2일차: B 제출 후 연결 끊김
    await b.submit(gameId, 2, PLAN_A);
    const { token, playerId } = b;
    b.close();
    const sDisc = await a.waitFor((s) => !s.players[1].connected);
    expect(sDisc.players[1].submitted).toBe(true);
    expect(sDisc.phase).toBe('DAY');

    const b2 = await client(url);
    const r = await b2.resume(token);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playerId).toBe(playerId);
    expect(r.snapshot.phase).toBe('DAY');
    expect(r.snapshot.game!.day).toBe(2);
    expect(r.snapshot.you.submittedPlan).toEqual(PLAN_A);
    expect(r.snapshot.game!.lastResult!.day).toBe(1);
    const myScore = r.snapshot.game!.players.find((p) => p.playerId === playerId)!.score;
    expect(myScore).toBe(a.latest!.game!.players.find((p) => p.playerId === playerId)!.score);
    // 복귀 후 재제출 불가 (계획 유지)
    expect((await b2.submit(gameId, 2, PLAN_B)).code).toBe('ALREADY_SUBMITTED');

    await a.submit(gameId, 2, PLAN_B);
    await b2.waitFor((s) => s.phase === 'NIGHT_RESULT' && s.game!.day === 2);
    // 다시 끊었다 복귀해도 정산이 반복되지 않음
    b2.close();
    await a.waitFor((s) => !s.players[1].connected);
    const b3 = await client(url);
    const r3 = await b3.resume(token);
    if (!r3.ok) throw new Error(r3.code);
    expect(r3.snapshot.game!.history.map((h) => h.day)).toEqual([1, 2]);
    expect(r3.snapshot.game!.lastResult!.day).toBe(2);
    expect(gs.debugRoom(code)!.historyDays).toEqual([1, 2]);
  });

  it('game continues on schedule while a player is disconnected', async () => {
    const { url } = await server({ timings: { dayMs: 300, nightResultMs: 200 } });
    const { host: a, all, gameId } = await startGame(url, 2, clients);
    const b = all[1];
    const token = b.token;
    b.close();
    await a.submit(gameId, 1, PLAN_A);
    await a.waitFor((s) => s.phase === 'DAY' && s.game!.day === 2, 3000);
    const b2 = await client(url);
    const r = await b2.resume(token);
    if (!r.ok) throw new Error(r.code);
    expect(r.snapshot.game!.day).toBeGreaterThanOrEqual(2);
    expect(r.snapshot.game!.history[0].dayEvents.filter((e) => e.playerId === b.playerId).every((e) => e.actionId === null)).toBe(true);
  });

  it('old socket is revoked after resume during game', async () => {
    const { url } = await server();
    const { all, gameId } = await startGame(url, 2, clients);
    const b = all[1];
    const b2 = await client(url);
    expect((await b2.resume(b.token)).ok).toBe(true);
    expect(await b.waitRevoked()).toBe('REPLACED');
    expect((await b.submit(gameId, 1, PLAN_A)).code).toBe('NOT_AUTHENTICATED');
    expect((await b2.submit(gameId, 1, PLAN_A)).ok).toBe(true);
  });

  it('transfers host after grace during a game; non-host cannot rematch', async () => {
    const { url } = await server({ timings: { hostGraceMs: 200 } });
    const { host: a, all, gameId } = await startGame(url, 3, clients);
    a.close();
    const s = await all[1].waitFor((x) => x.hostPlayerId === all[1].playerId, 3000, 'host transfer');
    expect(s.phase).toBe('DAY');
    expect((await all[2].rematch(gameId)).code).toBe('NOT_HOST');
    expect((await all[1].rematch(gameId)).code).toBe('BAD_PHASE');
  });
});

describe('leave / forfeit / rematch', () => {
  it('leave during game forfeits; last remaining player wins', async () => {
    const { url } = await server();
    const { host: a, all, gameId } = await startGame(url, 3, clients);
    const [, b, c] = all;
    const cToken = c.token;
    expect((await c.leave()).ok).toBe(true);
    const s1 = await a.waitFor((s) => s.players[2].forfeited);
    expect(s1.phase).toBe('DAY');
    expect(s1.game!.players.find((p) => p.playerId === c.playerId)!.forfeited).toBe(true);
    const x = await client(url);
    expect((await x.resume(cToken)).code).toBe('TOKEN_INVALID');

    // 남은 두 명 제출 → 기권자 제외하고 정산
    await a.submit(gameId, 1, PLAN_A);
    await b.submit(gameId, 1, PLAN_B);
    const night = await a.waitFor((s) => s.phase === 'NIGHT_RESULT');
    expect(night.game!.lastResult!.dayEvents.some((e) => e.playerId === c.playerId && e.actionId !== null)).toBe(false);

    // 방장 A가 나감 → B 혼자 → B 승리, 방장 즉시 이전
    expect((await a.leave()).ok).toBe(true);
    const fin = await b.waitFor((s) => s.phase === 'FINISHED');
    expect(fin.game!.winnerIds).toEqual([b.playerId]);
    expect(fin.hostPlayerId).toBe(b.playerId);
  });

  it('leaving with an unsubmitted player remaining triggers lock when others submitted', async () => {
    const { url } = await server();
    const { host: a, all, gameId } = await startGame(url, 3, clients);
    await a.submit(gameId, 1, PLAN_A);
    await all[1].submit(gameId, 1, PLAN_B);
    await all[2].leave();
    const s = await a.waitFor((x) => x.phase === 'NIGHT_RESULT');
    expect(s.game!.history.length).toBe(1);
  });

  it('plays to FINISHED, then rematch keeps connected players with a new gameId', async () => {
    const { url } = await server({ timings: { nightResultMs: 50 } });
    const { host: a, all, gameId, code } = await startGame(url, 3, clients);
    const [, b, c] = all;
    const cToken = c.token;
    let day = 1;
    for (;;) {
      const s = await a.waitFor((x) => (x.phase === 'DAY' && x.game!.day === day) || x.phase === 'FINISHED', 5000);
      if (s.phase === 'FINISHED') break;
      expect((await a.submit(gameId, day, PLAN_A)).ok).toBe(true);
      expect((await b.submit(gameId, day, PLAN_B)).ok).toBe(true);
      expect((await c.submit(gameId, day, EMPTY)).ok).toBe(true);
      await a.waitFor((x) => x.phase !== 'DAY' || x.game!.day !== day);
      day++;
    }
    const fin = a.latest!;
    expect(fin.game!.history.length).toBeLessThanOrEqual(10);
    expect(fin.game!.history.map((h) => h.day)).toEqual(Array.from({ length: fin.game!.history.length }, (_, i) => i + 1));
    expect(fin.game!.winnerIds.length).toBeGreaterThan(0);
    expect(fin.game!.deadline).toBeNull();
    const top = Math.max(...fin.game!.players.filter((p) => !p.forfeited).map((p) => p.score));
    for (const id of fin.game!.winnerIds) expect(fin.game!.players.find((p) => p.playerId === id)!.score).toBe(top);

    c.close(); // 연결만 끊김 (기권 아님) → 다시 하기에서 제외
    await a.waitFor((s) => !s.players[2].connected);
    expect((await b.rematch(gameId)).code).toBe('NOT_HOST');
    expect((await a.rematch('g_wrong')).code).toBe('STALE_GAME');
    expect((await a.rematch(gameId)).ok).toBe(true);
    const lobby = await b.waitFor((s) => s.phase === 'LOBBY');
    expect(lobby.game).toBeNull();
    expect(lobby.players.map((p) => p.playerId)).toEqual([a.playerId, b.playerId]);
    expect(lobby.players.every((p) => !p.ready)).toBe(true);
    const x = await client(url);
    expect((await x.resume(cToken)).code).toBe('TOKEN_INVALID');

    // 새 참가자 입장 가능, 새 gameId로 다시 시작
    expect((await x.join(code, 'newbie')).ok).toBe(true);
    for (const cl of [a, b, x]) expect((await cl.ready(true)).ok).toBe(true);
    expect((await a.start()).ok).toBe(true);
    const s2 = await a.waitFor((s) => s.phase === 'DAY');
    expect(s2.game!.gameId).not.toBe(gameId);
    expect(s2.game!.day).toBe(1);
    expect(s2.game!.history).toEqual([]);
    expect((await a.submit(gameId, 1, PLAN_A)).code).toBe('STALE_GAME');
  });
});
