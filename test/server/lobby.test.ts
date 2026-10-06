// 방·대기실 통신 테스트 (규칙 함수 불필요). 실제 서버 + socket.io-client 2개 이상.
import { afterEach, describe, expect, it } from 'vitest';
import type { GameServer } from '../../src/server/gameServer';
import { CODE_ALPHABET } from '../../src/server/util';
import { TestClient, newRequestId, setupRoom, sleep, startServer } from './helpers';

let servers: GameServer[] = [];
let clients: TestClient[] = [];

async function server(opts: Parameters<typeof startServer>[0] = {}) {
  const s = await startServer(opts);
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

describe('room create / join', () => {
  it('creates a room and joins by code; both see each other', async () => {
    const { url } = await server();
    const a = await client(url);
    const b = await client(url);
    const ca = await a.create('  철수  ');
    expect(ca.ok).toBe(true);
    if (!ca.ok) return;
    expect(ca.snapshot.code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{6}$`));
    expect(ca.snapshot.code).not.toMatch(/[01OIL]/);
    expect(ca.token.length).toBeGreaterThanOrEqual(43);
    expect(ca.snapshot.hostPlayerId).toBe(ca.playerId);
    expect(ca.snapshot.players[0].nickname).toBe('철수');

    const jb = await b.join(ca.snapshot.code, '영희');
    expect(jb.ok).toBe(true);
    const sa = await a.waitFor((s) => s.players.length === 2);
    expect(sa.players.map((p) => p.nickname)).toEqual(['철수', '영희']);
    expect(sa.you.playerId).toBe(ca.playerId);
    expect(b.latest!.you.playerId).toBe(b.playerId);
    // 토큰은 공개 스냅샷에 절대 없음
    const all = JSON.stringify([...a.snapshots, ...b.snapshots]);
    expect(all).not.toContain(a.token);
    expect(all).not.toContain(b.token);
    // revision 단조 증가
    const revs = a.snapshots.map((s) => s.revision);
    expect([...revs].sort((x, y) => x - y)).toEqual(revs);
    expect(new Set(revs).size).toBe(revs.length);
  });

  it('normalizes invite code input (spaces, lowercase)', async () => {
    const { url } = await server();
    const a = await client(url);
    const b = await client(url);
    const ca = await a.create('A');
    if (!ca.ok) throw new Error();
    const code = ca.snapshot.code;
    const messy = ` ${code.slice(0, 3).toLowerCase()} ${code.slice(3).toLowerCase()}  `;
    const jb = await b.join(messy, 'B');
    expect(jb.ok).toBe(true);
  });

  it('rejects unknown codes as ROOM_NOT_FOUND', async () => {
    const { url } = await server();
    const a = await client(url);
    expect((await a.join('ZZZZZZ', 'x')).code).toBe('ROOM_NOT_FOUND');
    expect((await a.join('abc', 'x')).code).toBe('ROOM_NOT_FOUND');
  });

  it('rejects the 7th player with ROOM_FULL', async () => {
    const { url } = await server();
    const { code } = await setupRoom(url, 6, clients);
    const g = await client(url);
    expect((await g.join(code, 'seven')).code).toBe('ROOM_FULL');
  });

  it('validates nicknames: invalid and taken', async () => {
    const { url } = await server();
    const a = await client(url);
    const b = await client(url);
    expect((await a.create('   ')).code).toBe('NICKNAME_INVALID');
    expect((await a.create('1234567890123')).code).toBe('NICKNAME_INVALID');
    expect((await a.create('a\u0000b')).code).toBe('NICKNAME_INVALID');
    const ca = await a.create('Kim   Lee');
    if (!ca.ok) throw new Error();
    expect(ca.snapshot.players[0].nickname).toBe('Kim Lee');
    const code = ca.snapshot.code;
    expect((await b.join(code, '  kim lee ')).code).toBe('NICKNAME_TAKEN');
    expect((await b.join(code, '')).code).toBe('BAD_REQUEST');
    expect((await b.join(code, 'x'.repeat(200))).code).toBe('BAD_REQUEST');
    expect((await b.join(code, '123456789012')).ok).toBe(true);
  });

  it('rejects malformed / oversized payloads', async () => {
    const { url } = await server();
    const a = await client(url);
    expect((await a.emit('room:create', null)).code).toBe('BAD_REQUEST');
    expect((await a.emit('room:create', { nickname: 5 })).code).toBe('BAD_REQUEST');
    expect((await a.emit('room:create', { nickname: 'a', junk: 'x'.repeat(5000) })).code).toBe('BAD_REQUEST');
  });
});

describe('authentication and impersonation', () => {
  it('rejects commands from an unauthenticated socket', async () => {
    const { url } = await server();
    const { host } = await setupRoom(url, 2, clients);
    const stranger = await client(url);
    for (const [ev, p] of [
      ['lobby:ready', { requestId: newRequestId(), ready: true }],
      ['game:start', { requestId: newRequestId() }],
      ['game:submit', { requestId: newRequestId(), gameId: 'g_x', day: 1, plan: { slots: [null, null, null] } }],
      ['game:rematch', { requestId: newRequestId(), gameId: 'g_x' }],
      ['room:leave', { requestId: newRequestId() }],
    ] as const) {
      const r = await stranger.emit(ev, p);
      expect(r.code, ev).toBe('NOT_AUTHENTICATED');
    }
    // 방 상태는 변하지 않음
    expect(host.latest!.players.every((p) => !p.ready)).toBe(true);
  });

  it('only the host can start; start requires everyone connected & ready', async () => {
    const { url } = await server();
    const { host, all } = await setupRoom(url, 2, clients);
    const guest = all[1];
    expect((await guest.start()).code).toBe('NOT_HOST');
    expect((await host.start()).code).toBe('NOT_READY');
    await host.ready(true);
    expect((await host.start()).code).toBe('NOT_READY');
  });

  it('start requires at least 2 players', async () => {
    const { url } = await server();
    const a = await client(url);
    await a.create('solo');
    await a.ready(true);
    expect((await a.start()).code).toBe('NOT_READY');
  });

  it('rejects unknown token with TOKEN_INVALID', async () => {
    const { url } = await server();
    const a = await client(url);
    expect((await a.resume('A'.repeat(43))).code).toBe('TOKEN_INVALID');
    expect((await a.resume('')).code).toBe('BAD_REQUEST');
  });

  it('replays the stored ack for a repeated requestId', async () => {
    const { url } = await server();
    const { host } = await setupRoom(url, 2, clients);
    const requestId = newRequestId();
    const r1 = await host.emit('lobby:ready', { requestId, ready: true });
    const rev = (await host.waitFor((s) => s.players[0].ready)).revision;
    const r2 = await host.emit('lobby:ready', { requestId, ready: false });
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual(r1);
    await sleep(50);
    expect(host.latest!.players[0].ready).toBe(true); // 재전송은 다시 실행되지 않음
    expect(host.latest!.revision).toBe(rev);
  });

  it('resume from a new connection revokes the old socket', async () => {
    const { url } = await server();
    const { host, all } = await setupRoom(url, 2, clients);
    const guest = all[1];
    const newConn = await client(url);
    const r = await newConn.resume(guest.token);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playerId).toBe(guest.playerId);
    expect(r.snapshot.you.playerId).toBe(guest.playerId);
    expect(await guest.waitRevoked()).toBe('REPLACED');
    expect((await guest.ready(true)).code).toBe('NOT_AUTHENTICATED');
    expect((await newConn.ready(true)).ok).toBe(true);
    const s = await host.waitFor((x) => x.players[1].ready);
    expect(s.players[1].connected).toBe(true);
    expect(s.players.length).toBe(2);
    // 이전 소켓이 끊겨도 새 연결의 참가자는 연결 상태 유지
    guest.close();
    await sleep(100);
    expect(host.latest!.players[1].connected).toBe(true);
  });
});

describe('isolation, host, leave', () => {
  it("does not leak other rooms' snapshots", async () => {
    const { url } = await server();
    const r1 = await setupRoom(url, 2, clients);
    const r2 = await setupRoom(url, 2, clients);
    expect(r1.code).not.toBe(r2.code);
    await r2.host.ready(true);
    await r2.all[1].ready(true);
    await r2.host.waitFor((s) => s.players.every((p) => p.ready));
    await sleep(50);
    for (const c of r1.all) expect(c.snapshots.every((s) => s.code === r1.code)).toBe(true);
    for (const c of r2.all) expect(c.snapshots.every((s) => s.code === r2.code)).toBe(true);
    // 다른 방 참가자의 토큰으로 이 방 명령 불가 (토큰은 방에 묶임)
    const x = await client(url);
    const res = await x.resume(r2.all[1].token);
    expect(res.ok && res.snapshot.code).toBe(r2.code);
  });

  it('transfers host after the grace period and does not return it on reconnect', async () => {
    const { url } = await server({ timings: { hostGraceMs: 300 } });
    const { host, all } = await setupRoom(url, 3, clients);
    const [, p1] = all;
    const hostId = host.playerId;
    const hostToken = host.token;
    host.close();
    const s1 = await p1.waitFor((s) => !s.players[0].connected);
    expect(s1.hostPlayerId).toBe(hostId); // 유예 중에는 유지
    const s2 = await p1.waitFor((s) => s.hostPlayerId === p1.playerId, 3000, 'host transfer');
    expect(s2.hostPlayerId).toBe(p1.playerId); // 가장 먼저 들어온 연결된 참가자
    const back = await client(url);
    const r = await back.resume(hostToken);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot.hostPlayerId).toBe(p1.playerId);
  });

  it('host reconnecting within the grace keeps host', async () => {
    const { url } = await server({ timings: { hostGraceMs: 400 } });
    const { host, all } = await setupRoom(url, 2, clients);
    const token = host.token;
    host.close();
    await all[1].waitFor((s) => !s.players[0].connected);
    const back = await client(url);
    await back.resume(token);
    await sleep(600);
    expect(all[1].latest!.hostPlayerId).toBe(back.playerId);
  });

  it('leave in lobby removes the player, transfers host immediately, revokes token', async () => {
    const { url } = await server();
    const { host, all } = await setupRoom(url, 3, clients);
    const token = host.token;
    expect((await host.leave()).ok).toBe(true);
    const s = await all[1].waitFor((x) => x.players.length === 2);
    expect(s.hostPlayerId).toBe(all[1].playerId);
    const x = await client(url);
    expect((await x.resume(token)).code).toBe('TOKEN_INVALID');
    expect((await host.ready(true)).code).toBe('NOT_AUTHENTICATED');
  });

  it('a disconnected lobby player keeps the seat and can resume', async () => {
    const { url } = await server();
    const { host, all } = await setupRoom(url, 2, clients);
    const g = all[1];
    const { token, playerId } = g;
    g.close();
    await host.waitFor((s) => !s.players[1].connected);
    const back = await client(url);
    const r = await back.resume(token);
    expect(r.ok && r.playerId).toBe(playerId);
    await host.waitFor((s) => s.players[1].connected);
  });
});

describe('expiry and rate limiting', () => {
  it('distinguishes expired rooms/tokens from never-existing ones', async () => {
    let t = 1_000_000;
    const { gs, url } = await server({ now: () => t, timings: { lobbyExpiryMs: 1000, emptyRoomMs: 500 } });
    const a = await client(url);
    const ca = await a.create('A');
    if (!ca.ok) throw new Error();
    const code = ca.snapshot.code;
    t += 1001;
    gs.sweep();
    expect(await a.waitRevoked()).toBe('ROOM_EXPIRED');
    const b = await client(url);
    expect((await b.join(code, 'B')).code).toBe('ROOM_EXPIRED');
    expect((await b.join(code.toLowerCase(), 'B')).code).toBe('ROOM_EXPIRED');
    expect((await b.resume(ca.token)).code).toBe('ROOM_EXPIRED');
    expect((await b.resume('x'.repeat(43))).code).toBe('TOKEN_INVALID');
    const other = code === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
    expect((await b.join(other, 'B')).code).toBe('ROOM_NOT_FOUND');
    expect((await a.ready(true)).code).toBe('NOT_AUTHENTICATED');
  });

  it('cleans up a room after everyone disconnected for emptyRoomMs', async () => {
    let t = 1_000_000;
    const { gs, url } = await server({ now: () => t, timings: { emptyRoomMs: 500, lobbyExpiryMs: 1e9 } });
    const { host, all, code } = await setupRoom(url, 2, clients);
    const token = all[1].token;
    host.close();
    all[1].close();
    await sleep(100);
    t += 400;
    gs.sweep();
    expect(gs.debugRoom(code)).not.toBeNull();
    t += 200;
    gs.sweep();
    expect(gs.debugRoom(code)).toBeNull();
    const c = await client(url);
    expect((await c.resume(token)).code).toBe('ROOM_EXPIRED');
  });

  it('rate-limits failed code lookups per IP', async () => {
    const { url } = await server({
      rateLimits: {
        perSocket: { capacity: 1000, refillPerSec: 1000 },
        entryPerIp: { capacity: 1000, refillPerSec: 1000 },
        lookupFailPerIp: { capacity: 3, refillPerSec: 0.001 },
      },
    });
    const a = await client(url);
    const b = await client(url);
    for (let i = 0; i < 3; i++) expect((await a.join('ZZZZZZ', 'x')).code).toBe('ROOM_NOT_FOUND');
    expect((await a.join('ZZZZZZ', 'x')).code).toBe('RATE_LIMITED');
    expect((await b.join('YYYYYY', 'x')).code).toBe('RATE_LIMITED'); // 같은 IP의 다른 연결도
    expect((await b.resume('t'.repeat(43))).code).toBe('RATE_LIMITED');
  });

  it('rate-limits command spam per connection', async () => {
    const { url } = await server({
      rateLimits: {
        perSocket: { capacity: 5, refillPerSec: 0.001 },
        entryPerIp: { capacity: 1000, refillPerSec: 1000 },
        lookupFailPerIp: { capacity: 1000, refillPerSec: 1000 },
      },
    });
    const a = await client(url);
    await a.create('A');
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) { const r = await a.ready(i % 2 === 0); codes.push(r.ok ? 'ok' : r.code); }
    expect(codes.slice(0, 4)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(codes.slice(4)).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
  });
});
