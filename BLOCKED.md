# BLOCKED(contract)

아래 항목은 상류 계약이 확정될 때까지 **절대 임의 구현하지 않는다.**
Fake/Null 구현(`testing/fake-contracts`)으로만 UI를 개발하며, Fake는
production dependency graph에서 제거 가능해야 한다.

## 1. Deliverable declaration event

산출물을 fsdiff와 분리하는 상류 이벤트. Deliverable node / Preview binding /
Publish provenance에 영향. → `FakeDeliverableProjection`만 사용.

## 2. Execution telemetry reconciliation — **부분 해소**

execution 표면 v1로 task↔session 관계·session state는 상류 데이터로 소비할 수 있다
(/v1/execution/{taskId}). 이벤트 detail·PTY·runtime context는 여전히 BLOCKED —
상류 계약(실행 텔레메트리의 이벤트 상세·터미널·런타임 컨텍스트 형식)이 정의될 때까지 대기.

## 3. Upstream SSE / POST API surface — **해소됨**

연결 방식은 직결 wire 하나: 백엔드가 `packages/contract/WIRE.md`의 엔드포인트 4개
(/nodes, /stream, /intent, /artifact/:id/:digest)를 열면, Gunnflow 쪽은
`gunnflow.config.json`의 `{ "upstream": "direct", "url": … }` 한 줄로 연결한다
(`gunnflow.config.example.json` 참고). 빈자리(백엔드가 제공하지 않는 정보)는
fallback으로 정직 표시된다. fake 모드는 e2e/데모용으로 유지.

## 4. OIDC IdP (auth)

실 actor 부착(누가 개입했는지의 audit identity)에 영향. 현재 fake actor 고정.

---

해제 시 작업 순서: fake-contracts 교체 → 상류 어댑터 연결 → 실 actor 부착.
