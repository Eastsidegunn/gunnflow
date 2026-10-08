> English: [README.md](README.md)

# Gunnflow

**Gunnflow는 백엔드에 종속되지 않는 인간용 cockpit입니다.** 의미와 진실이 백엔드에 있는
시스템을 위해 노드-관계 데이터를 시각화하고 조작합니다. UI는 받은 상태를 반영하고, 사람의
행동을 intent로 upstream에 전달하며, 결정 절차를 적용하고, 에이전트 산출물을 격리해 보여 주며,
주의 신호를 전달합니다. 어떤 상태·관계·행동·원인이 존재하고 어떻게 보이는지는 코드가 아니라
데이터 전용 wiring 설정에서 옵니다.

세 가지 원칙:

- **화면에서 의미 있는 것은 모두 수신된 것입니다.** cockpit은 진행도, 우선순위, 의존성, 위험,
  콘텐츠 적합성을 추론하지 않습니다. 스스로 만드는 것은 로컬에서만 의미 없는 노드 위치와
  자신의 동작에 대한 진술(“이 바이트를 표시했다”)뿐입니다.
- **직접 제어는 우회가 아닙니다.** 사람의 모든 개입은 백엔드의 append-only 감사 체인을 통해
  기록되는 새 intent입니다. 개입이 강할수록 추적 기록도 강해야 합니다.
- **cockpit은 진실을 발명하지 않습니다.** 필터·하이라이트·수신 이력 차이 같은 파생 뷰는
  뷰임을 표시하며 수신 사실처럼 보이지 않고 upstream으로 전송되지도 않습니다.

## Why

에이전트 시스템은 사람이 읽을 수 있는 것보다 많은 상태를 만들고, 사람이 판단하거나 개입해야
하는 순간이 가장 위험합니다. 대시보드는 한 백엔드의 의미를 UI에 굳혀 버리지만, Gunnflow는
의미를 백엔드에 두고 어떤 백엔드가 뒤에 있든 사람이 보고 판단하고 조종할 수 있는 정직한
단일 화면을 제공합니다.

## Status

**Alpha.** Gunnflow는 저장소 안의 simulator(`testing/fake-contracts`)와 reference direct-wire
server에 대해 end-to-end로 동작합니다. [`packages/contract/WIRE.md`](packages/contract/WIRE.md)를
구현하는 백엔드는 `direct` upstream으로 연결할 수 있습니다. 이 저장소 밖에서 유지되는 백엔드
adapter의 동작 여부는 여기서 검증할 수 없습니다. 계약 패키지 `@gunnflow/contract`는 현재
**0.3.2**로 버전 관리되며 minor 버전 사이에도 바뀔 수 있습니다. 아직 거친 부분이 있습니다.

## 30초 만에 시작하기

사전 요구사항: **Node.js 22 이상**(`engines.node >= 22`), **pnpm 10**
(`packageManager: pnpm@10.34.5`; `corepack enable`이 이를 사용합니다).

```sh
pnpm install
pnpm dev
```

Gunnflow는 소스에서 실행합니다. 워크스페이스 패키지(`@gunnflow/*`)는 `private`이며 npm에
배포되지 않습니다.

`pnpm dev`는 `127.0.0.1`에서 세 서버를 시작합니다([설정](#설정) 참고).

| 포트 | 역할 |
|---|---|
| 5173 | 웹 앱(SolidJS + Vite; `/api`를 BFF로 프록시) — 여기를 엽니다 |
| 8787 | BFF(전송만 담당: SSE fan-out + intent relay) |
| 8788 | 에이전트 산출물용 격리 preview origin(별도 origin, 엄격한 CSP) |

**Upstream 선택.** BFF는 선택적 config 파일 — `~/.gunnflow/config.json` 또는 저장소 루트의
git-ignore된 `gunnflow.config.json`(순서는 [설정](#설정) 참고) — 을 읽습니다. 환경 변수가 파일보다
우선합니다. 파일도 `GUNNFLOW_UPSTREAM`도 없으면 upstream은 저장소 안의
simulator인 `fake`입니다. 따라서 위 명령은 백엔드 없이 demo workspace를 보여 줍니다.

direct wire를 말하는 백엔드를 연결하려면
[`gunnflow.config.example.json`](gunnflow.config.example.json)을 `~/.gunnflow/config.json`으로
복사하고 백엔드 base URL을 채웁니다.

```json
{ "upstream": "direct", "url": "<backend base URL>" }
```

(자리표시자 자체는 URL이 아니라서 시작 시 거부됩니다 — 반드시 바꿉니다.) 자기 백엔드 없이 direct
경로를 시험하려면 저장소 안 reference server
(`pnpm --filter @gunnflow-testing/fake-contracts serve:direct`, `http://127.0.0.1:8791`)를 띄우고
그 주소를 URL로 씁니다. 또는 `GUNNFLOW_UPSTREAM=direct`와 `GUNNFLOW_UPSTREAM_URL=<backend base URL>`을 설정합니다.
`upstream`은 `fake` 또는 `direct`여야 합니다. URL 없는 `direct`는 시작을 거부하며 알 수 없는
키도 거부됩니다. 허용되는 다른 키는 `webOrigin`, `previewOrigin`, `wiringDir`, `personalDir`입니다.

workspace 어휘와 표시 환경설정은 `wiring/`에 JSON을 넣어 지정합니다. 내장 기본값 위에 파일명이
정렬된 순서로 병합됩니다([`wiring/README.md`](wiring/README.md) 참고). `wiring/`에는 기본으로
아무것도 싣지 않습니다(그 안의 `*.json`은 git-ignore되는 사용자 파일). 백엔드별 예시는
[examples/wiring/](examples/wiring/README.md)에 있습니다. wiring이 없어도 알 수 없는
어휘는 정직하게 렌더링됩니다: 중립 glyph와 원문, 기본 edge, 원문 label action button, ambient
attention, fallback viewer가 사용됩니다.

## 설정

설정은 선택적 config 파일(둘째 열의 키)과 환경 변수에서 옵니다. **환경 변수가 파일보다
우선합니다.**

**내 설정은 저장소 밖에 둡니다.** 연결 config, wiring, 개인 메모, 표시 환경설정처럼 사용자 자신의
것은 모두 사용자별 홈 디렉토리 — 기본 `~/.gunnflow`(`GUNNFLOW_HOME`으로 변경) — 에 둡니다. 코드
폴더보다 여기에 두기를 권합니다. 새로 clone해도 남고, 실수로 커밋될 일이 없습니다.

```text
~/.gunnflow/                    ($GUNNFLOW_HOME)
  config.json                   연결 config(gunnflow.config.example.json과 같은 키)
  wiring/                       내 wiring 파일(디렉토리가 있으면 사용)
  personal/                     개인 층: 로컬 메모, 상류로 전송 안 함
  prefs.json                    설정 화면이 쓰는 표시 환경설정
  boundary-names.local.json     pnpm boundary-lint가 추가로 검사할 이름(선택)
```

어떤 config 파일을 쓰는가(먼저 해당하는 것). BFF, 웹 dev server/build, `pnpm render-sweep`는 같은
코드(`scripts/gunnflow-settings.mjs`)로 파일을 찾고 검증합니다. 잘못된 파일은 무시되지 않고 이유와 함께
실행을 멈추며, BFF는 시작할 때 어떤 파일을 읽었는지 기록합니다:

1. `GUNNFLOW_CONFIG` — 명시 경로(파일이 없으면 시작을 거부)
2. 저장소 루트의 `gunnflow.config.json`(하위 호환)
3. `$GUNNFLOW_HOME/config.json`
4. 없음 — 내장 기본값, 즉 simulator

어떤 wiring 디렉토리를 쓰는가: 명시한 `GUNNFLOW_WIRING_DIR` 또는 config `wiringDir`(저장소 루트 기준
상대 경로) > 존재하면 `$GUNNFLOW_HOME/wiring` > 저장소의 `wiring/`. 디렉토리 안 파일은 전과 같이
이름 순으로 겹칩니다.

| 환경 변수 | config 키 | 의미 | 기본값 |
|---|---|---|---|
| `GUNNFLOW_HOME` | — | Gunnflow 홈 디렉토리(앞의 `~`는 확장) | `~/.gunnflow` |
| `GUNNFLOW_CONFIG` | — | config 파일 경로 | 위 순서 참고 |
| `GUNNFLOW_UPSTREAM` | `upstream` | `fake`(저장소 안 simulator) 또는 `direct`(direct wire를 말하는 백엔드) | `fake` |
| `GUNNFLOW_UPSTREAM_URL` | `url` | `direct`의 백엔드 base URL(`direct`이면 필수) | — |
| `GUNNFLOW_WIRING_DIR` | `wiringDir` | wiring 설정 디렉토리(저장소 루트 기준 상대 경로) | 있으면 `$GUNNFLOW_HOME/wiring`, 없으면 `wiring` |
| `GUNNFLOW_PERSONAL_DIR` | `personalDir` | 개인 층 디렉토리(로컬 메모, 상류로 전송 안 함) | `$GUNNFLOW_HOME/personal` |
| `GUNNFLOW_WEB_ORIGIN` | `webOrigin` | 웹 앱 origin — preview server가 cross-origin 읽기를 허락하는 유일한 origin | `http://127.0.0.1:5173` |
| `GUNNFLOW_PREVIEW_ORIGIN` | `previewOrigin` | 브라우저가 접근하는 격리 preview server origin(웹 빌드도 읽음; `GUNNFLOW_PREVIEW_PORT`가 없으면 이 origin의 포트로 listen) | `http://127.0.0.1:8788` |
| `VITE_PREVIEW_ORIGIN` | — | `GUNNFLOW_PREVIEW_ORIGIN`과 같되 웹 앱 전용(웹에서는 이것이 우선) | — |
| `GUNNFLOW_PREFS_FILE` | — | 설정 화면이 쓰는 표시 환경설정 파일 | `$GUNNFLOW_HOME/prefs.json` |
| `GUNNFLOW_BIND_HOST` | — | BFF·preview server·Vite dev server의 listen 주소 | `127.0.0.1` |
| `GUNNFLOW_BFF_PORT` | — | BFF 포트(웹 dev proxy도 따라감) | `8787` |
| `GUNNFLOW_PREVIEW_PORT` | — | preview server 포트 | preview origin의 포트, 없으면 `8788` |
| `GUNNFLOW_WEB_PORT` | — | Vite dev server 포트 | `5173` |
| `GUNNFLOW_SWEEP_URL` | — | `--url`이 없을 때 `pnpm render-sweep`가 쓸 wire URL | — |
| `FAKE_DIRECT_PORT` | — | 테스트/개발 전용: 저장소 안 direct-wire reference server 포트 | `8791` |
| `CI` | — | 테스트 전용: 설정되면 Playwright가 이미 실행 중인 서버를 재사용하지 않음 | 미설정 |
| `BOUNDARY_NAMES_FILE` | — | 테스트 전용: `pnpm boundary-lint`의 대체 이름 데이터 파일(설정되면 `$GUNNFLOW_HOME/boundary-names.local.json`은 병합 안 함) | `scripts/boundary-names.json` |

**Bind host.** 기본은 전부 loopback에서만 listen합니다. `GUNNFLOW_BIND_HOST`(예: 컨테이너 안에서
`0.0.0.0`)는 세 서버 모두의 listen 주소를 바꾸지만, BFF에는 인증이 없으므로 **인증 없는 BFF를
노출합니다**([SECURITY.md](SECURITY.md) 참고). 브라우저가 쓰는 origin은 bind host를 자동으로 따라가지
않습니다. 다른 호스트 이름으로 접속한다면 `GUNNFLOW_WEB_ORIGIN`과 `GUNNFLOW_PREVIEW_ORIGIN`(또는
`previewOrigin` / `VITE_PREVIEW_ORIGIN`)을 브라우저가 쓰는 주소로 지정합니다. preview origin은 웹 앱과
다른 origin이어야 합니다.

## 빌드와 테스트

```sh
pnpm verify        # boundary-lint + typecheck + unit tests (Vitest) + build — 통과해야 함
pnpm e2e           # Playwright 시나리오(처음에는 pnpm --filter @gunnflow/web exec playwright install chromium)
pnpm render-sweep  # wiring/과 live wire의 어휘를 대조 감사(아래 참고)
```

`pnpm e2e`는 simulator에 고정된 자체 서버를 시작합니다. in-process(`fake`) 경로와 로컬
direct-wire reference server 경로를 모두 사용하고 `GUNNFLOW_HOME`을 임시 디렉토리로 지정하므로, 로컬
설정이나 `~/.gunnflow`, 실제 백엔드에는 접근하지 않습니다.

`pnpm render-sweep --url <backend base URL>`는 live wire에서 `/nodes`를 가져와 wiring 파일로
매핑되지 않은 모든 상태, 관계, attention 원인, kind, artifact media type을 보고합니다(URL은
`GUNNFLOW_SWEEP_URL`, 또는 `direct`를 고른 config 파일(위 순서로 결정)의 `url`에서도 올 수 있고, 셋 다
없으면 종료 코드 3; `--wiring <dir>`로 wiring 디렉토리 지정, 없으면 위 순서로 결정). 종료 코드는 0(문제 없음),
1(누락), 2(wire 연결 불가), 3(설정 오류)입니다. contract build가 필요합니다:
`pnpm --filter @gunnflow/contract build`.

## Architecture

```
Browser (web :5173)
   │  SSE (state) · SSE (streams) · POST (intents)
   ▼
BFF (:8787) — 전송만 담당: 운반하고 압축하며 판단하지 않음
   │
   ▼
single wiring port (@gunnflow/upstream-port)
   │
   ├─ fake    → 저장소 안 simulator (testing/fake-contracts)
   └─ direct  → direct wire를 말하는 모든 백엔드(또는 자체 adapter/proxy)

격리 preview origin (:8788) — digest별 에이전트 산출물 제공, sandboxed iframe + 엄격한 CSP
```

```
apps/web                 SolidJS + Vite cockpit(canvas 렌더링, DOM chrome)
apps/bff                 Fastify BFF + 격리 preview server
packages/contract        @gunnflow/contract — 타입, runtime validator, digest 규칙,
                         conformance suite, wiring 설정 스키마
packages/upstream-port   BFF의 wiring port 타입
testing/fake-contracts   conformance를 통과하는 reference fake backend simulator
scripts/                 boundary-lint(레이어링 + core의 백엔드명 금지), render-sweep
wiring/                  사용자 wiring 설정 파일(데이터만; 기본 탑재 없음)
examples/wiring/         백엔드별 wiring 설정 예시
```

계약은 Gunnflow이 소유합니다. 백엔드는 **[packages/contract/WIRE.md](packages/contract/WIRE.md)**에
기술된 필수 HTTP surface인 `GET /nodes`, `GET /stream`(SSE), `POST /intent`를 제공해야 연결됩니다.
선택 surface는 `GET /artifact/:id/:digest`, `GET /detail/:nodeId`,
`GET /execution/:taskId`, `GET /execution/:taskId/stream`(SSE)입니다. 지원하지 않는 선택
surface는 `501`로 응답하며 *unsupported*로 표시되고, 빈 정상 응답으로 처리되지 않습니다.
백엔드는 conformance suite로 자체 점검할 수 있습니다([packages/contract/README.md](packages/contract/README.md)).

## Related projects

Gunnflow는 cockpit UI입니다. **Rhizome**과 **JANUS**는 설계 문서에서 역할이 언급된 별도
프로젝트입니다. Rhizome의 역할은 board/coordinator backend 작업이고, JANUS의 역할은 실행
격리와 governance입니다. Gunnflow core는 어느 쪽도 이름으로 알지 않습니다(`pnpm boundary-lint`가
강제).

## Design records

`docs/`에는 주로 한국어로 된 설계·결정 기록이 있으며, public 개발 과정의 일부로 공개되어
있습니다. 기여 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md), 아직 정해지지 않은 upstream 계약은
[BLOCKED.md](BLOCKED.md)를 참고하세요.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md)와 [SECURITY.md](SECURITY.md)를 참고하세요. 변경 이력은
[CHANGELOG.md](CHANGELOG.md)에 기록됩니다.

## License

Gunnflow는 [MIT 라이선스](LICENSE)로 배포됩니다.

