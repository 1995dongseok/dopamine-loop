import { useState } from 'react';
import { client } from './net/client';
import { useClientState } from './hooks';
import { ConfirmDialog } from './components/common';
import { HomeScreen } from './screens/HomeScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { DayScreen } from './screens/DayScreen';
import { NightScreen } from './screens/NightScreen';
import { FinishedScreen } from './screens/FinishedScreen';

export function App() {
  const st = useClientState();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const snap = st.snapshot;

  // 조작 차단: 끊김·복귀 중·다른 탭으로 권한 이전
  const offline = st.conn !== 'online';
  const locked = offline || st.resuming || st.replaced;
  const inGame = snap !== null && (snap.phase === 'DAY' || snap.phase === 'RESOLVING' || snap.phase === 'NIGHT_RESULT');
  const meForfeited = !!snap?.players.find((p) => p.playerId === snap.you.playerId)?.forfeited;

  const requestLeave = () => {
    if (inGame && !meForfeited) setConfirmLeave(true);
    else void client.leave();
  };

  let screen;
  if (!snap && st.resumeStuck) {
    screen = (
      <main className="center-screen">
        <p>이전 방으로 복귀하지 못했습니다. 서버 응답이 없습니다.</p>
        <button className="btn primary" onClick={() => void client.resume()}>다시 시도</button>
        <button className="btn ghost" onClick={() => void client.leave()}>처음 화면으로</button>
      </main>
    );
  } else if (!snap) {
    screen = st.resuming || (client.hasToken && st.conn === 'connecting')
      ? <main className="center-screen"><div className="spinner" /><p>이전 방으로 복귀하는 중…</p></main>
      : <HomeScreen />;
  } else if (snap.phase === 'LOBBY') {
    screen = <LobbyScreen snapshot={snap} locked={locked} />;
  } else if (!snap.game) {
    screen = <main className="center-screen"><div className="spinner" /></main>;
  } else if (snap.phase === 'DAY' || snap.phase === 'RESOLVING') {
    screen = <DayScreen snapshot={snap} locked={locked} />;
  } else if (snap.phase === 'NIGHT_RESULT') {
    screen = <NightScreen snapshot={snap} />;
  } else {
    screen = <FinishedScreen snapshot={snap} locked={locked} onLeave={requestLeave} />;
  }

  return (
    <div className="app">
      {snap && (
        <nav className="topbar">
          <span className="brand">도파민 루프</span>
          <span className="topbar-code">방 {snap.code}</span>
          <button className="btn small ghost" onClick={requestLeave}>나가기</button>
        </nav>
      )}

      {screen}

      {snap && st.replaced && (
        <div className="overlay" role="alertdialog" aria-live="assertive">
          <div className="overlay-box">
            <p className="overlay-title">조작이 중지되었습니다</p>
            <p>다른 탭/기기에서 접속하여 이 화면의 조작이 중지되었습니다.</p>
            <button className="btn primary" onClick={() => client.takeOver()}>이 화면에서 다시 접속</button>
          </div>
        </div>
      )}

      {snap && !st.replaced && (offline || st.resuming || st.resumeStuck) && (
        <div className="overlay" role="status" aria-live="polite">
          <div className="overlay-box">
            {st.resumeStuck ? (
              <>
                <p className="overlay-title">복귀하지 못했습니다</p>
                <p>서버 응답이 없습니다. 잠시 후 다시 시도해 주세요.</p>
                <button className="btn primary" onClick={() => void client.resume()}>다시 시도</button>
              </>
            ) : (
              <>
                <div className="spinner" />
                <p className="overlay-title">{offline ? '연결이 끊겼습니다' : '방 상태를 불러오는 중'}</p>
                <p className="muted">{offline ? '재접속하는 중입니다… 게임은 서버 시간표대로 계속 진행됩니다.' : '잠시만 기다려 주세요.'}</p>
              </>
            )}
          </div>
        </div>
      )}

      {confirmLeave && (
        <ConfirmDialog
          title="게임에서 나갈까요?"
          message="게임 중에 나가면 기권 처리되어 이후 정산과 승리 대상에서 제외됩니다. 다시 돌아올 수 없습니다."
          confirmText="기권하고 나가기"
          danger
          onConfirm={() => { setConfirmLeave(false); void client.leave(); }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}

      {st.toast && <div className="toast" key={st.toast.id} role="status">{st.toast.text}</div>}
    </div>
  );
}
