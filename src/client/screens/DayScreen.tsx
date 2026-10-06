import { useMemo, useState } from 'react';
import type { RoomSnapshot } from '../../shared/protocol';
import { ACTIONS, GAME_CONSTANTS } from '../../shared/rules';
import type { ActionId, ActionMeta, PlayerRuleState } from '../../shared/types';
import { client } from '../net/client';
import { useRemainingSeconds } from '../hooks';
import {
  CATEGORY_LABEL, CATEGORY_ORDER, HABIT_ACTIONS, actionName, cellsFromPlan, clearCell, emptyCells, meta,
  nextFreeIndex, placeAction, planFromCells, plannedSlots, rangeText, safeHabitsAfter, safeNightOdds, safePlannedPreview, sortedOdds,
  usedPoints, type Cells,
} from '../lib/rules';
import { ConfirmDialog, Countdown, MobileScores, Modal, Scoreboard } from '../components/common';
import { HistoryLog, OddsList, ResultView } from '../components/ResultView';

const EMPTY_STATE = (playerId: string): PlayerRuleState => ({
  playerId, score: 0, uses: {}, habits: {}, dailyUses: {}, streakAction: null, streakCount: 0, flags: {}, forfeited: false,
});

export function DayScreen({ snapshot, locked: connLocked }: { snapshot: RoomSnapshot; locked: boolean }) {
  const game = snapshot.game!;
  const myId = snapshot.you.playerId;
  const me = game.players.find((p) => p.playerId === myId) ?? EMPTY_STATE(myId);
  const resolving = snapshot.phase === 'RESOLVING';
  const submittedPlan = snapshot.you.submittedPlan;
  const planKey = `${game.gameId}:${game.day}`;

  const [draft, setDraft] = useState<{ key: string; cells: Cells }>({ key: planKey, cells: emptyCells() });
  const [submitting, setSubmitting] = useState(false);
  const [sentKey, setSentKey] = useState<string | null>(null);
  const [targetFor, setTargetFor] = useState<ActionMeta | null>(null);
  const [confirmPartial, setConfirmPartial] = useState(false);

  const draftCells = draft.key === planKey ? draft.cells : emptyCells();
  const isSubmitted = submittedPlan !== null || sentKey === planKey;
  const cells: Cells = submittedPlan ? cellsFromPlan(submittedPlan) : draftCells;
  const editable = !isSubmitted && !resolving && !connLocked && !me.forfeited && !submitting;

  const seconds = useRemainingSeconds(resolving ? null : game.deadline);
  const habitsAfter = useMemo(() => safeHabitsAfter(me, cells), [me, cells]);
  const plan = planFromCells(cells);
  const expectedOdds = useMemo(() => sortedOdds(safeNightOdds(me, planFromCells(cells))), [me, cells]);
  const points = usedPoints(cells);

  const setCells = (c: Cells) => setDraft({ key: planKey, cells: c });

  function pick(a: ActionMeta) {
    if (!editable || nextFreeIndex(cells, a.cost) < 0) return;
    if (a.needsTarget) { setTargetFor(a); return; }
    const next = placeAction(cells, { actionId: a.id });
    if (next) setCells(next);
  }

  function pickTarget(target: ActionId) {
    if (!targetFor) return;
    const next = placeAction(cells, { actionId: targetFor.id, targetId: target });
    setTargetFor(null);
    if (next) setCells(next);
  }

  async function submit() {
    setConfirmPartial(false);
    setSubmitting(true);
    const res = await client.submitPlan(game.gameId, game.day, plan);
    setSubmitting(false);
    if (res.ok) setSentKey(planKey);
  }

  const onConfirmClick = () => {
    if (points < GAME_CONSTANTS.actionPoints) setConfirmPartial(true);
    else void submit();
  };

  const othersWaiting = snapshot.players.filter((p) => !p.forfeited && !p.submitted && p.playerId !== myId).length;

  return (
    <main className="day">
      <header className="status-bar">
        <div className="status-day">
          <span className="day-num">{game.day}</span><span className="day-of">/{game.maxDays}일차</span>
        </div>
        <div className="status-phase">{resolving ? '🌙 정산 중…' : '☀️ 낮 — 행동 고르기'}</div>
        <Countdown seconds={seconds} />
      </header>

      <MobileScores snapshot={snapshot} />

      {me.forfeited && <div className="notice">기권하여 이번 게임에서는 조작할 수 없습니다.</div>}

      <div className="day-layout">
        <div className="day-main">
          {CATEGORY_ORDER.map((cat) => (
            <section key={cat} className={`cat-section cat-${cat}`}>
              <h3 className="cat-title">{CATEGORY_LABEL[cat]}</h3>
              <div className="cards">
                {ACTIONS.filter((a) => a.category === cat).map((a) => {
                  const inPlan = plannedSlots(cells).filter((s) => s.actionId === a.id).length;
                  const fits = nextFreeIndex(cells, a.cost) >= 0;
                  const pv = safePlannedPreview(me, a.id, cells, game.day);
                  return (
                    <button
                      key={a.id}
                      className={`card cat-${cat}${inPlan ? ' picked' : ''}`}
                      onClick={() => pick(a)}
                      disabled={!editable || !fits}
                      aria-label={`${a.name} 선택`}
                    >
                      <div className="card-head">
                        <span className="card-name">{a.name}</span>
                        {a.cost === 2 && <span className="cost">행동력 2</span>}
                        {inPlan > 0 && <span className="in-plan">×{inPlan}</span>}
                      </div>
                      <div className="card-desc">{a.description}</div>
                      <div className="card-preview">
                        {pv ? (
                          <>
                            <span className={`range ${pv.max > 0 ? 'pos' : pv.max < 0 ? 'neg' : 'zero'}`}>{rangeText(pv)}</span>
                            <span className="stage">{pv.nextUse}회째 · {pv.label}</span>
                          </>
                        ) : (
                          <span className="stage muted">미리보기 준비 중</span>
                        )}
                      </div>
                      <div className="card-stats">
                        {a.formsHabit && <span>습관 {me.habits[a.id] ?? 0}</span>}
                        <span>누적 {me.uses[a.id] ?? 0}회</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <aside className="day-side">
          <section className="panel">
            <h3 className="panel-title">점수판</h3>
            <Scoreboard snapshot={snapshot} showSubmitted />
          </section>
          <section className="panel">
            <h3 className="panel-title">예상 밤 확률 <span className="muted small">(예상 · 실제는 서버가 결정)</span></h3>
            <OddsList odds={expectedOdds} />
          </section>
          {game.lastResult && (
            <details className="panel">
              <summary className="panel-title">{game.lastResult.day}일차 결과 다시 보기</summary>
              <ResultView result={game.lastResult} snapshot={snapshot} animate={false} />
            </details>
          )}
          <HistoryLog snapshot={snapshot} excludeDay={game.lastResult?.day} />
        </aside>
      </div>

      <div className="slot-dock">
        <div className="slots">
          {cells.map((c, i) => {
            if (c === 'used') {
              return (
                <button key={i} className="slot used" onClick={() => editable && setCells(clearCell(cells, i))} disabled={!editable}>
                  <span className="slot-num">{i + 1}</span><span className="slot-name muted">(이어서)</span>
                </button>
              );
            }
            return (
              <button key={i} className={`slot${c ? ' filled cat-' + meta(c.actionId)?.category : ''}`}
                onClick={() => c && editable && setCells(clearCell(cells, i))} disabled={!editable || !c}
                aria-label={c ? `${i + 1}번 칸 ${actionName(c.actionId)} 비우기` : `${i + 1}번 칸 비어 있음`}>
                <span className="slot-num">{i + 1}</span>
                <span className="slot-name">{c ? actionName(c.actionId) : '비어 있음'}</span>
                {c?.targetId && <span className="slot-target">→ {actionName(c.targetId)}</span>}
              </button>
            );
          })}
        </div>
        <div className="dock-actions">
          {isSubmitted ? (
            <div className="waiting">
              ✓ 확정 완료 — {othersWaiting > 0 ? `${othersWaiting}명 기다리는 중` : '곧 정산합니다'}
            </div>
          ) : (
            <>
              <span className="points">행동력 {points}/{GAME_CONSTANTS.actionPoints}</span>
              <button className="btn primary" onClick={onConfirmClick} disabled={!editable}>
                {submitting ? '확정 중…' : '확정'}
              </button>
            </>
          )}
        </div>
        {editable && points > 0 && <p className="dock-hint muted small">칸을 누르면 비웁니다.</p>}
      </div>

      {targetFor && (
        <Modal title={`${targetFor.name}: 습관을 줄일 대상`} onClose={() => setTargetFor(null)}>
          <p className="modal-body muted small">{targetFor.description}</p>
          <div className="target-list">
            {[...HABIT_ACTIONS]
              .sort((a, b) => (me.habits[b.id] ?? 0) - (me.habits[a.id] ?? 0))
              .map((a) => (
                <button key={a.id} className={`target-btn cat-${a.category}`} onClick={() => pickTarget(a.id)}>
                  <span>{a.name}</span>
                  <span className="muted small">습관 {habitsAfter[a.id] ?? 0}</span>
                </button>
              ))}
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setTargetFor(null)}>취소</button>
          </div>
        </Modal>
      )}

      {confirmPartial && (
        <ConfirmDialog
          title="빈 칸이 있습니다"
          message={`남은 행동력 ${GAME_CONSTANTS.actionPoints - points}칸은 무행동으로 처리됩니다. 확정 후에는 바꿀 수 없습니다.`}
          confirmText="이대로 확정"
          onConfirm={() => void submit()}
          onCancel={() => setConfirmPartial(false)}
        />
      )}
    </main>
  );
}
