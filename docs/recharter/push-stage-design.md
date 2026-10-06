# push 단계 설계 — copilot 초안 UX · 이슈-에이전트 조화 · 저작 공간

작성 2026-09-28. 전제: 재-charter 원칙(2026-09-28 확정분) §1–§8과 프로젝트 불변식 1–6.
이 문서는 설계 결정 문서이며 구현 지시가 아니다. 상류 계약이 필요한 부분은 BLOCKED 규칙("upstream contract 없는
부분에 production 이름 금지")을 따르며, 여기서 쓰는 타입명은 설계 식별자다.

push 단계의 정의: 백엔드의 attention이나 capability 호출 없이 사람이 먼저 시작하는 행동 —
질문하기, 초안 요청하기, 새 항목 만들기, 긴 텍스트 쓰기. 세 질문은 모두 "사람이 시작한 행동이
백엔드에 도달하는 유일한 경로는 사람이 누르는 send"라는 한 규칙 위에서 닫는다.

---

## 0. 공통 전제 — 세 질문이 공유하는 결정

### 0.1 계약 공백: Intent에 텍스트 값 슬롯이 없다

원칙 §2 `Intent`는 `decision?: { option: string }`만 갖는다. `Capability.decision.input:
{ required }`는 입력 요구를 선언하지만 그 값을 운반할 필드가 Intent에 없다. 현행 코드는
fake intent의 `instruction: string`으로 우회하고 있다(`testing/fake-contracts/src/projection.ts`).
세 질문 모두 텍스트 값을 전송하므로 다음을 계약(Gunnflow 소유)에 추가하는 것을 전제로 한다.

```ts
interface Intent {
  nodeId: string
  action: string
  decision?: { option?: string; text?: string }      // text 추가: text field 부품의 값
  edit?: { baseDigest: string | null; mediaType: string; body: string }  // §3 editor 부품 전용
  attestation?: { displayed: { artifactId: string; digest: string; at: string }[] }
  idempotencyKey: string
}
```

Intent에는 copilot 관련 필드(draftId, origin, assisted 등)를 두지 않는다. 원칙 §7
"provenance 꼬리표 불필요"의 구조적 표현이며, relay 클라이언트는 스키마 외 키가 있으면 전송을
거부한다(conformance 테스트 대상).

짝 규칙(교차 검토 반영): `Intent.decision.option`은 대응 capability가 `decision.options`를
선언했을 때만, `decision.text`는 `decision.input`을 선언했을 때만, `Intent.edit`는 capability에
`edit` 선언이 있을 때만 존재할 수 있다. 이 짝 검사는 relay 경계의 단일 런타임 validator가
수행한다(현행 `PostIntent`에는 validator가 없으므로 구현 항목 — 검증 실패는 전송 전에 사유와
함께 표시). action과 payload 종류의 일치만 검사하며 내용 적합성은 백엔드가 판정한다.

### 0.2 입력 부품 값의 상태 소재: `PendingIntentState`의 composing 단계

현행 `PendingIntentState`(`apps/web/src/state/pendingIntents.ts`)는 send 이후만 다룬다.
send 이전 입력 부품 값(selector 선택, text field 문자열)은 지금 컴포넌트 지역 signal에 있다.
세 저장소 중 어디에 속하는지 판정한다.

| 후보 | 판정 | 이유 |
|---|---|---|
| `WorkspaceProjectionStore` | 불가 | 상류에서 오지 않았다 |
| `WorkspaceViewState` | 불가 | ViewState는 "의미 없음"이 정의다. 입력 값은 전송될 내용이다 |
| `PendingIntentState` | 채택 | "아직 authoritative하지 않은 사용자 action"의 전 단계다 |

결정: `PendingIntentState` 항목에 단계 필드를 둔다.

```ts
type PendingEntry =
  | { phase: 'composing'; localId: string; nodeId: string; action: string;
      values: { option?: string; text?: string; edit?: EditBuffer }; openedAt: number }
  | { phase: 'in-flight'; localId: string; intent: Intent; sentAt: number }
  | { phase: 'rejected';  localId: string; intent: Intent; reason: string; at: number }
```

규칙:
- composing 항목은 네트워크에 나가지 않는다. idempotencyKey는 send 순간 생성된다.
- send 부품의 조건 참조("field 채움", "selector 선택됨")는 composing 항목의 values만 본다.
- composing → in-flight 전이는 send 부품 클릭 핸들러 한 곳에서만 일어난다(엔진 코드, 테스트 대상).
- 이 단계 구분은 저장소를 섞는 것이 아니다. 세 항목 모두 "사람이 만든, 아직 authoritative하지
  않은 action"이다.
- 마이그레이션 범위(교차 검토 반영): 현행 `PendingIntent { localId, intent, createdAt }` 사용처
  전부가 단계형으로 바뀐다 — `pendingIntents.submit()`(전송 즉시 생성 → composing 선행),
  `reconcile()`(fake 의미 검사 → adapter 제공 판정 `isSatisfied()`로 분리), `gateLogic.ts`,
  `canvas/draw.ts`의 pending 표시. 전이는 composing→in-flight(send 클릭 한 곳),
  in-flight→rejected(거부 수신), rejected→composing(사람의 복귀 조작)만 존재한다.

---

## 1. copilot 초안 UX

### 1.1 분석

#### (가) 화면 지위 — 별도 등급이 필요한가

원칙 §6의 등급은 누가 픽셀을 그렸고 내용 보증이 있는가로 나뉜다.

| 등급 | 그린 주체 | 내용 출처 | attestation |
|---|---|---|---|
| 보증 | 조종석 | 수신한 projection, 또는 수신 데이터만 입력인 파생 뷰 | 가능(snapshot) |
| 주장 | 에이전트(iframe) | 에이전트 산출물 | 표시 사실만 가능 |
| 포털 | 원격(live) | 원격 | 불가 |
| **초안(제안)** | 조종석 | copilot 생성. 수신 사실도, 결정적 파생도 아님 | 해당 없음 |

초안은 조종석이 그리므로 주장 등급(iframe)에 넣을 수 없고, 내용이 수신 사실이 아니므로 보증
등급에 넣을 수 없다. §6 파생 뷰는 "수신 데이터만 입력으로 하는 계산"이라 결정적이고 재현 가능한데,
copilot 출력은 비결정적 생성물이므로 파생 뷰 지위도 아니다. 기존 세 등급 중 하나에 넣으면 §6의
"계산 결과를 수신 사실과 같은 지위로 표시 금지"를 어긴다. 따라서 네 번째 등급이 필요하다.

#### (나) 부품 모델과의 결합

초안이 실제 효과를 가지려면 결국 어떤 capability의 intent가 되어야 한다. 가능한 결합 형태:

1. 입력 부품 값 직접 기입: copilot 값이 composing 항목에 바로 들어감. → send 조건 "field 채움"이
   copilot 값으로 충족된다. 사람의 행위 없이 send 활성화 조건이 채워지므로 거부.
2. 입력 부품 위 유령 값(ghost value) + 사람의 채택 동작: copilot 값은 부품 위에 초안 등급으로만
   보이고, 사람이 채택하면 composing 항목으로 복사된다. 채택 전 send 조건은 미충족. → 채택.
3. 새 노드 제안: 캔버스에 노드를 그리는 것은 ProjectionStore에 없는 노드를 그리는 것이다.
   재-charter 원칙상 생성은 부모 노드의 capability 경유이므로, 제안은 "부모 노드 P의 action A를
   이 값으로 실행하자"로 환원된다. 이 환원이 불가능한(P에 enabled 생성 capability가 없는)
   제안은 캔버스에 그릴 근거가 없다.

#### (다) copilot의 위치

- 부품으로 두는 경우: 부품 조립은 백엔드 통합 패키지가 kind별로 정의한다. copilot이 부품이면
  백엔드 wiring config가 사람의 보조 도구 배치를 정하게 되고, copilot은 특정 노드에 묶이지 않는
  작업공간 단위 기능이라 kind별 조립 단위와 맞지 않는다. 부품 입장 심사 1항(범용성)은 통과하지만
  3항(접합면이 소형 param으로 닫힘)에서 copilot 출력은 임의 텍스트·다중 노드 참조라 닫히지 않는다.
- 별도 surface(전용 화면)로 두는 경우: 초안은 채울 부품 옆에 보여야 채택 동작이 가능하다.
  별도 화면이면 초안과 대상 부품이 분리되어 채택 시 대상 식별을 사람이 다시 해야 한다.
- chrome 요소로 두는 경우: DOM chrome의 사이드 패널(요청 입력·note 목록·초안 목록) + 대상
  부품/캔버스 위의 초안 등급 오버레이. 엔진 코드이므로 불변식과 함께 테스트된다.

config=데이터 시험과의 관계: copilot은 wiring config의 키가 아니다. wiring config에 copilot
관련 키를 두지 않으며, copilot 사용 여부·호스트 주소는 사용자 로컬 설정(wiring config와 별개
파일)에 둔다. copilot 출력은 §3의 "프로그램 허용 구역"에서 나온 결과이며, 엔진은 그 결과를 구조
검증기로 읽기만 한다. 엔진이 copilot 출력 스키마만 읽고 copilot이 일으킬 수 있는 일의 전체 목록을
열거할 수 있어야 한다 — §1.3의 `CopilotDraft` 세 variant가 그 목록이다.

#### (라) copilot 실행 위치 — 스택 제약과의 충돌

- 불변식 2: BFF 상류는 단일 wiring 포트(백엔드 어댑터) 하나. LLM 공급자를 BFF 상류로 둘 수 없다.
- 불변식 6: browser/BFF는 credential 원값을 소유하지 않는다. 브라우저에서 LLM을 직접 호출하면
  API 키가 브라우저에 있어야 한다.
- 원칙 §7: copilot 정보 지평 = 사람의 정보 지평. copilot이 백엔드에 접근하면 지평을 넘는다.

세 조건을 동시에 만족하는 배치는 별도 프로세스 `copilot-host`뿐이다. 브라우저가
컨텍스트 묶음을 보내고, copilot-host는 `CopilotDraft[]` JSON만 반환한다. 이는 확정 스택에
프로세스를 하나 추가하는 것이므로 결정 대상이다(결정 지점 D1-4).

#### (마) 트리거

- 요청 시에만: 사람이 패널에 질문하거나, 입력 부품 옆 "초안 요청" chrome 버튼을 누른다.
- 자동 제안: 제안이 생겼다는 사실을 사람에게 알리려면 주의 표시가 필요하다. 그러나 주의 부품
  (interrupt/ambient)의 입력은 projection의 `attention[]`이고, §5 기본 동작은 백엔드 cause를
  매핑한다. copilot 출력에 cause를 부여하면 백엔드가 주지 않은 attention을 조종석이 만드는 것이
  된다. 알리지 않는 자동 제안은 패널을 열 때까지 보이지 않으므로 요청 시 방식과 효과가 같고,
  컨텍스트를 LLM 공급자에게 지속 전송하는 비용과 데이터 노출만 늘린다.

#### (바) 초안의 수명

초안이 백엔드에 흔적을 남기지 않으려면 (1) relay 경로에 초안 데이터가 들어갈 슬롯이 없고
(0.1에서 해결), (2) 초안 저장소가 relay 모듈에 도달할 수 없고, (3) copilot-host가 기록을
남기지 않아야 한다.

### 1.2 결정 지점

- D1-1 초안 화면 지위: 기존 등급 재사용 / 네 번째 등급.
- D1-2 부품 결합: 직접 기입 / 유령 값 + 채택.
- D1-3 위치: 부품 / chrome / 별도 surface.
- D1-4 실행 위치: 브라우저 / BFF 경유 / 별도 copilot-host.
- D1-5 트리거: 요청 시 / 자동.
- D1-6 수명: 메모리 한정 / 로컬 영속.

### 1.3 권고

**권고: 초안은 네 번째 등급(초안 등급)으로 표시하고, chrome 사이드 패널 + 부품 위 유령 값으로만
나타나며, 사람의 요청 시에만 생성되고, 채택은 composing 항목으로의 복사일 뿐 send는 항상 사람이
누른다. copilot은 별도 프로세스 copilot-host에서 실행한다.**

#### 초안 출력 스키마 (copilot-host → 브라우저)

```ts
type CopilotDraft =
  | { kind: 'fill'                         // 기존 capability의 입력 부품 채우기
      draftId: string
      basis: { revision: string }          // 요청 시점 projection revision (envelope 값)
      target: { nodeId: string; action: string }
      option?: string
      text?: string
      editBody?: string }                  // §3 editor 부품 대상일 때
  | { kind: 'create'                       // 새 노드 제안 = 부모 capability 실행 제안
      draftId: string
      basis: { revision: string }
      parent: { nodeId: string; action: string }
      option?: string
      text?: string
      preview: { label: string } }         // 유령 노드 라벨로만 사용
  | { kind: 'note'                         // 패널 텍스트. 캔버스·부품에 나타나지 않음
      draftId: string
      basis: { revision: string }
      text: string
      refs: string[] }                     // nodeId 목록. 클릭 시 selection(ViewState)만 변경
```

#### 구조 검증기 (엔진 코드, 내용 판단 없음)

수신한 각 초안에 대해 존재·소속 검사만 한다.
- `fill`: `target.nodeId`가 ProjectionStore에 있고, 그 노드의 `capabilities`에 `action`이
  `level: 'enabled'`로 있고, `option`이 있으면 `decision.options`에 포함되고, `text`가 있으면
  `decision.input`이 선언되어 있고, `editBody`가 있으면 그 capability에 `edit`가 선언되어 있다
  (0.1의 짝 규칙과 동일 — 선언 안 된 슬롯을 채우는 초안은 폐기).
- `create`: 위 검사를 `parent`에 대해 동일하게 수행.
- `note`: `refs`의 각 id가 ProjectionStore에 있다(없는 id는 링크 없이 원문 표시).
- 검사 실패한 `fill`/`create`는 폐기한다. `note`로 강등하지 않는다 — 강등하면 capability 근거
  없는 주장이 다른 형태로 화면에 남는다.
- 검증기는 초안 내용이 옳은지, 적절한지 판정하지 않는다. 그 판정은 사람이 한다.

#### 초안 등급 시각 규칙

- 예약 토큰 `--draft-stroke`, `--draft-fill`, 라벨 칩 "초안". wiring config의 state/kind/cause
  매핑은 이 토큰을 값으로 지정할 수 없다(구조 검증기가 거부).
- 선 스타일: 점선(dotted). pending이 쓰는 파선(dashed, 현 `canvas/draw.ts`)과 구분한다.
- 초안 등급 요소는 capability 버튼·상태 글리프 집합의 글리프를 사용하지 않는다. 유령 노드에는
  상태 글리프 자리를 비워 둔다(상태는 projection만 줄 수 있다).
- 입력 부품 위 유령 값: 부품 내부 placeholder 위치에 초안 토큰으로 렌더, 옆에 [채택] [버림]
  버튼. 채택 전 부품의 실제 값은 비어 있다.
- 유령 노드(`create`): 부모 노드에 초안 토큰 점선 엣지로 붙는다. 위치는 layout이 부모 기준으로
  배치(ViewState, 의미 없음). ProjectionStore에 들어가지 않고, 필터 숨김 개수 계산에 포함되지
  않는다.

#### 채택과 send

1. [채택] → 대상 capability의 composing 항목을 열거나(없으면 생성) values에 초안 값을 복사한다.
   복사 후 값은 사람의 composing 값이며 부품은 일반 입력 스타일로 바뀐다. 사람은 편집할 수 있다.
2. `create` 채택 → 부모 노드의 해당 capability 입력 부품이 열리고 1과 같이 복사된다. 유령 노드는
   이 시점에 사라진다. send 이후에는 기존 pending 표시(파선)가 이어받고, projection 도착 시
   reconcile된다. 초안이 pending으로 직접 바뀌는 경로는 없다.
3. send 부품 활성화 조건은 composing 값만 본다. viewer 열람 조건은 사람이 viewer를 연 기록만
   충족시킨다 — copilot이 산출물을 읽은 것은 attestation `displayed`에 들어가지 않는다.
4. 생성되는 Intent에는 초안 흔적이 없다(0.1).
5. conformance 테스트로 고정: 어떤 초안도 채택 없이 send 활성화 조건을 충족시키지 못하고,
   어떤 코드 경로도 CopilotDraft에서 relay 호출에 직접 도달하지 못한다.

#### 위치와 요청

- chrome 사이드 패널(DOM): 자유 질문 입력, `note` 목록, 미채택 `fill`/`create` 목록.
- 입력 부품 옆 "초안 요청" 버튼: 엔진이 모든 입력 부품에 붙이는 chrome이며 config로 끄거나 켜는
  키가 없다(사용자 로컬 설정에서 copilot 전체 on/off만).
- 컨텍스트 묶음 = ProjectionStore 스냅샷 + 브라우저가 이미 받은 snapshot 산출물 bytes +
  (부품 단위 요청 시) 해당 composing 값. live 포털은 포함하지 않는다(자동 접속 금지 규칙). 필터로
  숨긴 노드는 사람이 접근 가능한 정보이므로 포함한다.

#### 트리거

요청 시에만. copilot은 interrupt/ambient 부품을 발생시킬 수 없고, 패널 아이콘에 개수 배지도
두지 않는다. 주의 부품의 입력은 projection `attention[]` 하나로 유지한다.

#### 수명

- 저장소: `CopilotDraftState` — 네 번째 로컬 저장소. 세 저장소 어디에도 넣지 않는 이유: 초안은
  사람의 action이 아니므로 PendingIntentState에 넣으면 relay drain 대상이 되고, 수신 사실이
  아니므로 ProjectionStore에 넣을 수 없고, 내용을 가지므로 ViewState에 넣을 수 없다. 섞지 않는
  규칙을 지키는 방법이 분리다.
- 상태: `proposed` → (`adopted` | `dismissed` | `stale`).
  - `dismissed`: 즉시 삭제. tombstone 없음.
  - `adopted`: 복사 직후 삭제(값은 composing 항목에 있음).
  - `stale`: 대상/부모 노드가 ProjectionStore에서 사라졌거나 capability가 `enabled`가 아니게
    되면 채택 버튼 비활성 + 사유 "기준 capability 변경"(구조 사실) 표시. 패널을 닫으면 삭제.
- 메모리 한정. localStorage/IndexedDB 영속 금지. 새로고침 시 전부 소멸.
- 구조 강제:
  - boundary-lint 규칙 추가: `CopilotDraftState` 모듈과 copilot 클라이언트 모듈은
    `transport/relayClient` 및 `PendingIntentState`의 in-flight 전이 API를 import할 수 없다.
    composing 항목 쓰기 API 하나만 허용.
  - 강제력의 한계 명시(교차 검토 반영): copilot 클라이언트는 제3자 코드가 아니라 엔진 코드이므로
    lint·테스트는 회귀 방지 수단이지 적대 코드 차단이 아니다. 적대적 임의 코드가 실행되는 구역은
    iframe뿐이라는 기존 격리 구도가 그대로 상한이다. 브라우저 안에서 같은 origin fetch를 물리적으로
    막을 방법은 없으므로, "AI→relay 없음"의 최종 보증은 (i) copilot-host가 BFF·백엔드 주소를
    모르고 (ii) 브라우저 측 copilot 코드가 엔진 코드베이스에 있어 리뷰·conformance 대상이라는 두
    사실의 결합이다.
  - copilot-host는 백엔드 주소·credential을 설정 항목으로 갖지 않는다. 네트워크 egress는 LLM
    공급자 한 곳으로 실행 시점에 제한(allowlist)하고 통합 테스트로 검증한다. 요청·응답 본문을
    디스크에 기록하지 않는다(설정 기본값, 테스트 대상).
  - **결정 지점 D1-7 (결정 대상, 교차 검토 반영)**: projection 스냅샷·산출물 bytes를 외부
    LLM 공급자에 전송하는 것의 동의와 범위. 후보: 전체 워크스페이스 / 요청 대상 노드와 이웃만 /
    노드 단위 opt-out. 사용자 로컬 설정 소관이며 wiring config가 아니다.
- copilot-host 추가는 결정 전까지 설계로만 둔다. 결정 전 구현 시에는 테스트 전용 이름
  `FakeCopilotHost`(고정 초안 반환)만 사용한다.

#### 근거 요약

- 초안 등급 분리: §6이 수신 사실과 비수신 내용의 동일 지위 표시를 금지하므로.
- 유령 값 + 채택: send 조건이 사람의 행위로만 충족되어야 §7 "초안은 커밋 전까지 불활성"이
  부품 수준에서 성립하므로.
- 생성 = 부모 capability 제안: capability 근거 없는 유령 노드는 백엔드가 허용하지 않은 행동을
  화면에 제시하는 것이므로.
- chrome: 부품이면 백엔드 config가 보조 도구를 통제하고 param이 닫히지 않으므로.
- 요청 시에만: 주의 부품의 입력을 백엔드 attention 하나로 유지하므로.
- copilot-host: 불변식 2·6과 §7 정보 지평을 동시에 만족하는 유일한 배치이므로.

---

## 2. 이슈-에이전트 조화

### 2.1 분석

대상 구성: Gunnflow 밖에서 동작하는 AI 에이전트(이하 이슈-에이전트)가 사람이 언급한 이슈를 포착해
항목 생성 action(`mission.create`)을 백엔드에 직접 요청하는 구성. 이 저장소에는 이슈-에이전트 코드가 없다.
현행 Gunnflow의 `mission.create`는 사람의 relay 경로(`App.tsx` → `pendingIntents.submit`)로만
존재한다.

충돌 지점은 두 가지로 분리된다.
1. 행위자 귀속: AI가 쓴 레코드가 사람 actor로 기록되면 감사 사슬의 actor 필드가 사실과 다르다.
   §7 "기록은 사람만 → provenance 꼬리표 불필요"는 사람 actor 레코드 = 사람이 저작이라는 등식에
   의존한다.
2. 채널: Gunnflow의 relay(BFF `/api/intent`)는 인간 전용이다. AI가 이 경로를 쓰면 §7 위반이다.

이슈-에이전트의 고유 기능: Gunnflow 밖의 작업 맥락(다른 도구에서의 대화 등)에서 이슈를 포착한다.
이 맥락은 Gunnflow에 들어온 적이 없으므로 copilot의 정보 지평 밖이다.

#### 선택지별 비용

| | 원칙 훼손 | 마찰 증가 | 기능 상실 |
|---|---|---|---|
| (a) AI 초안 → 사람 커밋 | 없음(아래 경로 조건 충족 시) | 이슈당 사람 send 1회 | 없음 |
| (b) 사람-귀속 전사 예외 | 큼 | 없음 | 없음 |
| (c) 폐기, copilot 통일 | 없음 | 사람이 Gunnflow로 전환해 요청 | Gunnflow 밖 맥락 포착 상실 |

(b)의 비용 상세: 예외가 하나라도 있으면 사람 actor 레코드 중 일부가 AI 저작이 된다. 그 순간
"provenance 꼬리표 불필요"의 전제가 깨지고, 레코드마다 전사 여부를 표시할 필드가 필요해진다.
구조적 보장(채널이 없음)이 정책적 보장(예외 범위를 지킴)으로 바뀐다. 또 예외 범위("이슈 캡처만")를
강제하려면 어떤 POST가 이슈 캡처인지를 누군가 판정해야 하는데, 그 판정은 의미 판정이다.

(c)의 비용 상세: copilot은 Gunnflow에 들어온 정보만 본다. Gunnflow 밖의 대화 맥락에서 나온
이슈를 copilot이 초안으로 만들려면 사람이 그 맥락을 Gunnflow 텍스트 필드에 다시 입력해야 한다.
이 경우 초안 없이 직접 `mission.create`를 보내는 것과 입력량이 같아 copilot 경유의 이득이 없다.

(a)의 경로 조건 — 초안이 어디에 사는가:
- (a-1) 이슈-에이전트가 Gunnflow에 초안을 직접 전달(브라우저·BFF로 push): Gunnflow에 상류
  아닌 두 번째 입력 채널이 생긴다. 불변식 1(모든 화면은 상류 projection 또는 사람 입력 relay)과
  불변식 2(BFF 상류 = 단일 wiring 포트)를 어긴다. 불가.
- (a-2) 이슈-에이전트가 자기 출력으로 초안 텍스트를 내고, 사람이 Gunnflow에서 직접 입력 후
  send: 원칙 훼손 없음, 백엔드 변경 없음. 마찰은 복사·붙여넣기.
- (a-3) 이슈-에이전트가 백엔드에 자기 actor(에이전트 actor)로 "제안" 레코드를 기록하고, 백엔드가
  그것을 노드로 projection하며 capability(예: 제안 수락 action)를 붙이면, 사람이 Gunnflow에서
  그 capability로 send: §7은 Gunnflow 안의 AI에 relay 채널이 없다는 규칙이다. 에이전트 조직의
  에이전트가 백엔드의 에이전트 채널로 에이전트 actor 레코드를 쓰는 것은 백엔드 소관이며 Gunnflow는
  그 projection을 표시할 뿐이다. 사람 actor 레코드(mission 생성)는 사람의 send로만 생긴다.
  단 "제안" kind와 수락 capability는 상류 계약에 없으므로 백엔드 측 작업이 필요하다.

### 2.2 결정 지점

- D2-1 (a)/(b)/(c) 선택.
- D2-2 (a) 채택 시 초안 경로: (a-2) 에이전트 출력 / (a-3) 백엔드 제안 레코드.
- D2-3 이슈-에이전트가 사람 credential이나 Gunnflow relay 경로를 쓰는 구성의 처분.

### 2.3 권고

**권고: (a). 이슈-에이전트는 커밋 권한을 잃고 초안 생산자로 개조한다. 초안 경로는 즉시 (a-2)로
운영한다. (b)는 채택하지 않는다.**

(a-3) 이행은 자동이 아니다(교차 검토 반영). (a-3)은 "AI가 백엔드에 에이전트 actor로 기록하는
채널"을 허용하는 것인데, §7("AI는 백엔드에 커밋하는 채널 자체가 없음")의 적용 범위가 Gunnflow
안의 copilot에 한정되는지, 시스템 전체의 모든 AI 행위자에 미치는지는 헌장 수준의 결정이다.
**결정 지점 D2-4 (결정 대상)**: §7의 범위를 "Gunnflow의 copilot에는 커밋 채널이 없다.
외부 에이전트의 백엔드 actor 채널은 백엔드 계약·감사 규칙(actor 귀속, 제안-결과 연결)이 갖춰진
경우 별도로 허용될 수 있다"로 개정할지. 개정 결정 전까지 (a-3)은 운영 경로가 아니라 후보다.

실행 규칙:
1. 이슈-에이전트는 Gunnflow BFF(`/api/intent`)를 호출하지 않는다. 사람 actor credential을 갖지
   않는다. 이 두 가지가 Gunnflow 쪽에서 강제할 수 있는 전부다(Gunnflow는 이슈-에이전트 프로세스를
   소유하지 않는다).
2. (a-2) 기간: 이슈-에이전트 출력 형식은 `mission.create`의 입력 슬롯(`name`, `prompt`)에 맞춘
   평문. 사람이 Gunnflow의 해당 capability 입력 부품에 넣고 send. Gunnflow 변경 없음.
3. (a-3) 이행 조건: D2-4 채택 + 상류 계약에 (i) 에이전트 actor로 기록되는 제안 레코드 kind,
   (ii) 그 노드의 capability로 사람이 수락/폐기하는 action, (iii) 수락 intent가 사람 actor로
   mission을 생성하는 백엔드 처리와 제안-결과 연결의 감사 규칙 — 이 요청은 백엔드 측 계약
   작업이며 Gunnflow는 백엔드 계약 초안을 쓰지 않는다. Gunnflow 쪽 신규
   부품은 없지만("미등록 kind 기본 동작으로 표시 + 일반 capability send"), 제안 노드의 수락
   흐름에 대한 conformance fixture는 추가한다 — 기본 동작이 보장하는 것은 표시와 버튼뿐이고,
   actor 귀속이 계약대로 동작하는지는 fixture가 검증해야 한다.
4. 백엔드 측 정책 권고(Gunnflow 결정 아님, 상류 확인 항목): mission 생성 action을 사람 actor로
   제한할지는 백엔드 정책이 정한다.

근거:
- (b)는 §7의 구조적 보장을 정책적 보장으로 격하시키고, 예외 범위 판정이라는 의미 판단을 요구한다.
- (c)는 Gunnflow 밖 맥락에서의 포착이라는 이슈-에이전트의 유일한 고유 기능을 없앤다. copilot은
  정보 지평 규칙상 그 기능을 대체할 수 없다.
- (a)의 비용은 이슈당 사람 send 1회이며, 이 1회가 "사람 actor 레코드 = 사람 저작" 등식을 유지하는
  비용이다. (a-3) 이행 후에는 제안 목록 노드에서 연속 send로 처리 가능해 복사 마찰도 사라진다.

---

## 3. 저작 공간 여부

### 3.1 분석

#### 선택지 A — editor 부품 입장 심사

부품 정의(설계안): `editor` — 여러 줄 텍스트를 기준 버전(base) 대비로 편집하고, send 시 전체
본문과 기준 digest를 함께 전송하는 입력 부품.

입장 심사 §4:

1. 백엔드 어휘 없이 서술 가능한가 — 통과. 서술에 쓰이는 어휘는 텍스트, 줄, 기준 digest, MIME뿐이다.
   "노트", "문서" 같은 백엔드 어휘가 필요 없다.
2. 기존 부품의 config 조합으로 못 만드는 고유한 상호작용 문법인가 — 조건부 통과.
   - 단순히 여러 줄 입력이면 text field의 param(`multiline`)으로 충분하므로 새 부품이 아니다.
   - 고유 문법은 "수신한 내용을 기준으로 수정한다"이다. text field는 새 값을 작성할 뿐 기준 버전이
     없다. 기존 산출물을 수정하는 행위에는 (i) 기준 bytes 표시, (ii) 편집 중 기준이 바뀌었는지 검사,
     (iii) 기준 digest를 intent에 실어 백엔드가 충돌을 판정하게 하는 절차가 필요하다. 이 절차는
     viewer + text field 조합으로 만들 수 없다: viewer는 iframe 격리라 편집 값을 부품 간에 넘길 수
     없고, text field는 기준 digest 슬롯이 없다.
   - 따라서 심사 통과 범위는 "기준 대비 편집" 문법에 한정된다. 서식 툴바, WYSIWYG, 블록 편집 등은
     이 문법에 속하지 않는다.
3. 접합면이 고정된 소형 param 스키마로 닫히는가 — 평문 편집으로 한정하면 통과, 서식 편집기면 실패.
   서식 편집기는 블록 타입·마크 타입이 열린 집합이라 param이 닫히지 않는다.

A의 상호작용 검사 (요구 항목):

- config=데이터 시험: editor param은 아래 스키마의 값만 가진다. 검증 규칙(예: "제목 줄 필수")을
  config에 쓰는 키가 없다. 내용 검증은 백엔드가 하고 거부 사유를 회신하면 원문 표시한다. 엔진은
  editor가 일으킬 수 있는 일(해당 capability의 `edit` intent 1종)을 config만 읽고 열거할 수 있다.
- "조종석은 진실을 소유하지 않음": 편집 중 텍스트는 `PendingIntentState`의 composing 항목
  (0.2)에 산다. ProjectionStore에는 send 후 백엔드가 새 digest의 산출물을 projection으로 보낼
  때에만 새 내용이 들어간다. 그 전까지 화면의 "저장됨" 표시는 존재하지 않는다 — 조종석이 가진
  것은 "미전송" 또는 "전송 중" 상태의 사람 입력뿐이다.
- attestation: editor는 기준 텍스트를 조종석이 직접 평문 렌더한다(텍스트 글리프만 그림, HTML
  해석 없음). 이는 snapshot 산출물을 digest와 함께 표시한 것이므로 send 시
  `attestation.displayed = [{ artifactId: base, digest: baseDigest, at }]`를 자동 첨부할 수
  있다. live 산출물은 내용 고정이 안 되므로 editor 기준이 될 수 없다. digest 없는 산출물도 기준이
  될 수 없다(충돌 검사 불가).

#### 선택지 B — 저작은 백엔드 쪽 도구, Gunnflow는 열람 + 단문 입력

세컨드 브레인 계열 작업의 행위 목록과 B에서의 성립 여부:

| 행위 | B에서 | 비고 |
|---|---|---|
| 포착(짧은 메모) | 성립 | text field 한 줄 |
| 연결 | 성립 | capability 경유(백엔드가 연결 action 제공 시) |
| 재방문·열람 | 성립 | viewer(text/markdown → fallback 뷰어 또는 동봉 HTML) |
| 장문 작성 | 불성립 | 다른 도구로 전환 |
| 기존 노트 수정 | 불성립 | 다른 도구로 전환 |
| 에이전트 산출물에 대한 수정 제안 | 부분 | `gate.requestChanges`류 한 줄 지시만 가능 |

B에서 Gunnflow는 세컨드 브레인의 열람·분류 화면이고 작성 공간이 아니다. 작성은 외부 도구에서
하고 결과가 백엔드를 거쳐 projection으로 돌아온다. 이 경우 "대상 작업공간에 인간 지적 활동이
포함된다"는 정체성 문장은 열람·연결까지만 충족한다. 또 에이전트 감독 쪽에서도 산출물 문서를
사람이 직접 고쳐 돌려주는 경로가 없어, 수정은 항상 한 줄 지시 → 에이전트 재작성의 왕복이 된다.

B의 이점: 부품이 늘지 않고, Gunnflow가 편집 충돌·대용량 본문을 다루지 않는다.

### 3.2 결정 지점

- D3-1 A(editor 부품 입장) / B(외부 도구 위임).
- D3-2 A 채택 시 편집 대상 바인딩: config가 산출물을 고름 / capability가 산출물을 지정.
- D3-3 A 채택 시 전송 단위: 전체 본문 교체 / diff 패치.
- D3-4 A 채택 시 자동 저장: 백엔드 주기 전송 / 로컬만 / 없음.
- D3-5 A 채택 시 기준 변경(충돌) 처리: 자동 병합 / 사람 수동.

### 3.3 권고

**권고: A. `editor` 부품을 "평문 기준 대비 편집"으로 한정하여 입장시킨다. 편집 텍스트는
PendingIntentState composing 항목에 살고, 저장은 오직 사람의 send로 생성되는 `edit` intent이며,
저장 여부는 projection의 새 digest 도착으로만 표시한다.**

#### 계약 추가 (Gunnflow 소유 계약)

```ts
interface Capability {
  action: string
  level: 'enabled' | 'disabled' | 'hidden'
  decision?: { options?: string[]; input?: { required: boolean }; evidence?: string[] }
  edit?: {                                  // 추가: 이 action이 편집 intent를 받음을 선언
    artifactId: string | null               // 편집 기준 산출물. null = 새 본문 작성(부모 capability 경유 생성)
    mediaTypes: ('text/plain' | 'text/markdown')[]
    maxBytes: number
  }
  // 확장 차단 규칙(교차 검토 반영): editor 부품은 mediaType과 무관하게 본문을 평문 문자열로만
  // 다룬다. mediaType은 통과 metadata다. 서식 구조(AST, 블록, 마크)가 이 접합면(edit 선언,
  // EditorPartParam, Intent.edit)에 필드로 들어오는 어떤 확장도 이 심사의 범위 밖이며 별도
  // 부품 심사를 새로 거쳐야 한다. conformance 테스트가 접합면의 필드 집합을 고정한다.
}
// Intent.edit 는 0.1 참조: { baseDigest: string | null; mediaType; body }
```

D3-2 권고: capability가 산출물을 지정한다. config가 "mediaType이 text/markdown인 첫 산출물"처럼
고르면 선택 규칙이 config 안의 조건식이 되어 §3 시험에 걸리고, 어느 산출물이 편집 가능한지는 백엔드
권한 판단이다.

#### 부품 param 스키마 (wiring config에 들어가는 값)

```ts
interface EditorPartParam {
  capability: string          // 결합할 action 이름 (노드의 capabilities[].action 키)
  rows: number                // 초기 표시 줄 수 (표시 전용)
  wrap: 'soft' | 'none'       // 표시 전용
}
```
허용 mediaType·최대 크기·기준 산출물은 param이 아니라 capability에서 온다. param은 표시 값만 갖는다.

#### 내장 불변식 (엔진 코드, 테스트 대상)

1. 기준 표시: `artifactId`의 snapshot bytes를 평문으로 렌더한다. text/markdown도 원문 그대로
   표시하고 해석·렌더하지 않는다(렌더 미리보기가 필요하면 같은 노드의 viewer 부품이 담당 — 주장
   등급). `digest` 없는 산출물이거나 `access.kind === 'live'`면 editor는 비활성, 사유 "기준 고정
   불가"(구조 사실) 표시.
2. 편집 버퍼: composing 항목의 `values.edit: EditBuffer = { baseArtifactId, baseDigest, body }`.
   ProjectionStore를 수정하지 않는다.
3. 기준 이동 검사: ProjectionStore의 해당 산출물 digest ≠ `baseDigest`가 되면 send 비활성 +
   "기준 변경됨" 표시 + 새 기준 열람 버튼. 이 비교는 digest 문자열 동등성 검사이며 내용 해석이 아니다.
4. send: `Intent.edit = { baseDigest, mediaType, body }` + 기준 산출물 attestation 자동 첨부.
   `body` 바이트 길이 > `maxBytes`면 send 비활성(수치 비교).
   attestation 전제(교차 검토 반영): attestation은 수신 bytes를 무변환으로 표시했을 때만
   첨부한다. 표시 과정에서 변환(인코딩 교정, 줄바꿈 정규화, 유니코드 정규화)이 발생했으면
   attestation을 생략한다 — "표시한 것"과 digest 대상이 다르면 증언이 거짓이 된다. 5의 규칙에
   따라 그런 산출물은 애초에 편집 기준이 될 수 없으므로 editor 경로에서는 자동 성립한다.
5. reconcile: in-flight 항목은 projection에 전송 bytes와 같은 digest의 산출물이 나타나면 제거한다.
   bytes 정의(교차 검토 반영 — 이것 없이는 실행 불가): digest 대상은 **전송된 그대로의 UTF-8
   bytes**다. `Intent.edit.body`를 UTF-8로 직렬화한 것의 sha256 = 백엔드가 저장하는 산출물
   bytes의 sha256이 되도록 계약에 명시한다(줄바꿈 무변환, BOM 없음). 수신 산출물이 UTF-8로
   무손실 왕복되지 않으면(BOM, 다른 인코딩, 디코딩 실패) 그 산출물은 편집 기준이 될 수 없다 —
   "기준 고정 불가"와 동일 처리. 알고리즘 sha256 고정(상류 확인 항목).
6. 거부: 백엔드 거부 시 본문을 버리지 않는다. 항목을 `rejected`로 두고 composing으로 복귀 가능하게
   한다(현행 `pendingIntents.ts`의 "거부 시 제거"와 다른 점 — 장문 손실 방지). 사유는 원문 표시.
7. 편집 중 본문은 다른 부품의 조건 참조 대상이 될 수 있다("field 채움"과 동일하게 body 길이 > 0).

#### D3-3 ~ D3-5 권고

- D3-3 전송 단위: 전체 본문 교체. diff 패치는 patch 형식 계약과 적용 실패 처리가 추가되고, 본문
  크기는 `maxBytes`로 이미 제한된다.
- D3-4 자동 저장: 백엔드 주기 전송 금지. 주기 전송은 사람이 send를 누르지 않은 쓰기이고 감사
  사슬에 편집 중간 상태 이벤트를 누적시킨다. 로컬 보존은 허용: composing 항목의 edit 버퍼를
  IndexedDB에 "미전송" 표시와 함께 보관(탭 종료 대비). 이 보관본은 화면에서 항상 "미전송"으로
  표시하며 저장된 것으로 표시하지 않는다. 불변식 "local graph mutation을 source of truth로 삼지
  않음"과 충돌하지 않는다 — 그래프 상태가 아니라 전송 전 사람 입력이다.
  CopilotDraftState(메모리 한정)와 규칙이 다른 근거(교차 검토 반영): 초안은 AI 생성물이라
  유실 비용이 없고(다시 요청하면 됨) 불활성 원칙상 수명을 짧게 두는 쪽이 안전하지만, edit 버퍼는
  사람의 노동이라 유실 비용이 크다. 영속 범위는 edit 버퍼만이며 PendingIntentState의 다른
  단계(in-flight 등)는 영속화하지 않는다. 보관본 삭제 시점: send 후 reconcile 완료 시,
  또는 사람이 버림을 눌렀을 때.
- D3-5 충돌: 자동 병합 없음. 사람이 새 기준을 열람하고 버퍼를 직접 수정한 뒤 "새 기준으로 전환"을
  누르면 `baseDigest`가 갱신된다. 병합 결과를 조종석이 만들어 전송하면 사람이 누르는 send라도
  본문의 일부를 조종석이 작성한 것이 된다.

#### copilot과의 결합

`CopilotDraft.fill.editBody`로 editor 대상 초안을 받는다. 표시는 기준 본문 대비 줄 단위 diff를
초안 등급으로 렌더(수신 기준 + copilot 텍스트만 입력으로 하는 파생 뷰이지만 한쪽 입력이 초안이므로
초안 등급). 채택은 hunk 단위로 composing 버퍼에 복사. 채택된 텍스트는 사람의 버퍼 내용이며 표지가
남지 않는다(§7).

#### 새 노트 작성

`edit.artifactId === null`인 capability(부모 노드의 생성 action)에 editor를 결합하면 기준 없이
새 본문을 작성한다. `baseDigest: null`로 전송. 새 노드 생성은 부모 capability 경유 규칙을 그대로
따른다.

#### 상류 의존

상류 계약에 편집 가능 산출물 선언(`Capability.edit`)과 `edit` intent 처리가 없다. 계약 도착
전에는 fake 모드에서만 구현하며 이름은 `FakeEditableArtifactProjection` 등 테스트 전용으로 둔다.

#### 근거

- B에서 장문 작성·기존 노트 수정·산출물 직접 수정이 불성립하므로, 정체성의 "인간 지적 활동" 절반과
  에이전트 감독의 수정 경로가 외부 도구에 넘어간다.
- A는 입장 심사 3항목을 "평문 기준 대비 편집"으로 한정할 때 통과하며, 이 한정이 서식 편집기로의
  확장을 심사 단계에서 차단한다.
- A의 세 위험(진실 소유, config 프로그램화, attestation 오용)은 각각 composing 단계 저장 +
  digest 도착 기반 reconcile, param의 표시 값 한정 + capability 바인딩, snapshot·digest 필수
  조건으로 닫힌다.

---

## 4. 자기 검사 — 의미 판단 문장 점검

아래 판정을 Gunnflow(엔진·BFF·web)에 두는 문장이 있는지 문서 전체를 점검했다.

| 문장 유형 | 소재 | 판정 |
|---|---|---|
| 초안 구조 검증(노드 존재, capability enabled, option ∈ options) | 엔진 | 존재·소속 검사 — 허용(§2 슬롯 모델) |
| 초안 내용의 옳고 그름·적절성 | 사람 | Gunnflow에 없음 |
| stale 사유 "기준 capability 변경" | 엔진 | capability level 값 비교 — 허용 |
| editor 기준 이동 | 엔진 | digest 문자열 동등성 — 허용 |
| maxBytes 초과 | 엔진 | 수치 비교, 한도는 capability가 줌 — 허용 |
| 편집 내용 검증 | 백엔드 | 거부 사유 원문 표시 |
| 이슈 캡처 여부 판정((b)에서 필요) | — | 의미 판정이므로 (b) 불채택 근거로만 등장 |
| 어떤 산출물이 편집 가능한가 | 백엔드(capability.edit) | config 선택 규칙 불채택 |
| 자동 제안 시점·중요도 | — | 자동 트리거 불채택. attention은 백엔드 cause만 |
| mission 생성을 사람 actor로 제한할지 | 백엔드 정책 | Gunnflow 결정 아님으로 명기 |

점검 결과 Gunnflow가 progress/priority/dependency/위험등급/내용 적합성을 판정하는 문장은 없다.

## 5. 결정 요약

| ID | 권고 |
|---|---|
| D0 | Intent에 `decision.text`, `edit` 추가. copilot 필드 없음. 입력 값은 PendingIntentState composing 단계 |
| D1-1 | 네 번째 등급(초안). 점선·예약 토큰·"초안" 칩, 상태 글리프 미사용 |
| D1-2 | 유령 값 + 사람의 채택(composing으로 복사). send는 항상 사람 |
| D1-3 | chrome 사이드 패널 + 부품/캔버스 오버레이. wiring config 키 없음 |
| D1-4 | 별도 copilot-host 프로세스(결정 대상). 백엔드 주소·credential 없음 |
| D1-5 | 요청 시에만. 주의 부품 발생 불가 |
| D1-6 | `CopilotDraftState` 메모리 한정, 버림·채택 즉시 삭제, relay import 금지(lint) |
| D1-7 | 미결: 외부 LLM 전송 동의·컨텍스트 범위 (전체 / 대상 노드+이웃 / 노드 opt-out) |
| D2 | (a). 즉시 (a-2) 에이전트 출력 → 사람 send. (a-3)은 D2-4 채택 + 상류 계약 후보로만 |
| D2-4 | 미결: §7 적용 범위 개정 (copilot 한정 vs 모든 AI 행위자) — (a-3)의 전제 |
| D3 | A. editor 부품 = 평문 기준 대비 편집, capability.edit 바인딩, 전체 본문 교체, 백엔드 자동 저장 없음, 자동 병합 없음. digest = 전송 UTF-8 bytes의 sha256, 무손실 왕복 불가 산출물은 기준 불가 |
