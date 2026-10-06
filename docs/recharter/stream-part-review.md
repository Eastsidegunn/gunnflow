
# Stream 부품 입장 심사

> 이 문서는 stream 부품 도입 시점의 입장 심사 기록이다. 인용한 함수·상수 이름(`applyPty`, `PTY_WINDOW` 등)은
> 심사 당시 원형 기준이며 현행 코드와 다를 수 있다. 결론(§ 마지막 문단)과 계약 규칙이 이 문서의 정본 부분이다.

심사 대상은 `apps/web/src/ui/LiveTerminalSurface.tsx`의 PTY 출력과 `apps/web/src/ui/ExecutionSurface.tsx`의 실행 이벤트처럼, 시간 순서대로 고빈도 append 데이터가 도착하는 경우다. 현재 원형은 이미 일반 projection 반복 갱신과 별도의 append 이벤트를 구분한다.

- PTY: `testing/fake-contracts/src/terminal.ts`의 `FakePtyStream.appendOutput()` 및 `FakeTerminalDelta.type = 'pty'`
- 실행 이벤트: `testing/fake-contracts/src/execution.ts`의 `FakeExecutionEventStream.appendEvents()` 및 `FakeExecutionDelta.type = 'events'`
- 브라우저 수신: `apps/web/src/state/terminalStore.ts`의 `applyPty()`, `apps/web/src/state/executionStore.ts`의 `applyEvents()`
- 화면 표시: `apps/web/src/ui/LiveTerminalSurface.tsx`, `apps/web/src/ui/ExecutionSurface.tsx`

## 1. 기존 요소로 표현 가능한가

결론부터 말하면, 기존 `NodeProjection` 반복 emit과 `ArtifactRef`만으로 고빈도 append 데이터를 표현하면 실패한다. 실패 지점은 다음과 같다.

### 1.1 NodeProjection 반복 emit의 전송량

기존 계약에서 노드 상태가 변경될 때마다 `NodeProjection` 전체를 다시 보낸다고 가정하면, append 하나가 추가될 때마다 다음 정보가 반복된다.

- `id`, `kind`, `state`
- 전체 `relations`
- 전체 `capabilities`
- 전체 `attention`
- 전체 `artifacts`
- 이미 전송된 과거 append 데이터

append 데이터가 `N`건이고 각 append가 평균 `B`바이트라면, 매번 전체 누적 내용을 projection에 넣을 경우 전송량은 대략 `B × (1 + 2 + ... + N)`, 즉 `O(N²)`가 된다. 노드 메타데이터까지 반복되므로 실제 비용은 이보다 크다.

`apps/web/src/state/terminalStore.ts`와 `apps/web/src/state/executionStore.ts`가 append 수신을 별도 함수로 둔 것은 이 문제를 피하기 위한 구조다. `applyPty(batch)`와 `applyEvents(batch)`는 새 항목만 받으며, 전체 세션 또는 전체 실행 projection을 매번 재전송하지 않는다.

### 1.2 append 의미론이 기존 계약에 없다

기존 `NodeProjection`은 현재 상태를 나타낸다. 다음 의미를 표현하는 필드가 없다.

- 단조 증가하는 append 순번
- 수신자가 마지막으로 확인한 순번
- 중간 순번의 유실 여부
- 동일 append의 재전송과 중복 제거
- append를 어느 시점부터 재개할지
- 한 append가 여러 chunk로 분할되었는지
- 순서가 보장되지 않은 도착을 어떻게 처리할지

`ArtifactRef`도 산출물의 참조이지 append 로그의 전송 단위가 아니다. `ArtifactRef`만으로는 “seq 101 이후 seq 102~110이 수신되지 않았다”를 표현할 수 없다.

### 1.3 스냅샷 재발행 비용

append마다 새 스냅샷 `ArtifactRef`를 발행하는 방식은 다음 비용을 발생시킨다.

- 새 artifact ID와 digest 생성
- 스냅샷 저장 및 보존
- 기존 viewer에 대한 재로드 또는 문서 교체
- 스냅샷 간 순서와 누락을 별도 메타데이터로 관리
- 현재 화면이 어느 스냅샷을 표시했는지 추적

고빈도 출력에서는 스냅샷 수가 append 빈도와 동일해진다. 전체 스냅샷을 재발행하면 누적 데이터가 매번 복제되고, delta 스냅샷을 만들면 그 delta의 순서·유실·재연결 의미를 별도 계약으로 다시 정의해야 한다. 후자의 경우 결국 stream 계약이 필요하다.

append tail 모델이 필요한 근거는 요구사항 자체다: 유실 표시, 마지막 확인 지점부터의 재개,
보관 한도의 정직한 표시는 append 단위와 순번이 계약에 있어야 성립한다. (현행 fake 구현 —
`terminalStore.ts`의 `PTY_WINDOW = 5000`과 `truncated`, `executionStore.ts`의 `EVENT_WINDOW` —
이 tail 모델로 짜여 있다는 사실은 참고 사례이지 필요성의 근거가 아니다.)

### 1.4 viewer가 부적합한 이유

viewer는 완료된 산출물을 표시하는 부품이다. `ArtifactRef`의 snapshot을 열 때 적합한 동작은 다음과 같다.

1. 특정 artifact를 명시적으로 연다.
2. 해당 시점의 bytes를 표시한다.
3. digest를 기준으로 내용의 동일성을 확인한다.
4. 필요하면 다른 snapshot으로 교체한다.

고빈도 append에는 다음 요구가 있다.

- 새 chunk의 즉시 추가
- 순번 연속성 검사
- 유실 구간 표시
- 현재 위치를 유지한 채 뒤에 데이터 추가
- 재연결 시 마지막 확인 순번부터 재개
- 화면 렌더링 속도가 수신 속도보다 느릴 때 bounded retention

viewer에 snapshot을 계속 공급하면 매 append마다 문서 전체를 교체하게 된다. 이는 append 의미론, 유실 검사, 스크롤 위치 유지, 재개 위치를 제공하지 않는다. `LiveTerminalSurface.tsx`의 virtualization과 “new lines” 표시도 일반 viewer가 아니라 append tail을 전제로 한다.

### 1.5 `access: live` 포털이 부적합한 이유

`access: live`는 원격 픽셀을 직접 연결하는 포털이다. 브리프의 정의상 다음 특성을 가진다.

- projection은 포털의 존재와 URL만 선언한다.
- 픽셀은 별도 origin에서 직접 수신한다.
- 자동 로드는 금지된다.
- 내용은 조종석이 통제한 bytes라는 보장을 갖지 않는다.
- attestation이 불가능하다.

스트림은 픽셀이 아니라 순서 있는 데이터 append다. 최소한 다음 사실이 필요하다.

- `streamId`
- append의 `seq`
- append bytes 또는 명시된 encoding
- 수신 유실 여부
- 재연결 기준
- 서버가 적용한 드롭 또는 압축 정책

이를 포털 iframe의 픽셀로 바꾸면 브라우저는 텍스트·chunk·순번을 알 수 없다. 검색, 유실 수치, 수신 이력 diff, bounded retention, 화면상의 “N줄 유실”을 구현할 수 없다. iframe 내부에 터미널을 그리더라도 이는 에이전트가 만든 주장 픽셀일 뿐이며, Gunnflow의 stream 부품이 수신한 append 데이터가 아니다.

따라서 데이터가 동일한 BFF 배선 포트를 지나간다는 사실만으로 포털과 stream이 같은 부품이 되지는 않는다. 포털은 “원격 픽셀 연결”이고 stream은 “순서 있는 데이터 전송”이다.

## 2. 포털과의 구분에 대한 판정

포털만으로는 충분하지 않다. 권고는 다음과 같다.

- `access: live`는 원격 UI 또는 원격 렌더링 픽셀에만 사용한다.
- 고빈도 출력과 텔레메트리는 stream 계약으로 선언한다.
- stream 화면에 iframe을 사용하더라도, iframe은 렌더러일 뿐 stream 계약을 대체하지 않는다.
- stream의 원문 bytes와 순번은 Gunnflow가 수신한다. 표시는 등급을 나눈다: seq·gap·연결 상태
  등 조종석이 계산한 계기는 보증, chunk 본문은 주장 등급(§3.4 화면 등급 분리).
- 원격 live UI를 그대로 보여주는 경우에만 포털 등급을 사용하며, 그 화면은 stream 부품으로 분류하지 않는다.

## 3. Stream 부품 spec

### 3.1 계약 접합면 후보 비교

#### 후보 (i): `ArtifactRef.access`에 새 access kind 추가

예시:

```ts
interface ArtifactRef {
  id: string
  mediaType: string
  digest?: string
  access:
    | { kind: 'snapshot' }
    | { kind: 'live'; url: string }
    | { kind: 'stream'; url: string; streamId: string }
}
```

장점:

- 기존 artifact 연결 구조를 재사용할 수 있다.
- adapter가 선언하는 위치가 명확하다.

단점:

- append seq, 재연결 cursor, 유실 정책을 `ArtifactRef`에 추가해야 한다.
- 산출물 snapshot과 시간축 데이터 stream의 수명·보존 모델이 다르다.
  (이 둘이 기각의 주 근거다. digest 기대 전이는 부차적이다 — `ArtifactRef`에는 이미
  digest 없는 `live`가 존재하므로 그 논거만으로는 기각되지 않는다.)

계약 변경량은 `ArtifactRef.access` union, validator, adapter, 렌더러 및 conformance 테스트 변경이다.

#### 후보 (ii): workspace projection SSE에 append 이벤트 타입 추가

예시:

```ts
type WorkspaceEvent =
  | { type: 'snapshot'; projection: NodeProjection }
  | { type: 'projection'; projection: NodeProjection }
  | { type: 'stream.append'; streamId: string; ... }
```

장점:

- 기존 SSE 연결을 재사용한다.
- projection과 stream 선언을 하나의 연결에서 전달할 수 있다.

단점:

- 고빈도 데이터가 graph projection 채널과 동일한 연결 및 버퍼를 공유한다.
- stream 폭주가 노드 상태 갱신과 attention 전달을 지연시킬 수 있다.
- 한 연결 안에서 projection cursor와 stream cursor 두 개를 섞어 관리해야 한다.
- 서버·BFF·브라우저의 backpressure 정책이 서로 다른 두 데이터 종류에 결합된다.
- projection 채널의 순서 보장 범위가 stream까지 확장되어야 한다.

계약 변경량은 SSE event union, 공통 cursor 및 재연결 규칙, BFF 라우터, validator, conformance 테스트 변경이다.

#### 후보 (iii): 별도 stream 채널(BFF 경유)

projection은 stream의 선언만 보낸다. 실제 append는 별도 BFF endpoint에서 수신한다.

권고 선언 예시:

```ts
interface StreamRef {
  id: string
  role?: string                       // 불투명 문자열. 조립 config가 stream을 고르는 테이블 키
  mediaType: string
  sequence: 'contiguous'              // seq가 1씩 증가함을 상류가 보장. 이 선언 없는 stream에는 gap 계산을 적용하지 않는다
  encoding: 'utf-8' | 'base64'
  framing: 'line' | 'chunk'           // 'record'(구조화 레코드)는 예약 — 후속 심사(§5 결정 지점 2)
}
```

`StreamRef`에 url을 두지 않는다. 상류가 자기 URL을 선언하고 브라우저가 직접 접속하면 단일
wiring 포트(BFF 경유) 불변식을 어긴다. 브라우저의 접속 경로는 BFF 규칙 경로
`/api/stream/{nodeId}/{streamId}`로 고정하고, 상류 주소는 BFF-어댑터 사이에만 존재한다.

`NodeProjection`에는 다음 선택적 필드를 추가한다.

```ts
interface NodeProjection {
  // 기존 필드
  streams?: StreamRef[]
}
```

장점:

- graph projection의 낮은 빈도 상태와 고빈도 append를 분리한다.
- stream별 재연결 cursor와 backpressure를 독립적으로 정의할 수 있다.
- BFF는 세션 인증만 통과시키고 원문 데이터를 운반한다. 어느 stream에 접근 가능한지는 상류가
  판정하며 거부 응답은 그대로 전달된다(BFF는 정책 판단을 만들지 않는다).
- stream 폭주가 projection 채널의 버퍼를 잠식하지 않는다(연결 수 제약은 §3.5의 HTTP/2 전제와
  workspace SSE 우선 규칙으로 관리).
- viewer/portal과 달리 Gunnflow가 seq와 유실을 검증할 수 있다.

단점:

- projection에 `streams` 선언을 추가해야 한다.
- BFF에 별도 endpoint와 연결 수명 관리가 필요하다.
- stream 부품과 transport의 conformance 테스트가 추가된다.

계약 변경량은 `NodeProjection.streams`, `StreamRef`, stream event envelope, BFF endpoint, validator, conformance 테스트다. 이는 기존 필드의 의미를 바꾸지 않는 additive 변경이다.

### 3.2 채택 권고

후보 (iii), 별도 stream 채널(BFF 경유)을 채택한다.

stream은 `ArtifactRef`가 아니며, graph projection SSE와 같은 채널에서 높은 빈도로 전송하면 서로 다른 수명과 backpressure 정책이 결합된다. 별도 채널을 사용하되 projection에 `StreamRef`를 선언하여, 스트림 존재·mediaType·접속 URL·encoding·framing만 upstream이 결정하도록 한다.

권고 wire 형태는 다음과 같다.

```ts
interface StreamResync {                // 재연결·최초 접속 시 보관 tail의 초기 묶음.
  type: 'resync'                        // ArtifactRef의 'snapshot'(내용 고정 산출물)과 다른 개념이므로 단어를 나눈다
  streamId: string
  chunks: StreamChunk[]
}

interface StreamAppend {
  type: 'append'
  streamId: string
  chunks: StreamChunk[]                 // 범위는 chunks의 seq가 유일한 원천 (별도 first/last 필드 없음 — 불일치 가능성 제거)
}

interface StreamGap {
  type: 'gap'
  streamId: string
  fromSeq: number
  toSeq: number
  reason: string                        // 상류가 제공한 원문
  origin: 'upstream'                    // gap 선언은 상류 전용. BFF는 gap을 만들지 않는다(운반만)
}

interface StreamChunk {
  seq: number
  at: string
  channel?: string                      // 불투명 문자열(예: 상류가 stdout/stderr를 구분해 보낼 때). 표시는 config 키 매핑, 미등록 값은 원문
  data: string
}
```

- `seq`는 stream별 연속 증가 정수다(`sequence: 'contiguous'` 선언과 일치).
- `at`은 upstream이 보낸 시간 값이며, Gunnflow가 의미를 계산하지 않는다.
- `data`의 해석은 `StreamRef.encoding`과 `StreamRef.framing`을 따른다.
- `reason`은 유실 사유를 upstream이 제공한 원문으로 표시한다.
- client는 마지막으로 적용한 seq를 재연결 시 SSE `Last-Event-ID` 헤더로 보낸다. 상류가 그
  지점부터 재개하지 못하면 `resync` 묶음이 오고, 그 경계는 "재동기화됨 — 이전 표시 구간과의
  연속성 없음"으로 표시한다(gap 수치를 지어내지 않는다).
- client는 누락된 seq를 임의로 채우지 않는다.

### 3.3 닫힌 소형 param 레코드

부품 param은 다음과 같이 제한한다. (초안의 param에서 대폭 축소 — 사유는 각 항목에.)

```ts
interface StreamPartParams {
  source: { role: string }   // 이 노드 projection의 streams[] 중 role이 일치하는 것에 바인딩. config에 들어가는 것은 테이블 키뿐
  retainItems: number        // 로컬 보관 한도 (엔진이 하한·상한으로 clamp)
  retainBytes: number        // 로컬 보관 한도 (동일). Capability.edit.maxBytes(백엔드의 전송 한도)와 다른 값이므로 이름을 구분
}
```

각 필드는 고정된 키 또는 수치다. 표현식·조건부·핸들러·onClick·템플릿 문자열을 허용하지 않는다.

초안 param에서 제거한 필드와 사유:
- `streamId` — 런타임 인스턴스 값이라 kind별 정적 config에 들어갈 수 없다. `source.role`
  바인딩으로 대체(viewer가 `artifacts[...]`에 바인딩하는 방식과 동형).
- `encoding`, `framing` — `StreamRef`(백엔드 선언)에 이미 있는 값의 중복 선언. 해석 방식은
  데이터를 낸 쪽이 선언한다. param은 표시·보관 값만 갖는다(editor 부품과 같은 원칙).
- `retain: 'tail'`, `dropPolicy: 'oldest'`, `input: 'none'`, `attestation: 'none'` — 값이
  하나뿐인 리터럴은 설정이 아니라 불변식이다. param 자리에 두면 나중에 union을 넓혀 config로
  input이나 attestation을 켤 수 있는 자리가 생긴다. §3.4 내장 불변식으로 옮기고 conformance
  테스트로 강제한다.

표시 문자열, 색상, 강조 조건, 위험도 판단을 param에 넣지 않는다. 미등록 mediaType은 기본 텍스트 또는 bytes fallback으로 표시하며, stream 계약이 선언한 encoding/framing 외의 의미를 추론하지 않는다.

### 3.4 내장 불변식

param에서 옮겨온 고정 성질: 보관은 tail 방식(최신 구간만), 한도 초과 시 오래된 항목부터 제거,
표시 전용(입력 없음), attestation 생성 없음. 전부 엔진 코드의 성질이며 config로 바꿀 수 없다.

#### 화면 등급 분리 (본문은 주장, 계기는 보증)

stream 본문(chunk data)은 에이전트·실행 환경이 만든 데이터다. 조종석이 렌더하더라도 내용은
주장이다. 부품 안에서 등급을 나눈다.
- **보증 영역**: seq·gap·drop 표시, 연결 상태, 재동기화 경계 — 조종석이 스스로 계산한 사실.
- **주장 영역**: chunk 본문. 테두리 토큰으로 보증 영역과 시각 구분한다. 에이전트가 본문 안에
  계기판을 흉내 낸 문자열을 출력해도 등급 표시가 위조를 막는다.
- **결정 지점(ANSI escape)**: 본문의 escape sequence 처리. 권고 — 기본은 비해석(원문 그대로),
  SGR 색상만 해석하는 옵션은 엔진 릴리스로 추가(커서 이동·화면 제어는 항상 제거). config에
  해석 규칙을 두지 않는다.

#### 유실 표시

수신된 seq가 연속되지 않으면(계약 `sequence: 'contiguous'` 전제) 부품은 누락 구간을 계산하여
표시한다. `contiguous` 선언이 없는 stream에는 gap 계산을 적용하지 않는다 — 단조 증가만 보장되는
seq(1, 5, 9, …)에서 gap을 계산하면 조종석이 "누락 3건"이라는 거짓 사실을 그리게 된다.

예:

```text
STREAM GAP: 1201–1248 (48 chunks missing)
```

또는 upstream이 `StreamGap`을 보낸 경우 그 이벤트를 원문으로 표시한다.

- 누락된 데이터는 생성하거나 반복하지 않는다.
- “N줄 유실”에서 `N`은 seq 범위 또는 upstream이 보낸 count에서만 계산한다.
- 데이터가 line framing이 아니면 “N chunks missing”으로 표시하고 “줄”로 바꾸지 않는다.
- 연결이 끊긴 상태에서는 마지막 확인 seq와 마지막 수신 시각을 표시한다.

#### 표시 전용

stream 부품에는 입력 기능을 넣지 않는다.

PTY 입력은 `apps/web/src/state/terminalStore.ts`의 `submitStdin()`처럼 기존 `send` 부품과 relay를 통해 처리해야 한다. 입력을 stream 부품에 넣으면 다음 문제가 발생한다.

- stream 수신과 human intent 전송의 권한 모델이 결합된다.
- stream 데이터와 사용자 입력의 provenance가 혼합된다.
- 입력 결과가 stream에 반환되기 전 로컬 echo가 authoritative한 것으로 오해될 수 있다.

필요한 조작은 별도 selector, text field, send 부품으로 선언한다. stream 부품은 수신 및 표시만 담당한다.

#### attestation

기본적으로 불가하다.

`ArtifactRef` attestation은 특정 snapshot artifact의 `artifactId`, `digest`, 표시 시각을 증언한다. stream은 전체 내용이 고정된 snapshot이 아니고, 이후 append가 계속될 수 있으며, 브라우저가 전체 stream의 최종 digest를 알지 못한다. 따라서 “stream을 봤다”는 attestation을 생성하지 않는다.

다음 조건을 모두 별도 계약으로 추가하는 경우에만 제한적인 구간 attestation을 검토할 수 있다.

- 각 chunk가 immutable digest를 가진다.
- backend가 chunk 범위의 정규화 및 digest 계산 규칙을 정의한다.
- client가 실제 표시 완료 범위와 표시 시각을 기록한다.
- backend가 해당 범위의 순서와 digest를 감사 체인에서 검증한다.

현재 심사에서는 이 확장을 권고하지 않는다. stream 부품의 `attestation`은 `none`으로 고정한다.

#### 연결 트리거

stream 연결은 부품이 화면에 표시될 때 자동으로 열 수 있다. 포털의 자동 로드 금지는 제3자
서버에 열람 사실이 노출되는 것을 막기 위한 규칙인데, stream은 BFF(1자) 경유라 그 노출이 없다.
부품이 화면에서 사라지면(뷰포트 밖, 노드 닫힘) 연결을 닫는다 — §3.5의 동시 연결 상한 관리의
일부. 연결 전·연결 중·끊김·재동기화 상태는 항상 보증 영역에 표시한다.

#### 일시정지와 스크롤백

일시정지, 자동 스크롤, 현재 위치, 검색, 필터는 `WorkspaceViewState`에 둔다.

- 일시정지: 수신을 중단하지 않고 화면 반영만 보류할 수 있다.
- 스크롤백: 보존된 tail 내부에서만 이동한다.
- 보존 범위를 벗어난 과거 데이터는 upstream replay 또는 별도 snapshot 요청 없이는 복원하지 않는다.
- view state는 stream의 seq나 authoritative 상태를 변경하지 않는다.
- 필터·검색 적용 중에는 숨겨진 chunk 수를 표시한다(캔버스 필터의 "숨김 개수 표시" 규칙과 동일).

### 3.5 백프레셔와 드롭 정책

브라우저 렌더링 속도가 수신 속도를 따라가지 못하면 다음 정책을 사용한다.

1. transport 수신은 bounded queue에 넣는다.
2. queue 또는 렌더 버퍼가 `maxVisibleItems` 또는 `maxBytes`를 초과하면 오래된 항목부터 제거한다.
3. 제거한 항목 수와 seq 범위를 누적한다.
4. 화면에 명시적으로 표시한다.

예:

```text
LOCAL BUFFER DROP: 300 chunks discarded (seq 8800–9099)
```

- 데이터가 실제로 수신되었으나 화면 버퍼에서 제거된 경우 `LOCAL BUFFER DROP`으로 표시한다.
- 상류에서 유실된 경우 `STREAM GAP`(origin: upstream)으로 표시한다.
- 재연결 후 이어받지 못한 경우 "재동기화됨" 경계로 표시한다.
- 세 경우를 하나의 "누락" 숫자로 합치지 않는다.
- drop 정책은 oldest-first로 고정한다(엔진 불변식). 최신 데이터를 버리면 현재 상태에 대한 사용자의 관찰을 잘못 표시할 수 있다.
- **BFF는 드롭하지 않는다.** BFF가 chunk를 버리고 `StreamGap`을 만들어 보내면 BFF가 사실을
  생성하는 것이다(운반·축약만 원칙 위반). BFF가 부하를 감당 못 하면 해당 stream 연결을 닫고,
  브라우저는 재연결·재동기화 경로를 탄다.
- batch 크기·event size 제한은 상류가 적용하고, 제한에 따른 유실은 상류가 `StreamGap`으로 선언한다.
- 브라우저는 backpressure를 해결하기 위해 임의로 chunk 내용을 합성하거나 순서를 재배열하지 않는다.

연결 수 제약: 같은 origin에 HTTP/1.1 SSE를 여러 개 열면 브라우저 연결 한도(약 6)에 걸려
workspace projection SSE가 연결을 얻지 못할 수 있다 — (ii)를 기각한 "attention 지연"이 다른
형태로 재발한다. 규칙: BFF는 HTTP/2를 전제로 하고, 엔진은 동시 stream 연결 수 상한을 두며
workspace SSE 연결을 항상 우선 확보한다.

## 4. 부품 입장 심사 3항목

### 4.1 백엔드 어휘 없이 서술 가능한가

판정: 통과.

stream 부품의 의미는 특정 백엔드 어휘가 아니라 다음 일반 계약으로 서술할 수 있다.

- 순서 있는 append 데이터
- encoding과 framing
- 단조 seq
- 연결 유실 및 gap 표시
- bounded tail 보존
- 표시 전용

`stdout`, `stderr`, `telemetry`, `log` 같은 값은 `mediaType`, metadata, 또는 upstream payload로 전달된다. Gunnflow는 그 값이 작업 진행도, 우선순위, 위험도라는 semantic인지 판단하지 않는다.

### 4.2 기존 부품 조합으로 만들 수 없는 고유한 인간 상호작용 문법인가

판정: 통과.

viewer, live frame, text field, send 조합만으로는 다음 상호작용 문법을 만들 수 없다.

- append 단위의 순서 보장
- seq gap 탐지
- 서버/로컬 드롭 구분
- 수신 속도보다 느린 렌더러를 위한 bounded tail
- 현재 스크롤 위치를 유지하면서 새 append 수를 표시
- 마지막 확인 seq부터 재연결

viewer는 snapshot 교체 문법이고, portal은 원격 픽셀 문법이다. stream은 이들과 다른 데이터 수신 및 표시 문법을 갖는다.

### 4.3 접합면이 고정된 소형 param 스키마로 닫히는가

판정: 조건부 통과이며, 위 `StreamRef`와 `StreamPartParams`를 채택하는 경우 통과.

3항이 묻는 것은 부품-config 접합면이다(wire 계약 필드가 아니라). 개정된 param은
`{ source.role(테이블 키), retainItems, retainBytes(수치) }` 세 개뿐이므로 닫힌다. 조건부
표현식, 백엔드별 handler, 임의 callback이 필요하지 않다. wire 계약(`StreamRef`, seq, chunk)은
백엔드-조종석 접합면으로 별도 층위이며, 그쪽도 고정 스키마로 닫혀 있다.

다만 다음을 금지해야 한다.

- param에 filtering expression 삽입
- data에 대한 client-side semantic parser 삽입
- stream이 임의 intent를 생성하도록 허용
- stream 부품이 authority 또는 risk를 계산하도록 허용

## 5. 결론

결론: 조건부 승인.

승인 조건은 다음과 같다.

1. `ArtifactRef.access`에 stream을 추가하여 snapshot artifact와 동일하게 취급하지 않는다.
2. workspace projection SSE와 고빈도 append 채널을 분리한다.
3. projection에는 `StreamRef` 선언만 포함하고, 실제 append는 BFF 규칙 경로
   `/api/stream/{nodeId}/{streamId}`에서 전달한다(StreamRef에 url 없음).
4. stream event에는 연속 `seq`, `at`, `channel?`, `data`를 포함한다(batch 범위 필드 없음).
5. upstream gap, 재동기화 경계, local buffer drop을 서로 다른 상태로 표시한다. BFF는 드롭도
   gap 생성도 하지 않는다.
6. stream 부품은 표시 전용이며, 입력은 기존 send 부품과 human relay를 사용한다.
7. stream 부품은 attestation을 생성하지 않는다. stream은 viewer·editor의 기준(base)이나
   attestation 원천이 될 수 없다. 브라우저가 이미 수신·보관한 tail은 copilot 정보 지평에
   포함된다(사람이 볼 수 있는 범위와 동일).
8. pause, scrollback, search, filter는 ViewState로만 관리하고, 필터 중 숨긴 chunk 수를 표시한다.
9. 표현식·조건부·handler를 config에 넣지 않는다. param은 `{source.role, retainItems, retainBytes}`뿐.
10. chunk 본문은 주장 등급, seq/gap/연결 계기는 보증 등급으로 시각 구분한다. ANSI escape는
    기본 비해석(결정 지점: SGR 색상 옵션).
11. conformance 테스트에서 재연결, 중복 append, seq gap, local drop, bounded retention, framing 오류를 검증한다.

**선행 조건(상류 계약 — 이행 전 BLOCKED)**: 상류 execution 표면이 전체 본문 envelope을
보내고 이벤트 seq가 선택 필드(`seq?: number`)인 상태에서 (iii)을 붙이면, BFF가 seq를 합성하거나
gap을 추론해야 하는데 그것은 BFF가 사실을 생성하는 것이다. 따라서 **상류가 연속 seq append
(`sequence: 'contiguous'`)를 계약으로 제공하기 전까지 stream 부품은 fake에서만 구현한다**
(`FakeStreamRef` 등 테스트 전용 이름). 상류 계약의 미해결 항목으로 둔다.

**결정 지점 2(후속 심사)**: 실행 이벤트 같은 구조화 레코드(kind/status/label)를 stream으로 다룰
것인가. `data: string`만으로 받으면 부품이 파싱해야 하므로 금지 위반. `framing: 'record'` +
"레코드 필드 → 표시 열" config 테이블(키 매핑)로 여는 안을 후속 심사에 올린다. 1차 구현은
line/chunk 전용.

**어댑터 주의 사항**: 상류 이벤트를 diff로 delta화하는 어댑터는 `(seq ?? 0) > prevMaxSeq` 같은
필터로 seq 없는 이벤트를 조용히 누락시키지 않아야 한다(드롭 금지 규칙).

따라서 stream은 viewer 또는 portal의 별칭이 아니라, `seq`·append·gap·bounded retention을 계약으로 보장하는 별도 표시 부품으로 승인한다.

