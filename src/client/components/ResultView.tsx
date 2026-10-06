// 하루 결과(낮 슬롯 + 밤 추첨 2회) 표시. 서버가 저장한 결과를 그대로 재생하며 애니메이션은 장식일 뿐이다.
import type { RoomSnapshot } from '../../shared/protocol';
import type { ActionId, DayResult, ResolutionEvent } from '../../shared/types';
import { actionName, pct, signed, sortedOdds } from '../lib/rules';
import { nameOf } from './common';

// 밤 결과 애니메이션은 일차마다 한 번만 재생한다 (새로고침·재마운트 시 다시 재생하지 않음)
const SHOWN_KEY = 'dopamine-loop.nightShown';
const shownInMemory = new Set<string>();

export function nightAnimationShown(key: string): boolean {
  if (shownInMemory.has(key)) return true;
  try { return sessionStorage.getItem(SHOWN_KEY) === key; } catch { return false; }
}

export function markNightAnimationShown(key: string): void {
  shownInMemory.add(key);
  try { sessionStorage.setItem(SHOWN_KEY, key); } catch { /* 저장소 사용 불가: 이 탭 메모리만 사용 */ }
}

const DAY_STEP = 0.35;
const NIGHT_START = 1.4;
const NIGHT_STEP = 0.7;

function EventRow({ e, animate }: { e: ResolutionEvent; animate: boolean }) {
  const delay = e.phase === 'day' ? e.index * DAY_STEP : NIGHT_START + e.index * NIGHT_STEP;
  const cls = e.delta > 0 ? 'pos' : e.delta < 0 ? 'neg' : 'zero';
  return (
    <li className={`event ${e.phase}${animate ? ' anim' : ''}`} style={animate ? { animationDelay: `${delay}s` } : undefined}>
      <span className="event-tag">{e.phase === 'day' ? `낮 ${e.index + 1}` : `밤 ${e.index + 1}`}</span>
      <span className="event-main">
        <span className="event-name">
          {actionName(e.actionId)}
          {e.targetId && <span className="event-target"> → {actionName(e.targetId)}</span>}
        </span>
        {e.notes.length > 0 && <span className="event-notes">{e.notes.join(' · ')}</span>}
      </span>
      <span className={`delta ${cls}`}>{signed(e.delta)}</span>
    </li>
  );
}

export function ResultView({ result, snapshot, animate, highlightMe = true }: {
  result: DayResult; snapshot: RoomSnapshot; animate: boolean; highlightMe?: boolean;
}) {
  const myId = snapshot.you.playerId;
  const ids = Array.from(new Set([...result.dayEvents, ...result.nightEvents].map((e) => e.playerId)));
  // 나를 먼저, 그 외는 하루 종료 점수 순
  ids.sort((a, b) => Number(b === myId) - Number(a === myId) || (result.scoresAfter[b] ?? 0) - (result.scoresAfter[a] ?? 0));
  return (
    <div className="result-grid">
      {ids.map((id) => {
        const day = result.dayEvents.filter((e) => e.playerId === id).sort((a, b) => a.index - b.index);
        const night = result.nightEvents.filter((e) => e.playerId === id).sort((a, b) => a.index - b.index);
        const total = [...day, ...night].reduce((s, e) => s + e.delta, 0);
        const odds = sortedOdds(result.nightOdds[id]);
        return (
          <section key={id} className={`result-card${highlightMe && id === myId ? ' mine' : ''}`}>
            <header className="result-head">
              <span className="nick">{nameOf(snapshot, id)}</span>
              <span className={`delta big ${total > 0 ? 'pos' : total < 0 ? 'neg' : 'zero'}`}>{signed(total)}</span>
              <span className="result-score">→ {result.scoresAfter[id] ?? '-'}점</span>
            </header>
            <ul className="events">
              {day.map((e) => <EventRow key={`d${e.index}`} e={e} animate={animate} />)}
              {night.length === 0 && <li className="event night muted">밤: 습관이 없어 아무 일도 없었다</li>}
              {night.map((e) => <EventRow key={`n${e.index}`} e={e} animate={animate} />)}
            </ul>
            {odds.length > 0 && (
              <details className="odds-details">
                <summary>밤 습관 확률</summary>
                <OddsList odds={odds} />
              </details>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function OddsList({ odds }: { odds: [ActionId, number][] }) {
  if (odds.length === 0) return <p className="muted small">습관이 없어 밤에는 아무 행동도 하지 않습니다.</p>;
  return (
    <ul className="odds">
      {odds.map(([id, p]) => (
        <li key={id}>
          <span className="odds-name">{actionName(id)}</span>
          <span className="odds-bar"><span style={{ width: `${Math.round(p * 100)}%` }} /></span>
          <span className="odds-pct">{pct(p)}</span>
        </li>
      ))}
    </ul>
  );
}

/** 지난 일차 기록. excludeDay: 화면 본문에 이미 크게 표시 중인 날(중복 표시 방지) */
export function HistoryLog({ snapshot, excludeDay }: { snapshot: RoomSnapshot; excludeDay?: number }) {
  const history = (snapshot.game?.history ?? []).filter((r) => r.day !== excludeDay);
  if (history.length === 0) return null;
  return (
    <section className="panel">
      <h3 className="panel-title">하루 기록</h3>
      {[...history].reverse().map((r) => (
        <details key={r.day} className="history-day">
          <summary>
            <span>{r.day}일차</span>
            <span className="history-summary">
              {Object.entries(r.scoresAfter)
                .sort((a, b) => b[1] - a[1])
                .map(([id, s]) => `${nameOf(snapshot, id)} ${s}`)
                .join(' · ')}
            </span>
          </summary>
          <ResultView result={r} snapshot={snapshot} animate={false} />
        </details>
      ))}
    </section>
  );
}
