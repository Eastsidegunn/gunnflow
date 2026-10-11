# Direct wire — 계약을 네이티브로 말하는 백엔드의 HTTP 규약

어댑터 없이 Gunnflow에 붙으려는 백엔드는 아래 엔드포인트를 연다. Gunnflow BFF의
내장 `direct` 업스트림은 이 규약을 그대로 호출하고 **운반만** 한다(번역·합성·판단 없음).
경로와 이름은 `DIRECT_WIRE`(`@gunnflow/contract`)에 코드로도 고정되어 있다.
경로는 백엔드 base URL(예: `http://127.0.0.1:9000/gunnflow`) 기준이다.

| 메서드·경로 | 필수 | 요청 | 응답 |
|---|---|---|---|
| `GET /nodes` | 필수 | — | `200 application/json` `DirectSnapshot` |
| `GET /stream` | 필수 | `Accept: text/event-stream` | `200 text/event-stream`, `snapshot` 이벤트 |
| `POST /intent` | 필수 | `application/json` `Intent`, 헤더 `x-gunnflow-actor` | `200 application/json` `IntentResult` |
| `GET /artifact/:id/:digest` | 선택 | — | `200` bytes (`Content-Type` = media type) / `404` |
| `GET /detail/:nodeId` | 선택 | — | `200 application/json` `NodeDetail` / `404` / `501` |
| `GET /execution/:taskId` | 선택 | — | `200 application/json` `ExecutionSnapshot` / `404` / `501` |
| `GET /execution/:taskId/stream` | 선택 | `Accept: text/event-stream` | `200 text/event-stream`, `snapshot` 이벤트 / `404` / `501` |
| `GET /terminals` | 선택(묶음) | — | `200 application/json` `DirectTerminal[]` / `404`·`501` = 미제공 |
| `POST /terminals` | 선택(묶음) | `application/json` `DirectTerminalOpen` | `200` `{ terminalId }` / `422` `{ reason }` / `404`·`501` = 미제공 |
| `GET /terminals/:id/stream` | 선택(묶음) | `Accept: text/event-stream` | `200 text/event-stream`, `snapshot`·`data`·`exit` / `404` / `501` |
| `POST /terminals/:id/input` | 선택(묶음) | `application/json` `{ data: base64 }` | `204` / `404` / `409` / `501` |
| `POST /terminals/:id/resize` | 선택(묶음) | `application/json` `{ cols, rows }` | `204` / `404` / `409` / `501` |
| `DELETE /terminals/:id` | 선택(묶음) | — | `204` / `404` / `409` / `501` |

```ts
interface DirectSnapshot { revision: number; nodes: NodeProjection[] }   // 계약 타입 그대로
interface IntentResult   { accepted: boolean; reason?: string }
interface NodeDetail     { revision: number; items: DetailItem[] }       // DetailItem = { label; text | artifact }
interface ExecutionSnapshot { sessions: ExecutionSession[]; events: ExecutionEvent[]; truncatedBefore?: number }  // 계약 타입 그대로
```

## GET /nodes

현재 전체 스냅샷. `revision`은 백엔드가 매기는 비감소 정수. `nodes`의 각 원소는
`nodeProblem`을 통과해야 한다(통과 못 한 노드는 cockpit이 표시하지 않고 사유를 남긴다).
이 엔드포인트가 200을 주지 않으면 BFF는 기동을 거부한다.

노드는 선택 장식 필드(0.6.0)를 실을 수 있다 — 모두 백엔드가 진술한 사실이다:
`shortName`(원거리 이름, 1–32 코드포인트, 줄바꿈 없음), `summary`(한 줄 요약, 1–200 코드포인트,
줄바꿈 없음, label과 같은 지위의 평문 — 줄바꿈 = LF·VT·FF·CR·NEL·U+2028·U+2029), `active`(지금 활성; 부재 = 모름이지 false가 아님),
`lastActivityTs`(ms epoch, 양의 정수), `changedAtRevision`(이 노드 자신의 projection이 마지막으로
바뀐 revision, 1 이상 정수 — 컨테이너로 집계하지 않는다), `originNodeId`(이 노드가 비롯된 노드,
자기 id 불가, 엣지를 그리지 않고 스냅샷에 없는 노드를 가리켜도 된다), `steps`(`{ done, total }`
정수, 0 ≤ done ≤ total, total ≥ 1, 표시 전용 — 엔진은 진행률을 계산하지 않는다).
스냅샷 규칙: `changedAtRevision` ≤ 그 스냅샷의 `revision`(`snapshotNodeProblem`/`snapshotProblem`).
어긴 노드만 표시되지 않고 사유가 남는다 — 스냅샷 전체는 유지된다. 필드가 없으면 그 장식만 생략될
뿐이다. 0.5 소비자는 이 키를 가진 노드를 거부하므로(미지 키 엄격) 0.5 cockpit에는 보내지 않는다.

## GET /stream (SSE)

- 표준 SSE 프레이밍(HTML 표준): LF·CRLF·CR 줄끝, 빈 줄로 이벤트 종료, 여러 `data:` 줄은 LF로 결합,
  콜론 뒤 공백 하나 제거, `:`로 시작하는 주석 줄(keepalive)은 무시.
- 이벤트 이름 `snapshot`, `data`는 `DirectSnapshot` JSON **전체**. 델타는 없다 — 변경이 생기면
  새 스냅샷을 재발행한다. 같은 스냅샷의 재발행도 허용.
- 연결 직후 첫 이벤트는 현재 스냅샷이어야 한다. 끊기면 BFF가 재접속하고, 그 첫 스냅샷이 재동기화다.
- 다른 이벤트 이름은 무시된다. `404`/`501`이면 BFF는 실시간 갱신 없이 최초 스냅샷만 보인다.

## POST /intent

- 본문은 계약 `Intent` 그대로(`nodeId`, `action`, 선택 슬롯 `decision`/`edit`/`attestation`,
  `idempotencyKey`). 그 밖의 키는 없다 — 백엔드는 `validateIntent`로 검사하고 거부해야 한다.
- 행위자(사람)는 헤더 `x-gunnflow-actor`로 온다. Intent 본문에는 provenance가 없다.
- 결정 결과는 항상 `200` + `IntentResult`. 거부는 `{ accepted: false, reason }` — `reason`은
  사람에게 그대로 보인다.
- 적용된 결과는 응답이 아니라 이후 `stream` 스냅샷으로 나타나야 한다(권위는 projection).
- 2xx가 아닌 응답은 전송 오류로 취급한다: 본문 텍스트(JSON이면 `reason`)가 사유로 그대로
  표시되고 intent는 거부로 끝난다.

## GET /artifact/:id/:digest (선택)

- `digest`는 sha256 hex. 그 digest의 bytes를 보유하면 `200` + bytes, `Content-Type`은 media type.
  보유하지 않으면 `404`. "현재 버전" 개념은 없다 — 주소가 곧 버전이다.
- BFF의 격리 origin이 bytes를 다시 해시해 digest와 대조한다. 제공하지 않으면(모든 요청 404)
  산출물 뷰어만 비활성이고 나머지는 동작한다.
- projection의 `access: { kind: 'live', url }`은 http(s) URL이어야 하며 userinfo 자격증명(`user:pass@`)을 담으면 안 된다 — 담긴 노드는 `nodeProblem`이 거부한다.

## GET /detail/:nodeId (선택)

- "얇은 리스트 + 선택 시 on-demand fetch": 사람이 노드를 열었을 때만 호출되는
  상세 표면이다. 응답은 `NodeDetail` — `revision`은 이 detail이 어느 projection
  세대에 묶이는지를 말하고, `items`의 각 원소는 `label`(백엔드 어휘 그대로,
  cockpit은 해석하지 않음)과 본문 **정확히 하나**(`text` 평문 또는 `artifact`
  참조, projection의 `ArtifactRef` 제약 동일)를 가진다. 구조는
  `validateNodeDetail`이 검사한다(BFF는 통과 못 한 응답을 502로 끊는다).
- 그 노드의 detail을 보유하지 않으면(없는 노드 포함) `404`. 이 wire가 detail
  표면 자체를 제공하지 않으면 `501` — Gunnflow는 섹션을 빈 정상 응답처럼이
  아니라 **미지원으로 명시**해 보인다(불변식 2). 제공하지 않아도 나머지 wire는
  전부 동작한다.

## GET /execution/:taskId (선택)

- 한 task의 실행 텔레메트리 스냅샷: `sessions`(세션 레코드)와 `events`(append-only
  사건 목록, `seq` 엄격 증가, 각 사건의 `sessionId`는 `sessions`의 id를 가리켜야
  한다). 모든 필드는 **상류가 쓴 사실 그대로**다 — `kind`는
  열린 상류 어휘(예: `subagent/spawn`, `session/end`), `label`은 상류의 요약,
  `status`·`upstreamSessionState`는 상류 어휘 그대로이며 cockpit은 해석하지 않고
  표시만 한다. payload 필드는 없다. 구조는 `validateExecutionSnapshot`이 검사한다
  (BFF는 통과 못 한 응답을 502로 끊는다).
- **크기 한도** (`EXECUTION_MAX_*`): sessions ≤ 256, events ≤ 10000,
  label ≤ 512자, kind ≤ 128자, status·upstreamSessionState ≤ 64자. 한도를 넘는
  스냅샷은 계약 위반이다.
- **`events`는 최근 창(window)이어도 된다** — 보존 범위는 백엔드의 선택이고, 창
  안에서 `seq`는 엄격 증가를 유지한다. 창 앞을 잘랐으면 선택 필드
  `truncatedBefore`(양의 정수 seq)로 밝힌다: "`seq < truncatedBefore`인 사건이
  상류에 존재하지만 이 스냅샷에는 실리지 않았다". 값은 실린 첫 사건의 seq 이하여야
  한다. cockpit은 이 값이 있으면 타임라인에 창 앞이 잘렸음을 한 줄로 표시한다 —
  wire가 세지 않은 것을 세어 보여주지 않는다.
- 그 task의 execution을 보유하지 않으면(없는 task 포함) `404`. 이 wire가 execution
  표면 자체를 제공하지 않으면 `501` — Gunnflow는 빈 정상 응답이 아니라 **미지원으로
  명시**해 보인다(불변식 2). 제공하지 않아도 나머지 wire는 전부 동작한다.

## GET /execution/:taskId/stream (선택, SSE)

- `Accept: text/event-stream`. 이벤트 이름은 `snapshot`, `data`는 `ExecutionSnapshot`
  JSON **전체**. 델타는 없다 — 변경이 생기면 새 스냅샷을 재발행한다(`/stream`과 같은
  재발행 문법; 같은 스냅샷의 재발행도 허용).
- 연결 직후 첫 이벤트는 현재 스냅샷이어야 한다. 끊기면 BFF가 재접속하고, 그 첫
  스냅샷이 재동기화다.
- 각 `snapshot` 프레임은 `GET /execution/:taskId`와 같은 구조·한도
  (`EXECUTION_MAX_*`, 창 허용과 `truncatedBefore` 포함)를 지켜야 한다.
- `404`/`501` 규칙은 `GET /execution/:taskId`와 동일하다.

## 터미널 (선택, 여섯 경로가 한 묶음)

백엔드가 **이미 돌리는** 대화형 터미널을 cockpit 패널로 잇는 표면이다. 백엔드와 BFF 모두
바이트를 해석하지 않는다 — bytes는 표준 base64(패딩 포함, 줄바꿈 없음, `isWireBase64`)로만
오가고, BFF는 받은 base64 문자열을 디코딩·재인코딩 없이 그대로 나른다.

```ts
interface DirectTerminal {
  terminalId: string;                 // 비어 있지 않음, 경로에는 encodeURIComponent로
  label: string;                      // 백엔드 어휘 그대로
  kind: 'attachable' | 'shell';       // attachable = 이미 돌고 있어 합류 가능, shell = 요청으로 연 것
  state: 'running' | 'exited';
  nodeId?: string;                    // 스냅샷의 노드에 묶임
}
interface DirectTerminalOpen {
  target: { attach: string } | { shell: { cwd: string } };
  cols: number; rows: number;         // 정수 1..1000 (TERMINAL_SIZE_MAX)
}
```

- **미제공**: `GET /terminals`·`POST /terminals`가 `404`/`501`이면, 또는 어느 터미널 경로든
  `501`이면 그 기능은 미제공이다. BFF는 매 호출마다 묻고(래치 없음 — 재기동한 백엔드가
  터미널을 새로 제공하면 바로 보인다) cockpit에 `501`로 **명시**한다. 나머지 wire는 그대로 동작한다.
- `GET /terminals` → 배열. 원소는 `directTerminalProblem`을 통과해야 한다(미지 키 거부).
  통과 못 하면 BFF는 `502` + 사유로 끊는다.
- `POST /terminals` → `200 { terminalId }`. 열기를 거절하면(없는 attach id, 끝난 터미널,
  허용하지 않는 폴더 등) `422 { reason }` — `reason`은 사람에게 그대로 보인다.
- `GET /terminals/:id/stream` (SSE, `/stream`과 같은 프레이밍):
  - `event: snapshot` — `data:`는 백엔드가 보존한 출력 전체의 base64(비었으면 빈 `data:`).
    **연결마다 첫 프레임**이다. 재접속한 뷰어는 화면을 이것으로 다시 시작한다.
  - `event: data` — `data:`는 새 출력 조각의 base64 그대로(JSON 아님).
  - `event: exit` — `data:`는 JSON `{ "code": 정수 | null }`. 마지막 프레임이고, 백엔드는 이어서
    연결을 닫는다. 이미 끝난 터미널에 붙으면 `snapshot` 다음 바로 `exit`.
  - 다른 이벤트 이름은 무시된다. 형식이 깨진 프레임은 그 연결을 끊게 하고, 재접속의 `snapshot`이 재동기화다.
  - 없는 터미널은 `404`. 연결은 뷰어마다 하나다(BFF는 팬아웃하지 않는다).
- `POST /terminals/:id/input` `{ data }`, `POST /terminals/:id/resize` `{ cols, rows }`,
  `DELETE /terminals/:id` → `204`. 없는 터미널 `404`, 끝나서 입력을 받지 않으면 `409`.
  `DELETE`는 백엔드가 그 터미널을 끝내게 한다(열린 stream에는 `exit`).
- **BFF 쪽 운반 규칙**: stream이 `exit` 없이 끊기면 BFF가 재접속하고, 새 연결의 첫 `snapshot`을
  뷰어에게 그대로 넘긴다(화면 재시작). 재접속이 `404`면 터미널이 사라진 것 — BFF는 뷰어 연결을
  `exit` 프레임 **없이** 닫는다(사라졌다는 사실을 끝남으로 꾸미지 않는다). 백프레셔: 뷰어가 1 MiB 넘게
  못 받아가면 BFF가 그 뷰어 연결을 끊고, 뷰어는 재접속해 `snapshot`부터 다시 그린다 — 느린 화면은
  다시 그리기로 끝나고 BFF 메모리는 한정된다.
- 조종(열기·입력·크기·닫기)은 cockpit 쪽에서 이 기기(loopback)에서만 받는다. 백엔드는 자기 인증을 따로 가져도 된다.

## Gunnflow 쪽 연결

`gunnflow.config.json`(Gunnflow 레포 루트, 선택):

```json
{ "upstream": "direct", "url": "http://127.0.0.1:9000/gunnflow" }
```

`GUNNFLOW_UPSTREAM`·`GUNNFLOW_UPSTREAM_URL` 등 env가 있으면 env가 우선한다.
규약의 참조 서버는 시뮬레이터(`@gunnflow-testing/fake-contracts`의 direct 서버 모드)다.
