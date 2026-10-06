import { useEffect, useRef, type ReactNode } from 'react';
import type { PublicPlayer, RoomSnapshot } from '../../shared/protocol';
import { GAME_CONSTANTS } from '../../shared/rules';

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}
        onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog(props: {
  title: string; message: ReactNode; confirmText: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={props.title} onClose={props.onCancel}>
      <div className="modal-body">{props.message}</div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={props.onCancel}>취소</button>
        <button className={`btn ${props.danger ? 'danger' : 'primary'}`} onClick={props.onConfirm}>{props.confirmText}</button>
      </div>
    </Modal>
  );
}

export function nameOf(snapshot: RoomSnapshot, playerId: string): string {
  return snapshot.players.find((p) => p.playerId === playerId)?.nickname ?? '(나간 참가자)';
}

export function PlayerBadges({ p, snapshot }: { p: PublicPlayer; snapshot: RoomSnapshot }) {
  return (
    <>
      {p.playerId === snapshot.hostPlayerId && <span className="badge host" title="방장">👑 방장</span>}
      {p.playerId === snapshot.you.playerId && <span className="badge me">나</span>}
      {!p.connected && !p.forfeited && <span className="badge off">연결 끊김</span>}
      {p.forfeited && <span className="badge forfeit">기권</span>}
    </>
  );
}

/** 점수판: 점수 내림차순, 목표 점수 진행 막대, (낮에는) 제출 여부만 표시 */
export function Scoreboard({ snapshot, showSubmitted }: { snapshot: RoomSnapshot; showSubmitted: boolean }) {
  const game = snapshot.game;
  const target = game?.targetScore ?? GAME_CONSTANTS.targetScore;
  const scoreOf = (id: string) => game?.players.find((g) => g.playerId === id)?.score ?? 0;
  const rows = [...snapshot.players].sort((a, b) =>
    Number(a.forfeited) - Number(b.forfeited) || scoreOf(b.playerId) - scoreOf(a.playerId) || a.joinOrder - b.joinOrder);
  return (
    <ul className="scoreboard">
      {rows.map((p) => {
        const score = scoreOf(p.playerId);
        const w = Math.min(100, (score / target) * 100);
        return (
          <li key={p.playerId} className={`score-row${p.playerId === snapshot.you.playerId ? ' mine' : ''}${p.forfeited ? ' forfeited' : ''}`}>
            <div className="score-top">
              <span className={`dot ${p.connected ? 'on' : 'off'}`} aria-label={p.connected ? '연결됨' : '연결 끊김'} />
              <span className="nick">{p.nickname}</span>
              <PlayerBadges p={p} snapshot={snapshot} />
              {showSubmitted && !p.forfeited && (
                <span className={`submit-mark ${p.submitted ? 'done' : ''}`} title={p.submitted ? '확정함' : '고르는 중'}>
                  {p.submitted ? '✓ 확정' : '…'}
                </span>
              )}
              <span className="score">{score}</span>
            </div>
            <div className="bar"><div className="bar-fill" style={{ width: `${w}%` }} /></div>
          </li>
        );
      })}
      <li className="score-target">목표 {target}점</li>
    </ul>
  );
}

export function Countdown({ seconds, warnAt = 10 }: { seconds: number | null; warnAt?: number }) {
  if (seconds == null) return null;
  return <span className={`countdown${seconds <= warnAt ? ' warn' : ''}`}>{seconds}초</span>;
}

/** 모바일 전용 가로 점수 띠 (낮 화면 상단) */
export function MobileScores({ snapshot }: { snapshot: RoomSnapshot }) {
  const game = snapshot.game;
  const scoreOf = (id: string) => game?.players.find((g) => g.playerId === id)?.score ?? 0;
  const rows = [...snapshot.players].sort((a, b) => scoreOf(b.playerId) - scoreOf(a.playerId));
  return (
    <div className="mobile-scores" aria-hidden="true">
      {rows.map((p) => (
        <span key={p.playerId} className={`chip${p.playerId === snapshot.you.playerId ? ' mine' : ''}${p.forfeited ? ' forfeited' : ''}`}>
          <span className={`dot ${p.connected ? 'on' : 'off'}`} />
          <span className="nick">{p.nickname}</span>
          <b>{scoreOf(p.playerId)}</b>
          {!p.forfeited && <span className={p.submitted ? 'pos' : 'muted'}>{p.submitted ? '✓' : '…'}</span>}
        </span>
      ))}
    </div>
  );
}
