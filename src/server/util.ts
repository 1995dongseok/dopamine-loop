// 서버 전용 보조 함수: 초대코드·토큰·닉네임 정규화·요청 제한.
import { createHash, randomBytes, randomInt } from 'node:crypto';

/** 혼동 문자(0/O, 1/I/L)를 제외한 31자. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function generateCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** 공백 제거·대문자 변환. 형식이 맞지 않으면 null. */
export function normalizeCode(raw: string): string | null {
  const s = raw.replace(/[\s-]+/g, '').toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

/** 참가자 비밀 토큰: 32바이트 → base64url 43자. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 짧은 내부 ID (공개되어도 무방). */
export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

/** 만료 토큰 기억용 해시 (원문 토큰을 오래 보관하지 않는다). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export const NICKNAME_MAX = 12;

/** 제어문자·보이지 않는 서식 문자 (탭/개행은 공백으로 취급) */
function hasForbiddenChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e)
      || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff) return true;
  }
  return false;
}

/** 공백 정리 후 1~12자(코드포인트 기준). 제어문자 포함 시 null. */
export function normalizeNickname(raw: string): string | null {
  if (hasForbiddenChar(raw)) return null;
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  const len = [...s].length;
  if (len < 1 || len > NICKNAME_MAX) return null;
  return s;
}

export function nicknameKey(nick: string): string {
  return nick.toLocaleLowerCase('ko');
}

export interface BucketConfig {
  /** 최대 버스트 */
  capacity: number;
  /** 초당 회복량 */
  refillPerSec: number;
}

/** 키별 토큰 버킷. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private cfg: BucketConfig, private now: () => number) {}

  private refill(key: string) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.cfg.capacity, at: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.cfg.capacity, b.tokens + ((t - b.at) / 1000) * this.cfg.refillPerSec);
      b.at = t;
    }
    return b;
  }

  /** 1 소비. 남은 양이 없으면 false. */
  take(key: string): boolean {
    const b = this.refill(key);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** 소비 없이 여유 여부 확인 */
  has(key: string): boolean {
    return this.refill(key).tokens >= 1;
  }

  /** 가득 찬 버킷 정리 */
  prune() {
    for (const k of [...this.buckets.keys()]) {
      if (this.refill(k).tokens >= this.cfg.capacity) this.buckets.delete(k);
    }
  }

  delete(key: string) {
    this.buckets.delete(key);
  }
}
