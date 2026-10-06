# 조망→선택→작업 전환 — 기능·시나리오

문제: 노드 선택은 곧 그 노드에서 작업하겠다는 뜻인데, 선택 결과가 좌하단 소형 패널이고 심화
표면 4종이 어떻게 나오는지 드러나지 않는다. 현황: 선입 GenericNodePanel(소형) 안의 버튼으로만
TaskInspector / HumanGate / Execution / LiveTerminal 진입 — 진입로가 패널에 숨어 있음.

## 0. 인간공학 근거 (기준: 배치가 아니라 작업 흐름에서 출발)

사람의 실제 흐름은 **조망 ↔ 집중의 왕복**이다. 그 왕복에서 비용이 드는 지점은 넷:

- **시선**: 조망의 시선은 캔버스 중앙~선택한 노드에 있다. 좌하단 소형 패널은 시선을
  화면 반대 끝으로 끌어내리고, 읽은 뒤 다시 노드로 복귀시킨다 — 선택할 때마다 왕복 2회.
  ②의 우측 스테이지는 선택한 노드 **옆**에 서고, 노드는 계속 보인다(시선 이동 1회, 복귀 불요).
- **주의 연속성**: 팝업·별도 화면은 "여기서 저기로 순간이동"이라 어디서 왔는지를 머리가
  다시 구성해야 한다. 줌 연속체(①→②→③ 애니메이션)는 공간 기억을 유지시킨다 —
  "내가 지금 그 노드 안에 있다"가 화면 문법으로 보인다.
- **정보량**: 소형 패널은 "한 번에 다룰 정보량"이 결정에 못 미쳐서(본문·권고가 안 들어감)
  결국 심화 표면으로 한 번 더 가게 만든다 — 단계가 하나 더 있는 게 아니라, **쓸모없는
  중간 단계가 하나 있는 것**. ②는 "그 자리에서 결정 가능한 양"(상태+상세+행동)을 기준으로
  크기를 정하고, 그걸 넘는 작업만 ③으로 간다. 각 깊이에 "여기서 끝나는 일"이 있다.
- **손**: 왕복이 잦은 동선은 키보드가 이어받는다 — Enter(깊이 들어감)/Esc(나옴)의 대칭,
  결정함 대기열의 ↑↓. 마우스는 조망 탐색(pan/zoom/선택), 키보드는 깊이 이동.

이 기준으로 기존 좌하단 GenericNodePanel은 기각된다: 시선 왕복 유발, 정보량 미달,
심화 표면 진입로 은닉(패널 안 버튼), 공간 의미 없음(왜 거기인지 설명 불가).

## 1. 개념 — 깊이 3단, 하나의 연속체

화면 전환을 "팝업 열기"가 아니라 **노드 안으로 들어가는 semantic zoom의 연장**으로 통일한다.

| 깊이 | 의미 | 공간 |
|---|---|---|
| ① 조망 | 전체를 본다 | 그래프 전면. tier가 강조·디테일·크기(P3)로 관련도 표현 |
| ② 선택 | 이 노드를 살펴본다 | 노드 국소 확대(P3) + **우측 스테이지**(화면 ~40%, 고정 높이 아님) — 요약·상세(detail items)·행동·**"들어가기"** |
| ③ 작업 | 여기서 일한다 | **작업 표면 전면** — 그 노드의 kind 조립(inspector·gate 폼·execution 스트림·terminal 포털)이 화면 전체를 받음. 컨텍스트 스트립 없음 — 복귀는 Esc. 결정 대기열을 들고 들어온 경우에만 작은 대기열 칩 |

- 좌하단 소형 패널은 폐기. ②의 우측 스테이지가 그 역할을 승계(공간을 제대로 받음).
- 심화 표면 4종은 "별도 화면"이 아니라 **③의 kind별 조립 결과** — 어떤 노드든 ②에서
  "들어가기" 하나로 도달하므로 진입로가 항상 같은 자리에서 발견된다.
- ③→②→① 복귀는 Esc, 전환은 줌 연속 애니메이션(P3 모션 문법과 동일 토큰).

## 2. 사용자 시나리오

1. 사용자가 조망 중 — pending gate 노드가 인터럽트 글리프로 주의를 끈다.
2. 클릭(②) → 노드가 국소 확대되고 우측 스테이지가 들어온다: 상태·attention 원문, detail
   items(권고 강조), capabilities 버튼, 그리고 상단에 큼직한 **"들어가기 ↵"**.
3. 간단한 결정이면 스테이지에서 바로 승인/거부(②에서 완결 — 지금의 gate overlay 흐름).
4. 깊게 봐야 하면 Enter/더블클릭(③) → 화면 전체가 그 gate의 작업 표면으로 줌인: 본문
   전문, 이력, 폼. 다른 노드로 가려면 Esc로 ②에 나와 고른다.
5. task 노드라면 ③이 Inspector+Execution 스트림 조립, live 세션이면 terminal 포털(명시
   열기 전 접속 안 함 — 기존 불변식 그대로).
6. Esc → ②로 줌아웃(스테이지 유지), Esc → ①(조망 복귀, 카메라 연속).
7. **결정함과의 통일**: 결정함 리스트에서 항목 선택 = 그 노드의 ③ gate 작업 표면 + 대기열
   prev/next 내비게이션. 같은 표면, 진입로만 둘(그래프에서 / 대기열에서).

## 3. 불변식 접점 (변경 없음)

등급 표시(보증/주장/포털/초안/개인) 그대로 ②③에 적용 · 포털 자동 로드 금지 · capability
부재=hidden · 모든 쓰기 intent 경유 · ②③은 전부 수신 사실+사람 입력의 표시(뷰 기계장치).

## 4. 판단 4건 — 가정값 (구현 화면으로 재검토)

- (a) ② 스테이지 폭 = **~40%** (가정).
- (b) ③ 그래프 컨텍스트 = **없음** — 작업 내용이 화면을 차지하고 복귀는 Esc. 결정 대기열을 들고 들어온 경우에만 대기열 칩이 뜬다.
- (c) ③ 진입 = **더블클릭+Enter+스테이지 버튼 셋 다** (가정).
- (d) 결정함 = **확정된 드로어가 집** + 상세·행동 기계장치를 ③과 공유, 드로어에서 ③ 진입 시
  대기열(prev/next·자동 다음)이 따라감 (가정 — 결정함 드로어 확정이 초안의 완전 통합안보다
  우선하므로 이렇게 조정).

## 5. 목업 프롬프트 (이미지 생성 모델용 — 3프레임 1장)

> One image, three horizontal frames showing the same dark mission-control web app at three
> depths. FRAME 1 "조망": a full-canvas node graph (~20 rounded nodes, thin edges, dashed
> group containers), one node glowing with an alert glyph. FRAME 2 "선택": same graph; that
> node is locally enlarged; a right-side stage panel (40% width, full height) shows: node
> title, status line, three labeled text sections ("요청", "영향", "권고" — 권고 has an
> accent bar), action buttons "승인/거부", and a prominent "들어가기 ↵" button at top.
> FRAME 3 "작업": the stage has zoomed to fill the screen as a work surface — full document
> body, decision form at bottom; no graph strip remains (Esc returns); only a small queue chip appears when a decision queue was carried in. Captions under
> frames: "① 조망 → ② 선택 → ③ 작업". The selected node must remain visible in frame 2
> (the stage stands beside it, never covering it). Flat, precise, quiet engineering aesthetic.
