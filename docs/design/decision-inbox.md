# 결정함 (Decision inbox) — 기능·시나리오

요구(고정): **"사용자가 이 화면만 보고 Needs-you 항목의 본문·권고·상태를 읽고 승인/거부를 누를 수 있다."**
제약(고정): 계약 0.2.0 그대로 · §11 숨김 없음 · digest 동봉 · label 해석은 엔진이 아니라 config.

## 1. 기능 정의

조종석에 "결정 작업 전용" 표면을 하나 둔다. 캔버스의 보조 패널이 아니라, 주의(attention)가
걸린 노드들을 **대기열**로 받아 하나씩 읽고 결정하는 화면이다.

- **입력(전부 수신 사실)**: attention을 보유한 노드 목록(projection) + 선택 노드의
  GET /detail items(본문·권고·digest — label은 상류 어휘 그대로) + 노드 capabilities
  (gate.approve / gate.reject / gate.requestChanges 등, 있는 그대로).
- **출력(전부 기존 경로)**: 결정 = 기존 intent 생성 경로 그대로(pending 수명 자동, digest는
  기존 gate 기제의 결속 그대로). 결과의 권위는 다음 snapshot.
- **엔진이 안 하는 것**: cause 문자열 해석(인터럽트/앰비언트 구분은 wiring attention 매핑),
  label 해석(권고 강조는 wiring의 `detail.emphasis` 같은 config 항목), 우선순위 추론.

## 2. 사용자 시나리오

1. 사용자가 작업 중, 우측 상단 알림 토글 옆에 **결정함 아이콘 + 미결 수(예: 3)** 가 보인다.
2. 클릭(또는 단축키) → 캔버스 위로 결정함 오버레이가 열린다. 좌측: 미결 항목 리스트
   (글리프·라벨·상태·cause 원문, 인터럽트 매핑이 앰비언트보다 위). 우측: 첫 항목의 상세.
3. 상세에는 detail items가 label 그대로 섹션으로 선다 — 예: "요청" 본문, "영향", "권고"
   (config가 emphasis로 지정한 label은 시각 강조). 상단에 "as of revision N".
   상세가 없으면 "상세 없음" 한 줄, 백엔드가 표면 미제공이면 "이 백엔드는 상세 미지원" 명시.
4. 하단에 이 노드의 capabilities가 버튼으로: 승인 / 거부 / 수정요청(있는 것만, 원문 라벨).
   거부·수정요청은 기존 gate 폼대로 사유 입력. 승인은 digest 결속 — 불일치면 비활성(기존 규칙).
5. 사용자가 "권고: 승인"을 읽고 승인 클릭 → intent 전송, 항목에 pending 표시 → 선택이 자동으로
   다음 미결 항목으로 이동. 키보드 ↑/↓(j/k)로도 이동.
6. snapshot이 갱신되면 결정된 항목은 리스트에서 **흐려진 채 남는다**(개수 불변, 숨김 없음).
   미결 수가 0이 되면 헤더가 "미결 없음"을 보여준다. Esc로 닫으면 캔버스 그대로.
7. 실 wire가 아직 detail/capabilities를 안 주는 동안에는 리스트는 서고,
   상세는 "미지원" 명시, 버튼은 없음 — 정직한 상태. 시뮬레이터에서는 전 흐름이 돈다.

## 3. 화면 등급

리스트 메타데이터(라벨·상태·cause) = 수신 사실(조종석이 그림) / 상세 본문 = **주장 등급**
(마크업 해석이 필요해지면 격리 viewer, 그 전엔 평문 글리프) / 버튼·폼·pending = 조종석 보증.

## 4. 설계 결정

- (a) **우측 와이드 드로어** — 캔버스 일부가 보인다. 전체 오버레이 아님.
- (b) 결정된 항목은 **접힘 섹션으로 내려보냄** — 미결만 위, 결정됨은 아래 접힘(개수 표시).
  접힘이지 숨김이 아니다(§11): 펼치면 전부 있다.
- (c) 단축키 기본 `D`, 단 **하드코딩 금지 — 단축키는 설정 항목**으로 만든다(개인 설정,
  로컬 전용). 기본값은 추후 조정.

(c)의 파생 범위: 설정 화면에 "단축키" 항목 추가 — 키 바인딩 맵은 개인/기기 설정
(백엔드로 0바이트)이고, 엔진 코드는 바인딩 이름만 알고 키 리터럴은 설정에서 읽는다.

## 5. 목업 이미지 생성 프롬프트 (이미지 생성 모델용)

색은 프리셋일 뿐이므로 목업의 배색은 무시하고 레이아웃·밀도·위계만 본다.

> A desktop web app screen, dark theme: a mission-control graph cockpit (canvas of rounded
> nodes and thin edges) with a WIDE right-side drawer called "결정함" covering about 60% of
> the width — the graph stays visible and slightly dimmed on the left, one node on it glowing
> as the currently selected item. Inside the drawer, left column (300px): header "결정함 ·
> 미결 3", then 3 pending queue rows (glyph, title, status word, tiny cause tag), and below
> them a collapsed section row "결정됨 2 ▸" (folded, not hidden). Right side of the drawer:
> detail for the selected item — caption "as of revision 12", three text sections with
> headings taken verbatim from data ("요청", "영향", "권고"), the "권고" section emphasized
> with a subtle left accent bar, markdown-like prose body. Bottom action bar: "승인"
> (primary), "거부", "수정 요청", with a note that rejection requires a reason. Footer hints
> "↑↓ 이동 · Esc 닫기 · 단축키 D (설정 가능)". Clean, quiet, information-dense but readable.
> No fake browser frame.
