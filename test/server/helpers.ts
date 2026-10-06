// 통신 테스트 보조: 짧은 시간 설정의 실제 서버 + socket.io-client 래퍼.
import { io, type Socket } from 'socket.io-client';
import { createGameServer, type GameServer, type GameServerOptions } from '../../src/server/gameServer';
import type { Ack, ClientToServerEvents, JoinResult, RoomSnapshot, ServerToClientEvents } from '../../src/shared/protocol';
import type { Plan } from '../../src/shared/types';

export const GENEROUS_LIMITS: GameServerOptions['rateLimits'] = {
  perSocket: { capacity: 1000, refillPerSec: 1000 },
  entryPerIp: { capacity: 1000, refillPerSec: 1000 },
  lookupFailPerIp: { capacity: 1000, refillPerSec: 1000 },
};

export async function startServer(opts: GameServerOptions = {}) {
  const gs = createGameServer({
    logger: false,
    rateLimits: GENEROUS_LIMITS,
    ...opts,
    timings: {
      dayMs: 5000,
      nightResultMs: 300,
      hostGraceMs: 300,
      emptyRoomMs: 60_000,
      lobbyExpiryMs: 60_000,
      lobbyDisconnectRemoveMs: 60_000,
      sweepIntervalMs: 0,
      ...opts.timings,
    },
  });
  const port = await gs.listen(0, '127.0.0.1');
  return { gs, url: `http://127.0.0.1:${port}` };
}

/** 테스트 편의: 실패 필드를 성공 쪽에서도 읽을 수 있게 넓힌 Ack */
export type TestAck<T> = Ack<T> & { code?: string; message?: string };

type CSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
let rid = 0;
export const newRequestId = () => `req-${++rid}-${Math.random().toString(36).slice(2)}`;

export class TestClient {
  snapshots: RoomSnapshot[] = [];
  revoked: string[] = [];
  playerId = '';
  token = '';
  private waiters: Array<() => void> = [];

  private constructor(public socket: CSocket) {
    socket.on('room:snapshot', (s) => { this.snapshots.push(s); this.notify(); });
    socket.on('session:revoked', (p) => { this.revoked.push(p.reason); this.notify(); });
  }

  static async connect(url: string): Promise<TestClient> {
    const socket: CSocket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return new TestClient(socket);
  }

  private notify() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  get latest(): RoomSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  emit<E extends keyof ClientToServerEvents>(event: E, payload: unknown, timeout = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), timeout);
      (this.socket as any).emit(event, payload, (r: Ack<any>) => { clearTimeout(t); resolve(r); });
    });
  }

  async create(nickname: string): Promise<TestAck<JoinResult>> {
    const r = await this.emit('room:create', { nickname });
    if (r.ok) { this.playerId = r.playerId; this.token = r.token; }
    return r;
  }

  async join(code: string, nickname: string): Promise<TestAck<JoinResult>> {
    const r = await this.emit('room:join', { code, nickname });
    if (r.ok) { this.playerId = r.playerId; this.token = r.token; }
    return r;
  }

  async resume(token: string): Promise<TestAck<JoinResult>> {
    const r = await this.emit('room:resume', { token });
    if (r.ok) { this.playerId = r.playerId; this.token = r.token; }
    return r;
  }

  ready(ready = true) { return this.emit('lobby:ready', { requestId: newRequestId(), ready }); }
  start() { return this.emit('game:start', { requestId: newRequestId() }); }
  leave() { return this.emit('room:leave', { requestId: newRequestId() }); }
  submit(gameId: string, day: number, plan: Plan, requestId = newRequestId()) {
    return this.emit('game:submit', { requestId, gameId, day, plan });
  }
  rematch(gameId: string) { return this.emit('game:rematch', { requestId: newRequestId(), gameId }); }

  /** 조건을 만족하는 스냅샷(이미 받은 마지막 것 포함)을 기다린다 */
  async waitFor(pred: (s: RoomSnapshot) => boolean, timeout = 5000, label = 'snapshot'): Promise<RoomSnapshot> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const l = this.latest;
      if (l && pred(l)) return l;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timeout waiting for ${label}; latest phase=${l?.phase} day=${l?.game?.day}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }

  async waitRevoked(timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (this.revoked.length === 0) {
      if (Date.now() > deadline) throw new Error('timeout waiting for revoke');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
    return this.revoked[this.revoked.length - 1];
  }

  close() { this.socket.close(); }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 방 생성 + n-1명 입장 */
export async function setupRoom(url: string, n: number, clients: TestClient[]) {
  const host = await TestClient.connect(url);
  clients.push(host);
  const c = await host.create('host');
  if (!c.ok) throw new Error('create failed');
  const code = c.snapshot.code;
  const all = [host];
  for (let i = 1; i < n; i++) {
    const cl = await TestClient.connect(url);
    clients.push(cl);
    const j = await cl.join(code, `p${i}`);
    if (!j.ok) throw new Error(`join failed: ${j.code}`);
    all.push(cl);
  }
  return { code, host, all };
}

/** 방을 만들고 전원 준비 후 시작. DAY 1 스냅샷까지 기다린다 */
export async function startGame(url: string, n: number, clients: TestClient[]) {
  const r = await setupRoom(url, n, clients);
  for (const cl of r.all) {
    const a = await cl.ready(true);
    if (!a.ok) throw new Error('ready failed');
  }
  const s = await r.host.start();
  if (!s.ok) throw new Error(`start failed: ${s.code} ${s.message}`);
  const snap = await r.host.waitFor((x) => x.phase === 'DAY' && x.game?.day === 1);
  return { ...r, gameId: snap.game!.gameId };
}

export const PLAN_A: Plan = { slots: [{ actionId: 'music' }, { actionId: 'study' }, { actionId: 'drink' }] };
export const PLAN_B: Plan = { slots: [{ actionId: 'friends' }, { actionId: 'friends' }, null] };
