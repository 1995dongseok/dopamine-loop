# 도파민 루프

초대코드로 2~6명이 함께 하는 웹 게임. 낮에는 행동 3칸을 직접 고르고, 밤에는 습관 비율대로 자동 행동이 2번 일어난다. 100점 이상 최고 점수가 승리(최대 10일).

- 규칙·수치표: [docs/RULES.md](docs/RULES.md)
- 밸런스 시뮬레이션: [docs/BALANCE.md](docs/BALANCE.md)
- 구현 계획: [PLAN.md](PLAN.md)

## 구성

| 경로 | 내용 |
|---|---|
| `src/shared/rules` | 규칙 계산(순수 함수)과 행동 수치 데이터 `actionData.ts` |
| `src/shared/protocol.ts` | Socket.IO 명령·스냅샷 계약 |
| `src/server` | Express + Socket.IO 서버, 방·타이머·재접속 (메모리 저장) |
| `src/client` | React 화면 |
| `sim` | 봇 전략 시뮬레이션 |
| `test/server` | 실제 서버에 소켓 클라이언트를 붙이는 통신 테스트 |

## 로컬 실행

Node 24 LTS (`.nvmrc`).

```bash
npm ci
npm run dev        # 서버 :3000 + 화면 :5173 (http://localhost:5173 접속)
```

운영 빌드 확인:

```bash
npm run build
NODE_ENV=production npm start   # http://localhost:3000
```

테스트·검사:

```bash
npm test           # 규칙·통신·시뮬레이션 테스트
npm run typecheck
npm run sim        # 밸런스 시뮬레이션
```

## 환경 변수

| 이름 | 설명 |
|---|---|
| `PORT` / `HOST` | 기본 3000 / 0.0.0.0 |
| `NODE_ENV=production` | 빌드된 화면(`dist/client`) 제공, Origin 제한 |
| `ALLOWED_ORIGIN` | 추가 허용 Origin (쉼표 구분). 같은 호스트는 항상 허용 |
| `TRUST_PROXY=1` | 프록시 뒤(Render 등)에서 X-Forwarded-For로 IP 판단 (속도 제한용) |
| `DAY_SECONDS` / `NIGHT_RESULT_SECONDS` / `HOST_GRACE_SECONDS` | 시연·테스트용 시간 단축. 기본 45 / 8 / 30 |

## 배포 (Render)

1. 이 저장소를 GitHub에 올린다.
2. Render에서 New → Blueprint로 저장소를 선택하면 `render.yaml` 설정(빌드 `npm ci --include=dev && npm run build`, 시작 `npm start`, 헬스체크 `/healthz`)으로 Web Service가 만들어진다.
3. 반드시 **인스턴스 1개**로 운영한다. 상태가 메모리에만 있으므로 여러 인스턴스로 늘리면 방이 나뉜다.

## 운영 한계

- 서버 재시작·재배포 시 진행 중인 방과 재접속 정보가 사라진다.
- 단일 인스턴스·단일 프로세스 전제.
- Render 무료 플랜은 유휴 시 잠들어 첫 접속이 느리고, 잠들면 방도 사라진다.
