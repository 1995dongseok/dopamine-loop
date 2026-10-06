import type { RoomSnapshot } from '../../shared/protocol';
import { useRemainingSeconds } from '../hooks';
import { sortedOdds } from '../lib/rules';
import { Countdown, Scoreboard } from '../components/common';
import { HistoryLog, OddsList, ResultView } from '../components/ResultView';

export function NightScreen({ snapshot }: { snapshot: RoomSnapshot }) {
  const game = snapshot.game!;
  const result = game.lastResult;
  const seconds = useRemainingSeconds(game.deadline);
  const myOdds = result ? sortedOdds(result.nightOdds[snapshot.you.playerId]) : [];
  const isLast = game.day >= game.maxDays;

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
            // key로 결과가 바뀔 때마다 애니메이션을 다시 재생 (장식용)
            <ResultView key={`${game.gameId}:${result.day}`} result={result} snapshot={snapshot} animate />
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
          <HistoryLog snapshot={snapshot} />
        </aside>
      </div>
    </main>
  );
}
