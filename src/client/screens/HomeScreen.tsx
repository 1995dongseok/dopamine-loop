import { useState, type FormEvent } from 'react';
import { client } from '../net/client';
import { errorText } from '../lib/errors';
import { useClientState } from '../hooks';

const NICK_KEY = 'dopamine-loop.nickname';

/** 초대코드 정규화: 공백 제거·대문자 변환, 영문/숫자만 6자리 */
export function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
const normalizeNick = (raw: string) => raw.replace(/\s+/g, ' ').trim();

export function HomeScreen() {
  const st = useClientState();
  const [nickname, setNickname] = useState(() => {
    try { return localStorage.getItem(NICK_KEY) ?? ''; } catch { return ''; }
  });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);

  const nick = normalizeNick(nickname);
  const nickOk = nick.length >= 1 && [...nick].length <= 12;
  const online = st.conn === 'online';

  const remember = () => { try { localStorage.setItem(NICK_KEY, nick); } catch { /* 무시 */ } };

  async function onCreate() {
    if (!nickOk) { setError(errorText('NICKNAME_INVALID')); return; }
    setBusy('create'); setError(null); client.clearHomeNotice();
    const res = await client.createRoom(nick);
    setBusy(null);
    if (!res.ok) setError(errorText(res.code)); else remember();
  }

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    if (!nickOk) { setError(errorText('NICKNAME_INVALID')); return; }
    const c = normalizeCode(code);
    if (c.length !== 6) { setError('초대코드 6자리를 입력해 주세요.'); return; }
    setBusy('join'); setError(null); client.clearHomeNotice();
    const res = await client.joinRoom(c, nick);
    setBusy(null);
    if (!res.ok) setError(errorText(res.code)); else remember();
  }

  return (
    <main className="home">
      <div className="hero">
        <h1 className="logo">도파민 루프</h1>
        <p className="tagline">낮엔 내가 고르고, 밤엔 습관이 고른다.<br />먼저 100점에 도달하면 승리!</p>
      </div>

      {st.homeNotice && <div className="notice" role="status">{st.homeNotice}</div>}

      <section className="panel home-panel">
        <label className="field">
          <span className="field-label">닉네임</span>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={24}
            placeholder="1~12자"
            autoComplete="nickname"
          />
          <span className={`field-hint${nick && !nickOk ? ' bad' : ''}`}>{[...nick].length}/12</span>
        </label>

        <button className="btn primary block" onClick={onCreate} disabled={!online || busy !== null}>
          {busy === 'create' ? '만드는 중…' : '방 만들기'}
        </button>

        <div className="divider"><span>또는 초대코드로 입장</span></div>

        <form onSubmit={onJoin} className="join-form">
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            placeholder="ABC123"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-label="초대코드"
          />
          <button className="btn accent" type="submit" disabled={!online || busy !== null}>
            {busy === 'join' ? '입장 중…' : '입장'}
          </button>
        </form>

        {error && <p className="error" role="alert">{error}</p>}
        {!online && <p className="muted small center">서버에 연결하는 중…</p>}
      </section>

      <details className="panel rules-brief">
        <summary>게임 방법</summary>
        <ul>
          <li>2~6명, 최대 10일. 매일 낮에 행동력 3으로 행동 3칸을 순서대로 정합니다 (45초).</li>
          <li>즉시 행동은 처음엔 짜릿하지만 반복하면 손해. 안정·성장 행동은 꾸준히 쌓입니다.</li>
          <li>낮에 한 일반 행동은 습관이 되고, 밤에는 습관 비율대로 2번 자동 행동합니다.</li>
          <li>회복 행동으로 나쁜 습관을 줄일 수 있습니다. 밤이 끝난 뒤 100점 이상 최고 점수가 승리!</li>
        </ul>
      </details>
    </main>
  );
}
