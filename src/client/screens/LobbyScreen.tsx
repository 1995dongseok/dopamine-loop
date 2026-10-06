import { useState } from 'react';
import type { RoomSnapshot } from '../../shared/protocol';
import { GAME_CONSTANTS } from '../../shared/rules';
import { client } from '../net/client';
import { copyText } from '../lib/clipboard';
import { PlayerBadges } from '../components/common';

export function LobbyScreen({ snapshot, locked }: { snapshot: RoomSnapshot; locked: boolean }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [busy, setBusy] = useState(false);
  const me = snapshot.players.find((p) => p.playerId === snapshot.you.playerId);
  const isHost = snapshot.hostPlayerId === snapshot.you.playerId;
  const players = [...snapshot.players].sort((a, b) => a.joinOrder - b.joinOrder);
  const n = players.length;
  const allReady = players.every((p) => p.connected && p.ready);
  const canStart = n >= GAME_CONSTANTS.minPlayers && n <= GAME_CONSTANTS.maxPlayers && allReady;

  async function copy() {
    const ok = await copyText(snapshot.code);
    setCopied(ok ? 'ok' : 'fail');
    setTimeout(() => setCopied(null), 2000);
  }

  async function toggleReady() {
    setBusy(true);
    await client.setReady(!me?.ready);
    setBusy(false);
  }

  async function start() {
    setBusy(true);
    await client.startGame();
    setBusy(false);
  }

  let startHint = '';
  if (n < GAME_CONSTANTS.minPlayers) startHint = `최소 ${GAME_CONSTANTS.minPlayers}명이 필요합니다.`;
  else if (!allReady) startHint = '모든 참가자가 연결되어 있고 준비해야 시작할 수 있습니다.';

  return (
    <main className="lobby">
      <section className="panel code-panel">
        <span className="muted small">초대코드</span>
        <div className="room-code" aria-label={`초대코드 ${snapshot.code}`}>{snapshot.code}</div>
        <button className="btn ghost" onClick={copy}>
          {copied === 'ok' ? '복사됨!' : copied === 'fail' ? '복사 실패 — 직접 입력해 주세요' : '코드 복사'}
        </button>
      </section>

      <section className="panel">
        <h3 className="panel-title">참가자 {n}/{GAME_CONSTANTS.maxPlayers}</h3>
        <ul className="lobby-list">
          {players.map((p) => (
            <li key={p.playerId} className={`lobby-row${p.playerId === snapshot.you.playerId ? ' mine' : ''}`}>
              <span className={`dot ${p.connected ? 'on' : 'off'}`} />
              <span className="nick">{p.nickname}</span>
              <PlayerBadges p={p} snapshot={snapshot} />
              <span className={`ready-tag ${p.ready ? 'yes' : 'no'}`}>{p.ready ? '준비 완료' : '대기 중'}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="lobby-actions">
        <button className={`btn block ${me?.ready ? 'ghost' : 'accent'}`} onClick={toggleReady} disabled={locked || busy}>
          {me?.ready ? '준비 취소' : '준비하기'}
        </button>
        {isHost ? (
          <>
            <button className="btn primary block" onClick={start} disabled={locked || busy || !canStart}>게임 시작</button>
            {startHint && <p className="muted small center">{startHint}</p>}
          </>
        ) : (
          <p className="muted small center">방장이 게임을 시작하면 바로 첫째 날이 시작됩니다.</p>
        )}
      </div>
    </main>
  );
}
