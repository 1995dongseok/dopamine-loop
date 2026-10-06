import { useEffect, useState } from 'react';
import type { RoomSnapshot } from '../../shared/protocol';
import { useRemainingSeconds } from '../hooks';
import { sortedOdds } from '../lib/rules';
import { Countdown, Scoreboard } from '../components/common';
import { HistoryLog, OddsList, ResultView, markNightAnimationShown, nightAnimationShown } from '../components/ResultView';

export function NightScreen({ snapshot }: { snapshot: RoomSnapshot }) {
  const game = snapshot.game!;
  const result = game.lastResult;
  const seconds = useRemainingSeconds(game.deadline);
  const myOdds = result ? sortedOdds(result.nightOdds[snapshot.you.playerId]) : [];
  const isLast = game.day >= game.maxDays;
  const resultKey = result ? `${game.gameId}:${result.day}` : null;
  // 처음 보는 결과만 애니메이션 (이미 본 결과는 새로고침·재마운트 시 바로 표시)
  const [animatedKey] = useState(() => (resultKey && !nightAnimationShown(resultKey) ? resultKey : null));
  useEffect(() => { if (resultKey) markNightAnimationShown(resultKey); }, [resultKey]);

  return (
    <main className="night">
      <header className="status-bar night-bar">
        <div className="status-day">
          <span className="day-num">{game.day}</span><span className="day-of">/{game.maxDays}일차</span>
        </div>
        <div className="status-phase">🌙 밤 결과</div>
        <span className="muted small">
          {isLast ? '최종 판정까지' : '다음 낮까지'} <Countdown seconds={seconds} warnAt={3} />
        </span>
      </header>

      <div className="day-layout">
        <div className="day-main">
          {result ? (
            <ResultView key={resultKey!} result={result} snapshot={snapshot} animate={animatedKey === resultKey} />
          ) : (
            <p className="muted">결과를 불러오는 중…</p>
          )}
        </div>
        <aside className="day-side">
          <section className="panel">
            <h3 className="panel-title">점수판</h3>
            <Scoreboard snapshot={snapshot} showSubmitted={false} />
          </section>
          <section className="panel">
            <h3 className="panel-title">오늘 밤 나의 습관 확률</h3>
            <OddsList odds={myOdds} />
          </section>
          <HistoryLog snapshot={snapshot} excludeDay={result?.day} />
        </aside>
      </div>
    </main>
  );
}
