// 연결 계층: Socket.IO 연결, 명령 ack/재시도, 스냅샷 revision 관리, 토큰 보관, 재접속 복귀.
import { io, type Socket } from 'socket.io-client';
import type {
  Ack, ClientToServerEvents, ErrorCode, JoinResult, RoomSnapshot, ServerToClientEvents,
} from '../../shared/protocol';
import type { Plan } from '../../shared/types';
import { errorText } from '../lib/errors';

const TOKEN_KEY = 'dopamine-loop.token';
const ACK_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 4;

/**
 * connecting: 최초 연결 중 / online: 연결됨 / offline: 끊김(자동 재연결 시도 중)
 */
export type ConnState = 'connecting' | 'online' | 'offline';

export interface ClientState {
  conn: ConnState;
  /** 토큰으로 방 복귀를 시도하는 중 (최초 로드·재접속) */
  resuming: boolean;
  /** 복귀가 일시적 사유로 실패해 재시도가 필요함 */
  resumeStuck: boolean;
  snapshot: RoomSnapshot | null;
  /** serverNow - 로컬 Date.now() */
  clockOffset: number;
  /** 다른 탭/기기에서 같은 참가자로 접속하여 조작 권한이 해제됨 */
  replaced: boolean;
  /** 처음 화면에 띄울 안내 */
  homeNotice: string | null;
  toast: { id: number; text: string } | null;
}

type Listener = () => void;
type AnySocket = Socket;

export type CmdResult<T = {}> = Ack<T> | { ok: false; code: 'TIMEOUT'; message: string };

function readToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* 저장소 사용 불가: 이 탭에서는 복귀가 불가능할 뿐 */ }
}

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // 비보안 컨텍스트(예: LAN의 http) 대비
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GameClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private listeners = new Set<Listener>();
  private appliedRevision = -1;
  private appliedCode: string | null = null;
  /** 이 연결이 방 참가자로 인증되었는지 (create/join/resume 성공) */
  private authed = false;
  private toastSeq = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  state: ClientState = {
    conn: 'connecting',
    resuming: readToken() !== null,
    resumeStuck: false,
    snapshot: null,
    clockOffset: 0,
    replaced: false,
    homeNotice: null,
    toast: null,
  };

  constructor() {
    this.socket = io({ autoConnect: false, transports: ['websocket', 'polling'] });
    this.socket.on('connect', () => {
      this.set({ conn: 'online' });
      this.authed = false;
      // 다른 탭에 권한을 넘긴 상태에서는 자동으로 빼앗아 오지 않는다
      if (readToken() && !this.state.replaced) void this.resume();
    });
    this.socket.on('disconnect', () => {
      this.authed = false;
      this.set({ conn: 'offline' });
    });
    this.socket.on('connect_error', () => {
      if (this.state.conn !== 'connecting') this.set({ conn: 'offline' });
    });
    this.socket.on('room:snapshot', (s) => this.applySnapshot(s));
    this.socket.on('session:revoked', ({ reason }) => {
      this.authed = false;
      if (reason === 'REPLACED') {
        this.set({ replaced: true });
      } else if (reason === 'ROOM_EXPIRED') {
        this.goHome('방이 만료되었습니다.');
      } else {
        this.goHome(null);
      }
    });
    this.socket.connect();
  }

  // ---- 상태 구독 (useSyncExternalStore) ----
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = (): ClientState => this.state;

  private set(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  showToast(text: string): void {
    const id = ++this.toastSeq;
    this.set({ toast: { id, text } });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (this.state.toast?.id === id) this.set({ toast: null });
    }, 3500);
  }

  clearHomeNotice(): void { this.set({ homeNotice: null }); }

  /** 서버 시각 기준 현재 epoch ms */
  serverNow(): number { return Date.now() + this.state.clockOffset; }

  get hasToken(): boolean { return readToken() !== null; }

  // ---- 스냅샷 ----
  private applySnapshot(s: RoomSnapshot): void {
    if (this.state.replaced) return;
    if (this.appliedCode === s.code && s.revision <= this.appliedRevision) return; // 오래된/중복 스냅샷
    this.appliedCode = s.code;
    this.appliedRevision = s.revision;
    this.set({ snapshot: s, clockOffset: s.serverNow - Date.now() });
  }

  private resetRoom(): void {
    this.appliedCode = null;
    this.appliedRevision = -1;
  }

  private goHome(notice: string | null): void {
    writeToken(null);
    this.authed = false;
    this.resetRoom();
    this.set({ snapshot: null, resuming: false, resumeStuck: false, replaced: false, homeNotice: notice });
  }

  private onJoined(r: JoinResult): void {
    writeToken(r.token);
    this.authed = true;
    if (this.appliedCode !== r.snapshot.code) this.resetRoom();
    this.set({ replaced: false, resuming: false, resumeStuck: false, homeNotice: null });
    this.applySnapshot(r.snapshot);
  }

  // ---- 저수준 emit ----
  private emitOnce<T>(event: string, payload: unknown, timeoutMs: number): Promise<CmdResult<T>> {
    return new Promise((resolve) => {
      if (!this.socket.connected) {
        resolve({ ok: false, code: 'TIMEOUT', message: 'not connected' });
        return;
      }
      (this.socket as unknown as AnySocket)
        .timeout(timeoutMs)
        .emit(event, payload, (err: Error | null, res: Ack<T>) => {
          if (err || !res) resolve({ ok: false, code: 'TIMEOUT', message: 'ack timeout' });
          else resolve(res);
        });
    });
  }

  /** 연결(필요하면 인증)될 때까지 최대 ms 대기 */
  private async waitReady(needAuth: boolean, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (this.socket.connected && (!needAuth || this.authed)) return true;
      await delay(150);
    }
    return this.socket.connected && (!needAuth || this.authed);
  }

  /** requestId가 있는 게임 명령: 응답이 없으면 같은 requestId로 재시도 */
  private async command<T = {}>(event: string, payload: Record<string, unknown>): Promise<CmdResult<T>> {
    const body = { requestId: newRequestId(), ...payload };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ready = await this.waitReady(true, ACK_TIMEOUT_MS);
      if (ready) {
        const res = await this.emitOnce<T>(event, body, ACK_TIMEOUT_MS);
        if (res.ok || res.code !== 'TIMEOUT') return res;
      }
      await delay(300 * attempt);
    }
    return { ok: false, code: 'TIMEOUT', message: 'timeout' };
  }

  private reportError(res: CmdResult<unknown>): void {
    if (res.ok) return;
    this.showToast(errorText(res.code));
    // 인증이 풀린 경우 복귀를 다시 시도
    if (res.code === 'NOT_AUTHENTICATED' && readToken() && !this.state.replaced) void this.resume();
    if (res.code === 'ROOM_EXPIRED') this.goHome('방이 만료되었습니다.');
  }

  // ---- 방 입장 ----
  /**
   * 방 생성·참가: 응답이 없으면 같은 requestId로 재시도한다. 서버의 재전송 판별은 연결(소켓) 단위이므로
   * 재시도는 첫 시도와 같은 연결에서만 한다(연결이 바뀌면 중복 생성 위험이 있어 중단).
   */
  private async entryCommand(event: 'room:create' | 'room:join', payload: Record<string, unknown>): Promise<CmdResult<JoinResult>> {
    if (!(await this.waitReady(false, ACK_TIMEOUT_MS))) return { ok: false, code: 'TIMEOUT', message: 'not connected' };
    const body = { requestId: newRequestId(), ...payload };
    const socketId = this.socket.id;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (!this.socket.connected || this.socket.id !== socketId) break;
      const res = await this.emitOnce<JoinResult>(event, body, ACK_TIMEOUT_MS);
      if (res.ok) { this.onJoined(res); return res; }
      if (res.code !== 'TIMEOUT') return res;
      await delay(300 * attempt);
    }
    return { ok: false, code: 'TIMEOUT', message: 'timeout' };
  }

  createRoom(nickname: string): Promise<CmdResult<JoinResult>> {
    return this.entryCommand('room:create', { nickname });
  }

  joinRoom(code: string, nickname: string): Promise<CmdResult<JoinResult>> {
    return this.entryCommand('room:join', { code, nickname });
  }

  private resumeInFlight: Promise<void> | null = null;

  /** 토큰으로 복귀. 최초 로드·모든 재접속 시 호출 */
  resume(): Promise<void> {
    if (this.resumeInFlight) return this.resumeInFlight;
    this.resumeInFlight = (async () => {
      this.set({ resuming: true, resumeStuck: false, replaced: false });
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const token = readToken();
        if (!token) { this.set({ resuming: false }); return; }
        if (!this.socket.connected) {
          // 연결되면 'connect' 핸들러가 다시 호출한다
          this.set({ resuming: false });
          return;
        }
        const res = await this.emitOnce<JoinResult>('room:resume', { token }, ACK_TIMEOUT_MS);
        if (res.ok) { this.onJoined(res); return; }
        if (res.code === 'TOKEN_INVALID') {
          this.goHome('이전 접속 정보가 유효하지 않아 처음 화면으로 돌아왔습니다.');
          return;
        }
        if (res.code === 'ROOM_EXPIRED') { this.goHome('방이 만료되었습니다.'); return; }
        if (res.code === 'ROOM_NOT_FOUND') { this.goHome('방을 찾을 수 없습니다.'); return; }
        await delay(500 * attempt);
      }
      this.set({ resuming: false, resumeStuck: true });
    })().finally(() => { this.resumeInFlight = null; });
    return this.resumeInFlight;
  }

  /** REPLACED 이후 사용자가 이 화면에서 다시 조작하겠다고 선택 */
  takeOver(): void {
    this.set({ replaced: false });
    this.resetRoom();
    if (this.socket.connected) void this.resume();
    else this.socket.connect();
  }

  // ---- 게임 명령 ----
  async setReady(ready: boolean): Promise<boolean> {
    const res = await this.command('lobby:ready', { ready });
    this.reportError(res);
    return res.ok;
  }

  async startGame(): Promise<boolean> {
    const res = await this.command('game:start', {});
    this.reportError(res);
    return res.ok;
  }

  async submitPlan(gameId: string, day: number, plan: Plan): Promise<CmdResult> {
    const res = await this.command('game:submit', { gameId, day, plan });
    // 이미 제출된 경우(재시도 경합 등)는 성공처럼 취급: 스냅샷이 잠금 상태를 알려준다
    if (!res.ok && res.code === 'ALREADY_SUBMITTED') return { ok: true };
    this.reportError(res);
    return res;
  }

  async rematch(gameId: string): Promise<boolean> {
    const res = await this.command('game:rematch', { gameId });
    this.reportError(res);
    return res.ok;
  }

  /** 나가기: 서버 응답과 관계없이 토큰을 폐기하고 처음 화면으로 */
  async leave(): Promise<void> {
    if (this.socket.connected && this.authed) {
      const body = { requestId: newRequestId() };
      let confirmed = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const res = await this.emitOnce('room:leave', body, ACK_TIMEOUT_MS);
        if (res.ok || res.code !== 'TIMEOUT') { confirmed = true; break; }
      }
      // 응답을 못 받았으면 이 연결이 서버에서 아직 참가자로 묶여 있을 수 있다(새 방 생성·참가가 거절됨).
      // 연결을 새로 만들어 묶임을 끊는다. 토큰은 아래에서 폐기되므로 자동 복귀하지 않는다.
      if (!confirmed) { this.goHome(null); this.socket.disconnect().connect(); return; }
    }
    this.goHome(null);
  }
}

export type { ErrorCode };
export const client = new GameClient();
