// 방·게임 진행의 핵심. Socket.IO 서버에 붙어 protocol.ts 계약을 그대로 구현한다.
// 테스트에서 짧은 시간·주입한 시계·난수로 실제 서버를 띄울 수 있도록 팩토리로 제공한다.
import http from 'node:http';
import { randomInt } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import type {
  Ack, ClientToServerEvents, ErrorCode, JoinResult, Phase, PublicPlayer, RoomSnapshot, ServerToClientEvents,
} from '../shared/protocol';
import type { DayResult, Plan, PlayerRuleState, Rng, WinCheck } from '../shared/types';
import { RULES_VERSION } from '../shared/types';
import {
  GAME_CONSTANTS, checkWinner, createPlayerState, emptyPlan, resolveDay, validatePlan,
} from '../shared/rules';
import {
  RateLimiter, generateCode, generateId, generateToken, hashToken, nicknameKey, normalizeCode, normalizeNickname,
  type BucketConfig,
} from './util';

// ───────────────────────── 설정 ─────────────────────────

export interface GameServerTimings {
  /** 낮 제한시간 */
  dayMs: number;
  /** 밤 결과 표시 시간 */
  nightResultMs: number;
  /** 방장 단절 유예 */
  hostGraceMs: number;
  /** 전원 단절 방 정리 */
  emptyRoomMs: number;
  /** 대기실(및 종료 화면) 무활동 만료 */
  lobbyExpiryMs: number;
  /** 대기실에서 끊긴 참가자를 자리에서 제거하는 시간 (시작을 막지 않도록) */
  lobbyDisconnectRemoveMs: number;
  /** 만료된 코드·토큰 기억 기간 */
  tombstoneMs: number;
  /** 만료 검사 주기 (0이면 자동 검사 없음; sweep() 수동 호출) */
  sweepIntervalMs: number;
}

export interface RateLimitConfig {
  /** 연결별 모든 명령 */
  perSocket: BucketConfig;
  /** IP별 방 생성·참가·복귀 시도 */
  entryPerIp: BucketConfig;
  /** IP별 실패한 코드/토큰 조회 (초대코드 추측 방지) */
  lookupFailPerIp: BucketConfig;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface GameServerOptions {
  /** 붙을 HTTP 서버 (없으면 새로 만든다) */
  httpServer?: http.Server;
  timings?: Partial<GameServerTimings>;
  rateLimits?: Partial<RateLimitConfig>;
  /** 서버 시각 (epoch ms) */
  now?: () => number;
  /** 게임마다 규칙 난수원 생성 */
  createRng?: () => Rng;
  /** 허용 Origin. '*'=전부, 배열=목록 + 같은 호스트. Origin 헤더 없는 요청(비브라우저)은 허용 */
  allowedOrigins?: '*' | string[];
  /** X-Forwarded-For 첫 값을 클라이언트 IP로 사용 */
  trustProxy?: boolean;
  logger?: Logger | false;
  /** Socket.IO 메시지 최대 크기 (bytes) */
  maxHttpBufferSize?: number;
}

export const DEFAULT_TIMINGS: GameServerTimings = {
  dayMs: GAME_CONSTANTS.daySeconds * 1000,
  nightResultMs: GAME_CONSTANTS.nightResultSeconds * 1000,
  hostGraceMs: 30_000,
  emptyRoomMs: 5 * 60_000,
  lobbyExpiryMs: 30 * 60_000,
  lobbyDisconnectRemoveMs: 3 * 60_000,
  tombstoneMs: 24 * 60 * 60_000,
  sweepIntervalMs: 5_000,
};

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  perSocket: { capacity: 30, refillPerSec: 10 },
  entryPerIp: { capacity: 30, refillPerSec: 0.5 },
  lookupFailPerIp: { capacity: 10, refillPerSec: 0.1 },
};

/** 페이로드 대략 크기 상한 (JSON 문자 수) */
const MAX_PAYLOAD_CHARS = 2048;
const MAX_REQUEST_ID = 64;
const MAX_PROCESSED_PER_PLAYER = 64;

const cryptoRng = (): Rng => ({ next: () => randomInt(0, 2 ** 47) / 2 ** 47 });

const consoleLogger: Logger = {
  info: (m, meta) => console.log(`[server] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[server] ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`[server] ${m}`, meta ?? ''),
};
const silentLogger: Logger = { info() {}, warn() {}, error() {} };

// ───────────────────────── 내부 상태 ─────────────────────────

interface PlayerRec {
  playerId: string;
  nickname: string;
  nickKey: string;
  joinOrder: number;
  /** null = 폐기됨(나감) */
  token: string | null;
  socketId: string | null;
  ready: boolean;
  left: boolean;
  disconnectedAt: number | null;
  /** requestId → 저장된 응답 (재전송 시 그대로 반환) */
  processed: Map<string, Ack>;
}

type GamePhase = Exclude<Phase, 'LOBBY'>;

interface GameRec {
  gameId: string;
  rulesVersion: string;
  constants: typeof GAME_CONSTANTS;
  phase: GamePhase;
  day: number;
  deadline: number | null;
  players: PlayerRuleState[];
  /** 서버 전용: 현재 일차 제출 계획 */
  plans: Map<string, Plan>;
  history: DayResult[];
  lastResult: DayResult | null;
  pendingWin: WinCheck | null;
  winnerIds: string[];
  rng: Rng;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RoomRec {
  roomId: string;
  code: string;
  hostPlayerId: string;
  players: PlayerRec[];
  nextJoinOrder: number;
  game: GameRec | null;
  revision: number;
  lastActivity: number;
  allDisconnectedSince: number | null;
  hostGraceTimer: ReturnType<typeof setTimeout> | null;
  hostGraceExpired: boolean;
}

interface SocketData {
  roomId?: string;
  playerId?: string;
  lastLeave?: { requestId: string; ack: Ack };
  /** 이 소켓에서 마지막으로 성공한 방 생성·참가 (같은 requestId 재전송 시 재생) */
  lastEntry?: { requestId: string; roomId: string; playerId: string; ack: Ack<JoinResult> };
}

type IoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

class CmdError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); }
}
const fail = (code: ErrorCode, message: string): never => { throw new CmdError(code, message); };

// ───────────────────────── 입력 검사 ─────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function payloadSize(p: unknown): number {
  try { return JSON.stringify(p)?.length ?? 0; } catch { return Infinity; }
}

function reqStr(p: Record<string, unknown>, key: string, max: number): string {
  const v = p[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) fail('BAD_REQUEST', `invalid ${key}`);
  return v as string;
}

function reqInt(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1_000_000) fail('BAD_REQUEST', `invalid ${key}`);
  return v as number;
}

// ───────────────────────── 서버 ─────────────────────────

export class GameServer {
  readonly io: IoServer;
  readonly httpServer: http.Server;
  readonly timings: GameServerTimings;
  private readonly now: () => number;
  private readonly createRng: () => Rng;
  private readonly log: Logger;
  private readonly trustProxy: boolean;

  private rooms = new Map<string, RoomRec>();
  private roomsByCode = new Map<string, RoomRec>();
  private tokens = new Map<string, { roomId: string; playerId: string }>();
  /** 만료된 방 코드 → 기억 만료 시각 */
  private codeTombstones = new Map<string, number>();
  /** 만료된 방 토큰 해시 → 기억 만료 시각 */
  private tokenTombstones = new Map<string, number>();

  private socketLimiter: RateLimiter;
  private entryLimiter: RateLimiter;
  private lookupFailLimiter: RateLimiter;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(opts: GameServerOptions = {}) {
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.now = opts.now ?? Date.now;
    this.createRng = opts.createRng ?? cryptoRng;
    this.log = opts.logger === false ? silentLogger : opts.logger ?? consoleLogger;
    this.trustProxy = opts.trustProxy ?? false;
    const rl = { ...DEFAULT_RATE_LIMITS, ...opts.rateLimits };
    this.socketLimiter = new RateLimiter(rl.perSocket, this.now);
    this.entryLimiter = new RateLimiter(rl.entryPerIp, this.now);
    this.lookupFailLimiter = new RateLimiter(rl.lookupFailPerIp, this.now);

    this.httpServer = opts.httpServer ?? http.createServer();
    const allowed = opts.allowedOrigins ?? '*';
    this.io = new Server(this.httpServer, {
      maxHttpBufferSize: opts.maxHttpBufferSize ?? 16 * 1024,
      serveClient: false,
      cors: allowed === '*' ? { origin: true } : { origin: allowed },
      allowRequest: (req, cb) => cb(null, originAllowed(req, allowed)),
    });
    this.io.on('connection', (s) => this.onConnection(s));

    if (this.timings.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), this.timings.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  /** 지정 포트에서 대기. 0이면 임의 포트. 실제 포트를 반환 */
  listen(port = 0, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, () => {
        this.httpServer.off('error', reject);
        const addr = this.httpServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const room of this.rooms.values()) this.clearRoomTimers(room);
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
  }

  // ───────── 연결 처리 ─────────

  private clientIp(s: IoSocket): string {
    if (this.trustProxy) {
      const xff = s.handshake.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return s.handshake.address || 'unknown';
  }

  private onConnection(s: IoSocket) {
    const ip = this.clientIp(s);
    const handle = <P>(event: keyof ClientToServerEvents, fn: (p: Record<string, unknown>) => Ack<any>, entry = false) => {
      (s as any).on(event, (payload: P, ack: unknown) => {
        if (typeof ack !== 'function') return; // 계약상 ack 필수
        const reply = ack as (r: Ack<any>) => void;
        let res: Ack<any>;
        try {
          if (!this.socketLimiter.take(s.id)) fail('RATE_LIMITED', 'too many requests');
          if (entry && !this.entryLimiter.take(ip)) fail('RATE_LIMITED', 'too many attempts');
          if (!isObj(payload) || payloadSize(payload) > MAX_PAYLOAD_CHARS) fail('BAD_REQUEST', 'invalid payload');
          res = fn(payload as Record<string, unknown>);
        } catch (e) {
          if (e instanceof CmdError) res = { ok: false, code: e.code, message: e.message };
          else {
            this.log.error('command failed', { event, error: e instanceof Error ? e.message : String(e) });
            res = { ok: false, code: 'INTERNAL', message: 'internal error' };
          }
        }
        try { reply(res); } catch { /* 클라이언트 측 오류 무시 */ }
      });
    };

    handle('room:create', (p) => this.withEntryRequest(s, p, () => this.cmdCreate(s, p)), true);
    handle('room:join', (p) => this.withEntryRequest(s, p, () => this.cmdJoin(s, ip, p)), true);
    handle('room:resume', (p) => this.cmdResume(s, ip, p), true);
    handle('room:leave', (p) => this.cmdLeave(s, p));
    handle('lobby:ready', (p) => this.withPlayer(s, p, (room, pl) => this.cmdReady(room, pl, p)));
    handle('game:start', (p) => this.withPlayer(s, p, (room, pl) => this.cmdStart(room, pl)));
    handle('game:submit', (p) => this.withPlayer(s, p, (room, pl) => this.cmdSubmit(room, pl, p)));
    handle('game:rematch', (p) => this.withPlayer(s, p, (room, pl) => this.cmdRematch(room, pl, p)));

    s.on('disconnect', () => {
      this.socketLimiter.delete(s.id);
      this.detachSocket(s);
    });
  }

  /** 이 소켓에 바인딩된 참가자를 찾는다. 권한이 다른 연결로 넘어갔으면 NOT_AUTHENTICATED */
  private authed(s: IoSocket): { room: RoomRec; player: PlayerRec } {
    const { roomId, playerId } = s.data;
    const room = roomId ? this.rooms.get(roomId) : undefined;
    const player = room?.players.find((p) => p.playerId === playerId);
    if (!room || !player || player.left || player.socketId !== s.id) {
      s.data.roomId = undefined;
      s.data.playerId = undefined;
      return fail('NOT_AUTHENTICATED', 'not authenticated');
    }
    return { room, player };
  }

  /** requestId가 있는 인증 명령 공통 처리: 인증 → 재전송 응답 재생 → 실행 → 응답 저장 */
  private withPlayer(s: IoSocket, p: Record<string, unknown>, fn: (room: RoomRec, pl: PlayerRec) => void): Ack {
    const { room, player } = this.authed(s);
    const requestId = reqStr(p, 'requestId', MAX_REQUEST_ID);
    const prev = player.processed.get(requestId);
    if (prev) return prev;
    let res: Ack;
    try {
      fn(room, player);
      res = { ok: true };
    } catch (e) {
      if (!(e instanceof CmdError) || e.code === 'RATE_LIMITED') throw e;
      res = { ok: false, code: e.code, message: e.message };
    }
    player.processed.set(requestId, res);
    if (player.processed.size > MAX_PROCESSED_PER_PLAYER) {
      player.processed.delete(player.processed.keys().next().value as string);
    }
    return res;
  }

  /** 이 소켓이 현재 어떤 방의 참가자로 유효하게 바인딩되어 있는지 (부작용 없음) */
  private boundPlayer(s: IoSocket): { room: RoomRec; player: PlayerRec } | null {
    const { roomId, playerId } = s.data;
    const room = roomId ? this.rooms.get(roomId) : undefined;
    const player = room?.players.find((p) => p.playerId === playerId);
    if (!room || !player || player.left || player.socketId !== s.id) return null;
    return { room, player };
  }

  /**
   * 방 생성·참가의 재전송 처리 (소켓 단위). 같은 소켓의 같은 requestId는 저장된 응답을 재생하고
   * (아직 그 참가자로 연결되어 있으면 최신 스냅샷으로), 방이나 참가자를 새로 만들지 않는다.
   * 이미 다른 생성·참가·복귀로 방에 들어간 소켓의 새 요청은 BAD_PHASE로 거절한다(먼저 나가야 함).
   */
  private withEntryRequest(s: IoSocket, p: Record<string, unknown>, fn: () => Ack<JoinResult>): Ack<JoinResult> {
    const requestId = reqStr(p, 'requestId', MAX_REQUEST_ID);
    const prev = s.data.lastEntry;
    if (prev && prev.requestId === requestId) {
      const bound = this.boundPlayer(s);
      if (bound && bound.room.roomId === prev.roomId && bound.player.playerId === prev.playerId && prev.ack.ok) {
        return { ...prev.ack, snapshot: this.snapshotFor(bound.room, bound.player) };
      }
      return prev.ack;
    }
    if (this.boundPlayer(s)) fail('BAD_PHASE', 'already in a room');
    const res = fn();
    if (res.ok) {
      const bound = this.boundPlayer(s);
      if (bound) s.data.lastEntry = { requestId, roomId: bound.room.roomId, playerId: bound.player.playerId, ack: res };
    }
    return res;
  }

  // ───────── 입장 명령 ─────────

  private cmdCreate(s: IoSocket, p: Record<string, unknown>): Ack<JoinResult> {
    const nickname = normalizeNickname(reqStr(p, 'nickname', 64)) ?? fail('NICKNAME_INVALID', 'nickname must be 1-12 chars');
    let code = generateCode();
    for (let i = 0; this.roomsByCode.has(code) || this.codeTombstones.has(code); i++) {
      if (i > 1000) fail('BAD_REQUEST', 'could not allocate code');
      code = generateCode();
    }
    const room: RoomRec = {
      roomId: generateId('r'),
      code,
      hostPlayerId: '',
      players: [],
      nextJoinOrder: 0,
      game: null,
      revision: 0,
      lastActivity: this.now(),
      allDisconnectedSince: null,
      hostGraceTimer: null,
      hostGraceExpired: false,
    };
    this.rooms.set(room.roomId, room);
    this.roomsByCode.set(code, room);
    const { player, token } = this.addPlayer(room, nickname);
    room.hostPlayerId = player.playerId;
    this.bind(s, room, player);
    this.log.info('room created', { code, playerId: player.playerId });
    this.broadcast(room);
    return { ok: true, playerId: player.playerId, token, snapshot: this.snapshotFor(room, player) };
  }

  private lookupFailed(ip: string, code: ErrorCode, message: string): never {
    this.lookupFailLimiter.take(ip);
    return fail(code, message);
  }

  private cmdJoin(s: IoSocket, ip: string, p: Record<string, unknown>): Ack<JoinResult> {
    const rawCode = reqStr(p, 'code', 32);
    const rawNick = reqStr(p, 'nickname', 64);
    if (!this.lookupFailLimiter.has(ip)) fail('RATE_LIMITED', 'too many failed attempts');
    const code = normalizeCode(rawCode);
    const room = code ? this.roomsByCode.get(code) : undefined;
    if (!room) {
      if (code && this.codeTombstones.has(code)) this.lookupFailed(ip, 'ROOM_EXPIRED', 'room expired');
      this.lookupFailed(ip, 'ROOM_NOT_FOUND', 'room not found');
    }
    const r = room!;
    const nickname = normalizeNickname(rawNick) ?? fail('NICKNAME_INVALID', 'nickname must be 1-12 chars');
    if (r.game) fail('GAME_IN_PROGRESS', 'game already started');
    if (r.players.length >= GAME_CONSTANTS.maxPlayers) fail('ROOM_FULL', 'room is full');
    const key = nicknameKey(nickname);
    if (r.players.some((pl) => pl.nickKey === key)) fail('NICKNAME_TAKEN', 'nickname taken');
    const { player, token } = this.addPlayer(r, nickname);
    this.bind(s, r, player);
    r.lastActivity = this.now();
    this.log.info('player joined', { code: r.code, playerId: player.playerId });
    this.broadcast(r);
    return { ok: true, playerId: player.playerId, token, snapshot: this.snapshotFor(r, player) };
  }

  private cmdResume(s: IoSocket, ip: string, p: Record<string, unknown>): Ack<JoinResult> {
    const token = reqStr(p, 'token', 128);
    if (!this.lookupFailLimiter.has(ip)) fail('RATE_LIMITED', 'too many failed attempts');
    const ref = this.tokens.get(token);
    const room = ref ? this.rooms.get(ref.roomId) : undefined;
    const player = room?.players.find((pl) => pl.playerId === ref!.playerId);
    if (!room || !player || player.left || player.token !== token) {
      if (this.tokenTombstones.has(hashToken(token))) this.lookupFailed(ip, 'ROOM_EXPIRED', 'room expired');
      this.lookupFailed(ip, 'TOKEN_INVALID', 'invalid token');
    }
    const r = room!;
    const pl = player!;
    if (pl.socketId !== s.id) {
      if (pl.socketId) this.revokeSocket(pl.socketId, 'REPLACED');
      this.bind(s, r, pl);
    }
    r.lastActivity = this.now();
    this.log.info('player resumed', { code: r.code, playerId: pl.playerId });
    this.broadcast(r);
    return { ok: true, playerId: pl.playerId, token, snapshot: this.snapshotFor(r, pl) };
  }

  private cmdLeave(s: IoSocket, p: Record<string, unknown>): Ack {
    const requestId = reqStr(p, 'requestId', MAX_REQUEST_ID);
    if (s.data.lastLeave?.requestId === requestId) return s.data.lastLeave.ack;
    const { room, player } = this.authed(s);
    const ack: Ack = { ok: true };
    this.leavePlayer(room, player);
    s.data.lastLeave = { requestId, ack };
    return ack;
  }

  // ───────── 대기실·게임 명령 ─────────

  private cmdReady(room: RoomRec, player: PlayerRec, p: Record<string, unknown>) {
    if (typeof p.ready !== 'boolean') fail('BAD_REQUEST', 'invalid ready');
    if (room.game) fail('BAD_PHASE', 'not in lobby');
    player.ready = p.ready as boolean;
    room.lastActivity = this.now();
    this.broadcast(room);
  }

  private cmdStart(room: RoomRec, player: PlayerRec) {
    if (room.hostPlayerId !== player.playerId) fail('NOT_HOST', 'only host can start');
    if (room.game) fail('BAD_PHASE', 'not in lobby');
    const n = room.players.length;
    if (n < GAME_CONSTANTS.minPlayers || n > GAME_CONSTANTS.maxPlayers) fail('NOT_READY', `need ${GAME_CONSTANTS.minPlayers}-${GAME_CONSTANTS.maxPlayers} players`);
    if (room.players.some((pl) => !pl.socketId || !pl.ready)) fail('NOT_READY', 'all players must be connected and ready');
    const ordered = [...room.players].sort((a, b) => a.joinOrder - b.joinOrder);
    const game: GameRec = {
      gameId: generateId('g'),
      rulesVersion: RULES_VERSION,
      constants: { ...GAME_CONSTANTS },
      phase: 'DAY',
      day: 1,
      deadline: null,
      players: ordered.map((pl) => createPlayerState(pl.playerId)),
      plans: new Map(),
      history: [],
      lastResult: null,
      pendingWin: null,
      winnerIds: [],
      rng: this.createRng(),
      timer: null,
    };
    room.game = game;
    room.lastActivity = this.now();
    this.log.info('game started', { code: room.code, gameId: game.gameId, players: n });
    this.startDay(room, game, 1);
    this.broadcast(room);
  }

  private cmdSubmit(room: RoomRec, player: PlayerRec, p: Record<string, unknown>) {
    const gameId = reqStr(p, 'gameId', 64);
    const day = reqInt(p, 'day');
    const game = room.game;
    if (!game || game.gameId !== gameId) fail('STALE_GAME', 'game mismatch');
    const g = game!;
    const state = g.players.find((ps) => ps.playerId === player.playerId);
    if (!state) fail('STALE_GAME', 'not in this game');
    if (state!.forfeited) fail('FORFEITED', 'forfeited');
    if (day !== g.day) fail('STALE_DAY', 'day mismatch');
    if (g.phase !== 'DAY') fail('BAD_PHASE', 'not accepting plans');
    if (g.plans.has(player.playerId)) fail('ALREADY_SUBMITTED', 'already submitted');
    const v = validatePlan(p.plan);
    if (!v.ok) fail('INVALID_PLAN', v.reason);
    const plan = p.plan as Plan;
    // 검증된 형식만 복사해 저장 (여분 필드 제거)
    g.plans.set(player.playerId, {
      slots: plan.slots.map((sl) => (sl ? (sl.targetId ? { actionId: sl.actionId, targetId: sl.targetId } : { actionId: sl.actionId }) : null)) as Plan['slots'],
    });
    room.lastActivity = this.now();
    if (this.allSubmitted(g)) this.lockDay(room, g.gameId, g.day);
    this.broadcast(room);
  }

  private cmdRematch(room: RoomRec, player: PlayerRec, p: Record<string, unknown>) {
    const gameId = reqStr(p, 'gameId', 64);
    if (room.hostPlayerId !== player.playerId) fail('NOT_HOST', 'only host can rematch');
    if (!room.game || room.game.gameId !== gameId) fail('STALE_GAME', 'game mismatch');
    if (room.game!.phase !== 'FINISHED') fail('BAD_PHASE', 'game not finished');
    this.clearGameTimer(room.game!);
    room.game = null;
    for (const pl of [...room.players]) {
      if (pl.left || !pl.socketId) this.removePlayer(room, pl);
    }
    for (const pl of room.players) pl.ready = false;
    room.lastActivity = this.now();
    this.log.info('rematch', { code: room.code, players: room.players.length });
    this.broadcast(room);
  }

  // ───────── 게임 진행 ─────────

  private activeStates(g: GameRec) {
    return g.players.filter((ps) => !ps.forfeited);
  }

  private allSubmitted(g: GameRec) {
    const active = this.activeStates(g);
    return active.length > 0 && active.every((ps) => g.plans.has(ps.playerId));
  }

  private clearGameTimer(g: GameRec) {
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
  }

  private startDay(room: RoomRec, g: GameRec, day: number) {
    this.clearGameTimer(g);
    g.phase = 'DAY';
    g.day = day;
    g.plans = new Map();
    g.deadline = this.now() + this.timings.dayMs;
    const { gameId } = g;
    g.timer = setTimeout(() => this.onDayDeadline(room.roomId, gameId, day), this.timings.dayMs);
  }

  /** 낮 마감 타이머. 오래된 타이머는 gameId·day·단계를 확인하고 아무것도 하지 않는다 */
  private onDayDeadline(roomId: string, gameId: string, day: number) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (this.lockDay(room, gameId, day)) this.broadcast(room);
  }

  /**
   * DAY → RESOLVING → NIGHT_RESULT. 같은 (gameId, day)에 대해 정확히 한 번만 성공한다.
   * 정산은 동기적으로 끝난다.
   */
  private lockDay(room: RoomRec, gameId: string, day: number): boolean {
    const g = room.game;
    if (!g || g.gameId !== gameId || g.day !== day || g.phase !== 'DAY') return false;
    this.clearGameTimer(g);
    g.phase = 'RESOLVING';
    g.deadline = null;
    const plans: Record<string, Plan> = {};
    for (const ps of this.activeStates(g)) plans[ps.playerId] = g.plans.get(ps.playerId) ?? emptyPlan();
    try {
      const { players, result } = resolveDay(g.players, plans, day, g.rng);
      const win = checkWinner(players, day);
      g.players = players;
      g.lastResult = result;
      g.history.push(result);
      g.pendingWin = win;
    } catch (e) {
      // 규칙 오류는 버그다. 게임을 무한 대기에 두지 않도록 승자 없이 종료한다.
      this.log.error('resolveDay failed', { code: room.code, gameId, day, error: e instanceof Error ? e.message : String(e) });
      this.finishGame(room, g, []);
      return true;
    }
    g.phase = 'NIGHT_RESULT';
    g.deadline = this.now() + this.timings.nightResultMs;
    g.timer = setTimeout(() => this.onNightEnd(room.roomId, gameId, day), this.timings.nightResultMs);
    return true;
  }

  private onNightEnd(roomId: string, gameId: string, day: number) {
    const room = this.rooms.get(roomId);
    const g = room?.game;
    if (!room || !g || g.gameId !== gameId || g.day !== day || g.phase !== 'NIGHT_RESULT') return;
    g.timer = null;
    const win = g.pendingWin;
    g.pendingWin = null;
    if (win?.finished) this.finishGame(room, g, win.winnerIds);
    else if (day >= g.constants.maxDays) {
      // 규칙 함수가 maxDays를 처리하지만 서버 시간표가 끝없이 돌지 않도록 보호
      this.finishGame(room, g, checkWinnerSafe(g.players, day));
    } else this.startDay(room, g, day + 1);
    this.broadcast(room);
  }

  private finishGame(room: RoomRec, g: GameRec, winnerIds: string[]) {
    this.clearGameTimer(g);
    g.phase = 'FINISHED';
    g.deadline = null;
    g.pendingWin = null;
    g.winnerIds = winnerIds.filter((id) => g.players.some((ps) => ps.playerId === id && !ps.forfeited));
    room.lastActivity = this.now();
    this.log.info('game finished', { code: room.code, gameId: g.gameId, day: g.day, winners: g.winnerIds.length });
  }

  // ───────── 참가자 관리 ─────────

  private addPlayer(room: RoomRec, nickname: string) {
    const token = generateToken();
    const player: PlayerRec = {
      playerId: generateId('p'),
      nickname,
      nickKey: nicknameKey(nickname),
      joinOrder: room.nextJoinOrder++,
      token,
      socketId: null,
      ready: false,
      left: false,
      disconnectedAt: null,
      processed: new Map(),
    };
    room.players.push(player);
    this.tokens.set(token, { roomId: room.roomId, playerId: player.playerId });
    return { player, token };
  }

  /** 소켓을 참가자에 바인딩. 소켓이 다른 참가자에 묶여 있었으면 그 연결을 먼저 끊은 것으로 처리 */
  private bind(s: IoSocket, room: RoomRec, player: PlayerRec) {
    this.detachSocket(s);
    s.data.roomId = room.roomId;
    s.data.playerId = player.playerId;
    s.data.lastLeave = undefined;
    player.socketId = s.id;
    player.disconnectedAt = null;
    room.allDisconnectedSince = null;
    if (room.hostPlayerId === player.playerId) {
      if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
      room.hostGraceExpired = false;
    } else if (room.hostGraceExpired) {
      this.transferHostIfAbsent(room);
    }
  }

  /** 소켓의 연결 종료 처리 (나가기가 아님: 자리 유지) */
  private detachSocket(s: IoSocket) {
    const { roomId, playerId } = s.data;
    s.data.roomId = undefined;
    s.data.playerId = undefined;
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    const player = room?.players.find((p) => p.playerId === playerId);
    if (!room || !player || player.socketId !== s.id) return; // 이미 다른 연결로 교체됨
    player.socketId = null;
    player.disconnectedAt = this.now();
    if (room.hostPlayerId === player.playerId && !room.hostGraceTimer) {
      room.hostGraceExpired = false;
      room.hostGraceTimer = setTimeout(() => this.onHostGrace(room.roomId), this.timings.hostGraceMs);
    }
    if (room.players.every((p) => !p.socketId)) room.allDisconnectedSince = this.now();
    this.log.info('player disconnected', { code: room.code, playerId: player.playerId });
    this.broadcast(room);
  }

  private onHostGrace(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.hostGraceTimer = null;
    const host = room.players.find((p) => p.playerId === room.hostPlayerId);
    if (host && host.socketId && !host.left) return;
    room.hostGraceExpired = true;
    if (this.transferHostIfAbsent(room)) this.broadcast(room);
  }

  /** 방장이 연결되어 있지 않으면 가장 먼저 들어온 연결된 참가자에게 이전 */
  private transferHostIfAbsent(room: RoomRec): boolean {
    const host = room.players.find((p) => p.playerId === room.hostPlayerId);
    if (host && host.socketId && !host.left) return false;
    const next = room.players
      .filter((p) => !p.left && p.socketId && p.playerId !== room.hostPlayerId)
      .sort((a, b) => a.joinOrder - b.joinOrder)[0];
    if (!next) return false;
    room.hostPlayerId = next.playerId;
    room.hostGraceExpired = false;
    if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
    this.log.info('host transferred', { code: room.code, playerId: next.playerId });
    return true;
  }

  /** 나가기 직후 방장 즉시 이전 (연결된 사람 우선, 없으면 남은 사람 중 가장 먼저 들어온 사람) */
  private reassignHostAfterLeave(room: RoomRec, leaverId: string) {
    if (room.hostPlayerId !== leaverId) return;
    const remaining = room.players.filter((p) => !p.left && p.playerId !== leaverId).sort((a, b) => a.joinOrder - b.joinOrder);
    const next = remaining.find((p) => p.socketId) ?? remaining[0];
    if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
    room.hostGraceExpired = false;
    if (next) {
      room.hostPlayerId = next.playerId;
      if (!next.socketId) {
        room.hostGraceTimer = setTimeout(() => this.onHostGrace(room.roomId), this.timings.hostGraceMs);
      }
    }
  }

  private revokeToken(player: PlayerRec) {
    if (player.token) this.tokens.delete(player.token);
    player.token = null;
  }

  private revokeSocket(socketId: string, reason: 'REPLACED' | 'ROOM_EXPIRED' | 'LEFT') {
    const old = this.io.sockets.sockets.get(socketId);
    if (!old) return;
    old.data.roomId = undefined;
    old.data.playerId = undefined;
    old.emit('session:revoked', { reason });
  }

  /** 대기실에서 자리 제거 (토큰 폐기) */
  private removePlayer(room: RoomRec, player: PlayerRec) {
    this.revokeToken(player);
    room.players = room.players.filter((p) => p !== player);
  }

  /** 명시적 나가기: 토큰 폐기. 게임 중이면 기권 */
  private leavePlayer(room: RoomRec, player: PlayerRec) {
    const socketId = player.socketId;
    player.socketId = null;
    if (socketId) {
      const sock = this.io.sockets.sockets.get(socketId);
      if (sock) { sock.data.roomId = undefined; sock.data.playerId = undefined; }
    }
    this.reassignHostAfterLeave(room, player.playerId);
    const g = room.game;
    if (!g) {
      this.removePlayer(room, player);
    } else {
      player.left = true;
      player.ready = false;
      player.disconnectedAt = this.now();
      this.revokeToken(player);
      if (g.phase !== 'FINISHED') this.forfeit(room, g, player.playerId);
    }
    room.lastActivity = this.now();
    this.log.info('player left', { code: room.code, playerId: player.playerId });
    if (room.players.every((p) => p.left)) {
      this.expireRoom(room, 'left');
      return;
    }
    if (room.players.every((p) => !p.socketId)) room.allDisconnectedSince ??= this.now();
    this.broadcast(room);
  }

  private forfeit(room: RoomRec, g: GameRec, playerId: string) {
    g.players = g.players.map((ps) => (ps.playerId === playerId ? { ...ps, forfeited: true } : ps));
    g.plans.delete(playerId);
    const active = this.activeStates(g);
    if (active.length <= 1) {
      this.finishGame(room, g, active.map((ps) => ps.playerId));
    } else if (g.phase === 'DAY' && this.allSubmitted(g)) {
      this.lockDay(room, g.gameId, g.day);
    }
  }

  // ───────── 만료·정리 ─────────

  private clearRoomTimers(room: RoomRec) {
    if (room.game) this.clearGameTimer(room.game);
    if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
  }

  private expireRoom(room: RoomRec, why: string) {
    this.clearRoomTimers(room);
    const until = this.now() + this.timings.tombstoneMs;
    this.codeTombstones.set(room.code, until);
    for (const p of room.players) {
      if (p.socketId) this.revokeSocket(p.socketId, 'ROOM_EXPIRED');
      p.socketId = null;
      if (p.token) {
        this.tokenTombstones.set(hashToken(p.token), until);
        this.tokens.delete(p.token);
        p.token = null;
      }
    }
    this.rooms.delete(room.roomId);
    this.roomsByCode.delete(room.code);
    this.log.info('room closed', { code: room.code, why });
  }

  /** 주기 검사: 전원 단절 방 정리, 대기실 만료, 대기실 단절자 제거, 기록 정리 */
  sweep() {
    const t = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.allDisconnectedSince !== null && t - room.allDisconnectedSince >= this.timings.emptyRoomMs) {
        this.expireRoom(room, 'empty');
        continue;
      }
      const idle = !room.game || room.game.phase === 'FINISHED';
      if (idle && t - room.lastActivity >= this.timings.lobbyExpiryMs) {
        this.expireRoom(room, 'idle');
        continue;
      }
      if (!room.game) {
        const stale = room.players.filter((p) => !p.socketId && p.disconnectedAt !== null && t - p.disconnectedAt >= this.timings.lobbyDisconnectRemoveMs);
        if (stale.length > 0) {
          for (const p of stale) {
            this.reassignHostAfterLeave(room, p.playerId);
            this.removePlayer(room, p);
          }
          if (room.players.length === 0) { this.expireRoom(room, 'empty'); continue; }
          this.broadcast(room);
        }
      }
    }
    for (const [k, until] of this.codeTombstones) if (until <= t) this.codeTombstones.delete(k);
    for (const [k, until] of this.tokenTombstones) if (until <= t) this.tokenTombstones.delete(k);
    this.socketLimiter.prune();
    this.entryLimiter.prune();
    this.lookupFailLimiter.prune();
  }

  // ───────── 스냅샷 ─────────

  private snapshotFor(room: RoomRec, player: PlayerRec): RoomSnapshot {
    const g = room.game;
    const forfeited = new Set(g?.players.filter((ps) => ps.forfeited).map((ps) => ps.playerId) ?? []);
    const players: PublicPlayer[] = [...room.players]
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map((p) => ({
        playerId: p.playerId,
        nickname: p.nickname,
        joinOrder: p.joinOrder,
        connected: p.socketId !== null,
        ready: p.ready,
        forfeited: forfeited.has(p.playerId),
        submitted: !!g && g.phase === 'DAY' && g.plans.has(p.playerId),
      }));
    const ownPlan = g && (g.phase === 'DAY' || g.phase === 'NIGHT_RESULT') ? g.plans.get(player.playerId) ?? null : null;
    return {
      revision: room.revision,
      code: room.code,
      phase: g ? g.phase : 'LOBBY',
      hostPlayerId: room.hostPlayerId,
      players,
      game: g
        ? {
          gameId: g.gameId,
          rulesVersion: g.rulesVersion,
          day: g.day,
          maxDays: g.constants.maxDays,
          targetScore: g.constants.targetScore,
          deadline: g.deadline,
          players: g.players,
          lastResult: g.lastResult,
          history: g.history,
          winnerIds: g.phase === 'FINISHED' ? g.winnerIds : [],
        }
        : null,
      serverNow: this.now(),
      you: { playerId: player.playerId, submittedPlan: ownPlan ? structuredClone(ownPlan) : null },
    };
  }

  /** 상태가 바뀔 때마다 revision을 올리고 연결된 참가자에게 수신자별 스냅샷을 보낸다 */
  private broadcast(room: RoomRec) {
    if (!this.rooms.has(room.roomId)) return;
    room.revision++;
    for (const p of room.players) {
      if (!p.socketId || p.left) continue;
      const sock = this.io.sockets.sockets.get(p.socketId);
      if (sock) sock.emit('room:snapshot', this.snapshotFor(room, p));
    }
  }

  // ───────── 테스트·진단용 ─────────

  /** 테스트용: 공개 정보 기준 방 요약 (토큰·계획 미포함) */
  debugRoom(code: string) {
    const room = this.roomsByCode.get(code);
    if (!room) return null;
    return {
      roomId: room.roomId,
      revision: room.revision,
      hostPlayerId: room.hostPlayerId,
      phase: room.game?.phase ?? 'LOBBY',
      day: room.game?.day ?? null,
      gameId: room.game?.gameId ?? null,
      historyDays: room.game?.history.map((h) => h.day) ?? [],
      submitted: room.game ? [...room.game.plans.keys()] : [],
    };
  }

  /** 테스트용: 오래된/경합 마감 타이머가 실행된 것처럼 호출 */
  fireDayDeadline(code: string, gameId: string, day: number) {
    const room = this.roomsByCode.get(code);
    if (room) this.onDayDeadline(room.roomId, gameId, day);
  }

  get roomCount() {
    return this.rooms.size;
  }
}

function checkWinnerSafe(players: PlayerRuleState[], day: number): string[] {
  try { return checkWinner(players, day).winnerIds; } catch { return []; }
}

/** Origin 검사: '*'면 허용. 목록이면 목록 또는 같은 호스트만 허용. Origin 없으면(비브라우저) 허용 */
function originAllowed(req: http.IncomingMessage, allowed: '*' | string[]): boolean {
  if (allowed === '*') return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  try {
    const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() || req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createGameServer(opts: GameServerOptions = {}): GameServer {
  return new GameServer(opts);
}
