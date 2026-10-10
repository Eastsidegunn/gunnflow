# Gunnflow UI 요구사항 — 모션 · 표면 · 신호 · 결정 (2026-10-01)

> 이 문서는 Gunnflow 코드와 Carbon Design System을 대조해 만든 UI 요구사항이다. 각 행은 "대상(코드 이름) · 요구 · 값 · 검증" 한 줄이다. 프로젝트 불변식(의미 추론 금지, 주의는 항상 전달, pending 수명, 등급 시각 구분)이 이 문서보다 우선한다.

## 채택된 결정 (2026-10-01)

1. **S-01 채택** 노드 선택 시 `GenericNodePanel` 하나만 열고 `SelectionOverlay`(Quick Card)는 없앤다.
2. **S-02 채택** `TaskInspector`·`HumanGateSurface` 서랍 폭을 400px로 통일한다.
3. **M-08 채택** 모달 배경 dim을 240ms로 한다(Carbon 값은 700ms, 패널과 동시에 끝나도록 줄임).

## 기준 조정 (2026-10-01)

- **N-04**: 톤이 자유 hex로 열렸으므로(렌더 어휘 개방) "한 색은 한 의미"는 **엔진 소유 신호색(attention·pending·portal·personal)에만** 적용. config 톤은 강제 불가. 또한 신호색 4종+ "서로 3:1"은 수학적으로 불가(3:1 휘도 사다리는 3단이 한계) — **서로 다른 hue + 각각 배경 대비 3:1 이상**으로 시행(테스트 고정). portal은 amber에서 분리해 고유 색(#4dd0db)을 받음.
- **S-07·S-08**: 값은 `apps/web/src/theme/defaultTheme.ts`에 모였음 — CSS lint가 아니라 **theme 값 정리 + theme 밖 리터럴 금지 검사**로 구현. 노드 크기 숫자도 theme이 정본.
- **M-10**: Execution·Terminal은 fake 전용 과도기 표면 — 후순위.
- **M-04**: S-01 채택으로 소멸.
- **D-05**: wiring config에 action→사람 라벨 테이블이 아직 없음 — 계약 추가 선행 필요(닫힌 테이블).
- **N-07**: 사이드바 렌즈 배지가 파생 카운트로 바뀜(렌즈 config화) — 하단 strip과 역할 정리 필요.

## 진행 현황 (2026-10-01 구현 · 2026-10-02 모드 제거/우클릭 통합 반영)

**2026-10-02 결정으로 뒤집힌 것**: OBSERVE/INTERVENE 모드 폐지(쓰기 가능 = capability × 선행조건만; privileged 마찰이 유일한 안전장치), 상단 툴바 → 검색창 하나(생성·개인·rewire는 캔버스 우클릭 메뉴로, 줌은 휠·핀치). D-02는 모드와 함께 소멸.

- ✅ **모션**: M-01~M-09, M-15, M-16/17(확인), M-18, M-19(테스트 고정). 퇴장은 presence 유틸.
- ✅ **표면**: S-01(Quick Card 제거, 패널 단일화), S-02(400px), S-03(게이트 기본 panel), S-04(이미 충족), S-05(포커스 이동·복귀·모달 트랩).
- ✅ **신호**: N-01(배지+토스트 — 단 위치는 상단 **중앙**: 우측은 서랍 자리; 첫 스냅샷은 기준선), N-02, N-05(인라인 영수증), N-06, N-07. N-04는 기준 조정대로(portal 분리 #4dd0db + 테스트). N-03은 기존 충족 확인.
- ✅ **결정·문구**: D-01(describedby), D-04(Evidence n/m), D-06(입력 라벨), D-07(sentence case — 터미널 표면 제외), D-08(DOM 포커스 링).
- ⬜ **미착수**: S-06~S-08(레이어 밝기·간격/radius/글자 토큰 정비 — 전역 시각 변화라 스크린샷 확인 루프로), M-10~M-14(캔버스/카메라 모션), D-03(위험행동 3단 분류표 명문화), D-05(계약에 action→사람 라벨 테이블 — 계약 추가 선행), 캔버스 노드 포커스 링(D-08 잔여), 터미널 표면의 READ ONLY(과도기 표면).

## 5.1 모션 토큰 (`apps/web/src/canvas/motion.ts`, Carbon productive)

| 토큰 | 값 | 쓰는 곳 |
| --- | --- | --- |
| `duration.fast01` | 70ms | 버튼 hover·press, pending 점선 등장 |
| `duration.fast02` | 110ms | 페이드, 모든 퇴장(작은 요소) |
| `duration.moderate01` | 150ms | 떠 있는 카드 등장, 서랍 퇴장 |
| `duration.moderate02` | 240ms | 서랍·모달·토스트 등장, 화면 교체, 재배치 |
| `duration.slow01` | 400ms | 먼 카메라 이동 |
| `ease.entrance` | `cubic-bezier(0, 0, 0.38, 0.9)` | 들어오는 것 |
| `ease.exit` | `cubic-bezier(0.2, 0, 1, 0.9)` | 나가는 것 |
| `ease.standard` | `cubic-bezier(0.2, 0, 0.38, 0.9)` | 화면 안에서 움직이는 것(카메라·재배치·교체) |

## 5.2 모션 요구

| ID | 대상 (코드) | 요구 | 값 | 검증 |
| --- | --- | --- | --- | --- |
| M-01 | `GenericNodePanel` (`generic-panel`) | 2026-10-03 결정: 왼쪽 화면 밖에서 스무스하게 진입 (translateX −100%→0) | moderate02 240ms, entrance | 열린 직후 transition-duration 150ms |
| M-02 | `GenericNodePanel` | 닫힐 때 퇴장: opacity 1→0, 퇴장 중 클릭 불가 | fast02 110ms, exit | 닫기 후 110ms 동안 pointer-events none, 이후 DOM 없음 |
| M-03 | `GenericNodePanel` | 2026-10-03 결정: 열린 상태에서 다른 노드를 고르면 패널은 제자리, 내용이 **페이드로 교체**(재등장 슬라이드 없음) | fast02 110ms, entrance | 선택 전환 시 패널 transform 변화 없음, 내용만 페이드 |
| M-04 | `SelectionOverlay` (`selection-overlay`) | 등장 페이드 / 퇴장 페이드 (S-01 채택 시 삭제) | 등장 fast02 110ms entrance, 퇴장 fast02 110ms exit | 두 방향 모두 110ms |
| M-05 | `TaskInspector` (`task-inspector`) | 2026-10-03 결정: 오른쪽 화면 밖에서 진입 (translateX +100%→0) | moderate02 240ms, entrance | 열린 직후 240ms |
| M-06 | `TaskInspector` | 닫힐 때 들어온 방향의 반대로 나감 | moderate01 150ms, exit | 닫기 후 150ms에 DOM 제거 |
| M-07 | `HumanGateSurface` panel (`data-form=panel`) | M-05·M-06과 동일 | 동일 | 동일 |
| M-08 | `HumanGateSurface` overlay, `SettingsScreen` | 배경 dim opacity 0→목표값, 패널 scale 0.98→1 + opacity | 둘 다 moderate02 240ms, entrance. 닫기 moderate01 150ms, exit | 배경·패널 동시 시작·동시 종료 |
| M-09 | `RelayErrorToasts` (`relay-error`) | 오른쪽 위에서 들어옴: translateY −8px→0 + opacity. 자동으로 사라지지 않음 | 등장 moderate02 240ms entrance, 닫기 fast02 110ms exit | 10초 후에도 토스트 존재 |
| M-10 | `App` 본문 교체 (캔버스 ↔ `ExecutionSurface` ↔ `LiveTerminalSurface`) | `document.startViewTransition`으로 크로스페이드. 돌아오면 카메라·선택 복원 | moderate02 240ms, standard | 복귀 후 `camera()` 값이 들어가기 전과 같음 |
| M-11 | `viewState` 카메라 (`centerOn`, 딥링크, 줌 버튼) | 목표까지 보간 이동. 화면 한 폭 미만이면 240ms, 이상이면 400ms | moderate02 / slow01, standard | 이동 중 포인터다운·휠 입력 시 즉시 중단 |
| M-12 | `layoutState` 재배치 (`NodeBox` x·y) | 이전 위치에서 새 위치로 보간 | moderate02 240ms, standard | 재배치 후 240ms에 최종 좌표 도달 |
| M-13 | projection에서 사라진 노드 (`drawGenericNode`) | 페이드만, 그동안 선택·클릭 불가 | fast02 110ms, exit | 110ms 뒤 장면에 없음 |
| M-14 | `drawPendingEdges` | pending 점선 등장 | fast01 70ms | — |
| M-15 | 모든 `button` | hover·press 색 변화 | fast01 70ms | — |
| M-16 | 주의 표시 (`SceneNode.attention`, amber 테두리·'!'·점) | 애니메이션 금지. 카메라·패널 이동 중에도 첫 프레임부터 그림 | 0ms | projection 도착 프레임에 표시됨 |
| M-17 | 수신 값 (state 텍스트, glyph·tone, `counts`, label) | 보간 금지(숫자 굴리기·색 서서히 바꾸기 없음) | 0ms | 중간값이 한 프레임도 그려지지 않음 |
| M-18 | 전역 | `prefers-reduced-motion: reduce`면 M-01~M-15 전부 0ms | 0ms | 에뮬레이션 후 모든 transition-duration 0 |
| M-19 | 전역 | 이 표에 없는 등장·퇴장 지점은 0ms. 새 `<Show>`는 표에 등록해야 함 | 0ms | 등록되지 않은 전환 지점이 있으면 테스트 실패 |

## 5.3 표면·배치 요구

| ID | 대상 (코드) | 요구 | 값 | 검증 |
| --- | --- | --- | --- | --- |
| S-01 | 노드 선택 | 열리는 표면은 `GenericNodePanel` 하나. `SelectionOverlay`의 진입 버튼(Inspector →, Open gate →)은 `GenericNodePanel` 머리로 옮김 | — | 선택 시 `selection-overlay` 없음 |
| S-02 | `TaskInspector`, `HumanGateSurface` panel | 폭을 하나로 통일 | 400px | 두 서랍 폭 동일 |
| S-03 | `HumanGateSurface` | 기본은 panel. overlay는 privileged 최종 확인에서만 | — | 비privileged gate는 항상 `data-form=panel` |
| S-04 | `HumanGateSurface` 결정 버튼 | 순서 [Reject][Request changes][Approve], Approve만 primary·오른쪽 끝 | — | DOM 순서 고정 |
| S-05 | 모든 서랍·모달 | 열면 첫 입력에 포커스, 닫으면 열었던 노드로 포커스 복귀, 모달은 포커스 가둠 | — | Esc 후 activeElement 확인 |
| S-06 | 레이어 색 | 배경 → 캔버스 위 카드 → 서랍 → 모달 순으로 한 단계씩 밝게(`layer01..03` 토큰). 상호작용 테두리는 배경 대비 3:1 이상 | 3:1 | 대비 계산 테스트 |
| S-07 | 크기 | toolbar 48px, status strip 32px, 노드 200×80, 간격은 2/4/8/12/16/24/32만, radius 2/4/8만 | — | CSS에 토큰 밖 값 없음(lint) |
| S-08 | 글자 | 5단계만: 12/16, 14/18, 14/18 600, 16/22, 20/28. 시각·id·수치는 tabular-nums | — | CSS에 다른 font-size 없음(lint) |

## 5.4 신호·상태·영수증 요구

| ID | 대상 (코드) | 요구 | 값 | 검증 |
| --- | --- | --- | --- | --- |
| N-01 | interrupt 도착 | ✅ 2026-10-02(개정2): **우측 상단 알림 토글 + 개수 배지** — 열면 현재 인터럽트 목록(각각 Go to node), 목록은 projection의 현재 사실이며 상류 해소 시에만 줄어듦. 본문이 Execution·Terminal이어도 토글은 보임 | 자동 소멸 없음 | Execution 화면에서 interrupt fixture → 토스트 보임 |
| N-02 | `backend-unreachable` | 상태가 5초 이상이면 상단 고정 warning 배너, 복구 전 닫기 없음 | 5s | fixture로 upstream 끊고 5초 후 배너 |
| N-03 | 모든 상태 표시(노드, 패널, 하단 strip) | 색 + 글리프 + 텍스트 세 가지 동시. zoom < 0.5에서도 글리프·색은 유지 | 3요소 | 색을 제거해도 상태 판별 가능 |
| N-04 | 색 배정 | amber는 attention 전용. portal·pending은 amber·accent와 다른 색, 서로 3:1 이상 | 3:1 | 토큰 대비 테스트 |
| N-05 | `generic-send-*`, `inspector-*`, `gate-*` 송신 버튼 | 버튼 자리에 inline loading: "Sending…" → "Confirmed"(projection이 반영한 뒤에만) / "Not confirmed — 사유 [Restore]" | Confirmed 1.5s 후 사라짐 | relay 성공만으로는 Confirmed가 안 나옴 |
| N-06 | `relay-error` | 액션 하나(Restore) + ✕. Discard는 원래 입력란 옆 inline으로 | 폭 288px | 토스트 내 버튼 2개(Restore, ✕) |
| N-07 | 하단 counts | needsYou를 맨 앞·가장 높은 대비로 | — | DOM 순서 첫 번째 |

## 5.5 결정·문구 요구

| ID | 대상 (코드) | 요구 | 값 | 검증 |
| --- | --- | --- | --- | --- |
| D-01 | 모든 막힌 버튼 (`root-action-*`, `generic-send-*`, `inspector-*`, `gate-*`, `session-*`) | 막힌 이유를 화면에 보이는 텍스트로 + `aria-describedby`. title 툴팁만으로는 불충분 | — | 막힌 버튼마다 describedby 대상 존재 |
| D-03 | 위험 행동 (`inspector-cancel`, `session-kill`, `terminal-kill`, privileged `gate-approve`) | 확인 3단계(없음 / danger modal / danger modal + 사유 + 대상 이름 입력) 중 하나로 분류해 적용. 위험 버튼에 기본 포커스 없음 | — | 표에 분류 없는 위험 행동 없음 |
| D-04 | evidence가 필요한 행동 | Approve 옆에 "Evidence viewed n/m" | — | 열람 수에 따라 변함 |
| D-05 | 행동 라벨 (`root-action-*`, `generic-send-*`) | wiring config에 사람 라벨이 있으면 그것, 없으면 action 원문. UI가 번역하지 않음 | — | config에 없는 action은 원문 그대로 |
| D-06 | 모든 입력 (`generic-text-*`, `instruct-input`, `gate-reason-input`, `stdin-input`) | 보이는 라벨(placeholder로 대체 금지), 필수면 "(required)" | — | 입력마다 `<label>` 존재 |
| D-07 | UI 문구 | sentence case. ALL CAPS 금지 | — | "STALE", "INPUT NOT CONFIRMED" 등 제거 확인 |
| D-08 | 포커스 | 흰색 2px 링, 캔버스 노드 포함. 선택(파랑)과 별개 | 2px #ffffff | Tab으로 이동 시 링 보임 |

## 5.6 입력 규약 (2026-10-10)

캔버스의 포인터 버튼은 할 일이 하나씩 정해져 있다. 무엇 위에서 눌렀는지와 관계없다.

| ID | 입력 | 동작 | 검증 |
| --- | --- | --- | --- |
| I-01 | 왼쪽 버튼 | 요소 조작: 노드·그룹·개인 항목을 누르면 선택하고, 끌면 옮긴다. 빈 곳을 끌면 화면이 움직이고, 빈 곳을 누르면 선택이 풀린다 | e2e: 노드 끌기 → 노드만 이동, 카메라 불변 |
| I-02 | 가운데 버튼 드래그 | 화면 이동만 한다. 노드·그룹·개인 항목·잇기 모드 위에서도 같다. 선택은 바뀌지 않는다. 브라우저 기본 동작(자동 스크롤·붙여넣기)은 막는다 | e2e: 노드 위 가운데 드래그 → 카메라 이동, 노드 자리·선택 불변 |
| I-03 | 휠 / 트랙패드 핀치 | 줌 | e2e: 휠 → 배율 변화 |
| I-04 | 오른쪽 버튼 | 메뉴(생성·삭제 등). 누른 채 끌어서 고르고 떼면 실행한다 | 기존 context-menu e2e |
| I-05 | 그 밖의 버튼(뒤로·앞으로) | 캔버스에서는 아무 동작도 하지 않는다 | — |

보기 조작(I-02, I-03)은 네트워크 요청을 보내지 않는다.

## Carbon을 그대로 따르지 않는 곳 (불변식 우선)

- 주의 표시: Carbon은 중요 알림에 400ms를 권하지만 interrupt는 첫 프레임에 그린다(M-16).
- 낙관적 성공: inline loading의 success는 upstream 확인 뒤에만(N-05).
- AI glow: 쓰지 않는다. 등급은 라벨·테두리로만 구분.
- 상태 색: Carbon 팔레트를 가져오지 않고 "한 색은 한 의미"로 재배정(N-04).
- disabled 대비 면제: 적용하지 않는다. 막힌 이유는 운영 정보다(D-01).
- 배너: 연결 장애 배너는 스크롤되지 않고 상단 고정(N-02).
- 버튼 라벨: action 이름은 백엔드 어휘라 UI가 번역하지 않는다. 사람 라벨은 config 데이터로만(D-05).
