import { useState } from 'react';
import type { RoomSnapshot } from '../../shared/protocol';
import { client } from '../net/client';
import { nameOf, PlayerBadges } from '../components/common';
import { HistoryLog, ResultView } from '../components/ResultView';

export function FinishedScreen({ snapshot, locked, onLeave }: { snapshot: RoomSnapshot; locked: boolean; onLeave: () => void }) {
  const game = snapshot.game!;
  const [busy, setBusy] = useState(false);
  const isHost = snapshot.hostPlayerId === snapshot.you.playerId;
  const winners = game.winnerIds;
  const iWon = winners.includes(snapshot.you.playerId);

  const scoreOf = (id: string) => game.players.find((g) => g.playerId === id)?.score ?? 0;
  const ranked = [...snapshot.players].sort((a, b) =>
    Number(a.forfeited) - Number(b.forfeited) || scoreOf(b.playerId) - scoreOf(a.playerId));
  // 동점 공동 순위
  const rankOf = (id: string) => {
    const p = ranked.find((r) => r.playerId === id)!;
    if (p.forfeited) return null;
    return ranked.filter((r) => !r.forfeited && scoreOf(r.playerId) > scoreOf(id)).length + 1;
  };

  let headline: string;
  if (winners.length === 0) headline = '승자 없이 게임이 끝났습니다';
  else if (winners.length === 1) headline = `🏆 ${nameOf(snapshot, winners[0])} 승리!`;
  else headline = `🏆 공동 승리: ${winners.map((w) => nameOf(snapshot, w)).join(', ')}`;

  async function rematch() {
    setBusy(true);
    await client.rematch(game.gameId);
    setBusy(false);
  }

  return (
    <main className="finished">
      <section className={`panel winner-panel${iWon ? ' won' : ''}`}>
        <h2 className="headline">{headline}</h2>
        <p className="muted">
          {game.day}일차에 종료 · 목표 {game.targetScore}점
          {iWon && ' · 축하합니다!'}
        </p>
      </section>

      <section className="panel">
        <h3 className="panel-title">최종 순위</h3>
        <ol className="ranking">
          {ranked.map((p) => {
            const r = rankOf(p.playerId);
            return (
              <li key={p.playerId} className={`rank-row${winners.includes(p.playerId) ? ' winner' : ''}${p.playerId === snapshot.you.playerId ? ' mine' : ''}`}>
                <span className="rank">{r ?? '-'}</span>
                <span className="nick">{p.nickname}</span>
                <PlayerBadges p={p} snapshot={snapshot} />
                <span className="score">{scoreOf(p.playerId)}점</span>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="lobby-actions">
        {isHost ? (
          <button className="btn primary block" onClick={rematch} disabled={locked || busy}>같은 방에서 다시 하기</button>
        ) : (
          <p className="muted small center">방장이 “다시 하기”를 누르면 대기실로 이동합니다.</p>
        )}
        <button className="btn ghost block" onClick={onLeave}>나가기</button>
      </div>

      {game.lastResult && (
        <details className="panel" open>
          <summary className="panel-title">마지막 날({game.lastResult.day}일차) 결과</summary>
          <ResultView result={game.lastResult} snapshot={snapshot} animate={false} />
        </details>
      )}
      <HistoryLog snapshot={snapshot} />
    </main>
  );
}
