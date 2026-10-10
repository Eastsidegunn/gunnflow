# 노드 모양 (Node shapes) — 기능·시나리오 (GF-P1b D)

요구(고정): **"종류(kind)마다 모양과 크기를 다르게 줄 수 있다. 기본은 지금의 사각형이다. 컨테이너는 넓은 띠로 그릴 수 있다."**
제약(고정): 엔진은 kind의 뜻을 모른다 — 모양은 wiring config가 kind에 붙이는 데이터다. 보기 조작은 네트워크 0.
노드 모양은 의미를 만들지 않는다: 같은 kind는 같은 모양일 뿐, 모양이 상태·위험·우선순위를 말하지 않는다
(그건 수신한 state·attention의 몫 — 글리프·톤·주의 표시가 그대로 맡는다).

## 1. 기능 정의

- **입력**: 노드의 kind(수신, 불투명 문자열) + wiring의 `kinds[kind].shape`(선택) + 화면 배율.
- **출력**: 캔버스에 그 kind의 노드를 해당 모양·크기로 그린다. 간격·드롭 해소(B)·줌 닻(C)은
  노드 상자(모양 + 옆 제목 띠)를 쓰고, 히트 테스트는 윤곽 안쪽과 옆 제목 띠만 노드로 본다
  (마름모·원·알약의 모서리는 빈 캔버스).
- **행동 칩**: 칩 줄을 담을 높이가 있는 상자(기본 사각형 이상)에만 그린다. 원·마름모·알약에는
  칩이 없다(승인된 목업 ②) — 행동은 우클릭 메뉴와 stage에서 그대로 쓸 수 있다.
- **엔진이 안 하는 것**: kind로 모양을 추측하지 않는다(config 없으면 사각형), 모양으로 뜻을 표시하지 않는다.

## 2. 사람의 작업 흐름에서 출발한 시나리오

설계의 결 4: "멀리서는 색·크기·전선이 정보, 가까이서 글." 모양은 **멀리서** 일하는 장치다.

1. 사람이 아침에 조종석을 연다. 첫 화면은 자기 몫 목록이고, 그래프는 선택 주변만 보인다(결 4).
   멀리서 보면 글은 읽히지 않는다. 그래도 **어떤 종류가 어디에 몰려 있는지**는 한눈에 보여야 한다:
   작은 원이 잔뜩 = 잘게 쪼갠 작업, 큰 마름모 하나 = 사람이 통과해야 할 관문, 넓은 띠 = 묶음(미션).
2. 사람이 휠로 한 단계씩 들어간다(C). 닻에서 한 번 멈출 때 모양은 그대로이고, 라벨이 한 번
   나타난다. 모양이 바뀌면 "다른 것이 됐다"고 착각한다 — **배율이 바뀌어도 모양은 바뀌지 않는다**
   (크기만 배율에 따라 커진다).
3. 사람이 노드를 끌어 옮긴다(B). 원은 원끼리, 띠는 띠끼리 간격을 지킨다 — 드롭 해소가 모양의
   경계 상자로 겹침을 판단한다.
4. 컨테이너(미션)는 **넓은 띠**: 가로로 길고 위에 이름 띠. 그 안의 노드들은 한 줄 또는 몇 줄로
   흐른다. 시선이 띠를 따라 왼쪽→오른쪽으로 흐르며 진행 방향(수신된 흐름 관계)을 읽는다.
5. 가까이 가면(라벨 문턱 위) 모든 모양 안에 지금처럼 글리프·라벨·상태·행동 이름이 들어간다.
   작은 원은 가까이서도 작을 수 있으므로, 원 안에 글이 들어가지 않으면 **원 옆에** 라벨을 쓴다
   (모양을 찌그러뜨려 글을 넣지 않는다).

## 3. 열린 선택지 ([H] 결정 필요)

| # | 질문 | 선택지 | 권고 |
| --- | --- | --- | --- |
| D-1 | 모양 어휘 | (a) 닫힌 소형 집합: `rect` `pill` `circle` `diamond` `hexagon` (b) 임의 SVG path 리터럴 | **(a)** — 히트 테스트·간격·드롭 해소가 모양마다 정확해야 하고, 부품 심사 3항목(닫힌 소형 param)에 맞는다. 표현이 더 필요하면 iframe 쪽(보증 불요 영역). |
| D-2 | 크기 | (a) kind별 배율 하나 `size: 0.5~3` (b) kind별 `w`·`h` 픽셀 | **(a)** — 가로세로 비는 모양이 정하고(원 1:1, 띠는 가로로 길다), 사람은 "크게/작게"만 정한다. |
| D-3 | 컨테이너 띠 | (a) 컨테이너 kind에 `shape: "band"` — 가로 우선 배치 + 위 이름 띠 (b) 지금의 상자 유지, 배치만 가로로 | **(a)** — 띠는 모양이자 배치 힌트(가로 흐름). 기본은 지금 상자. |
| D-4 | 작은 모양의 라벨 | (a) 모양 안에 안 들어가면 옆에 (b) 항상 아래 | **(a)** |

## 4. 계약 영향 (additive, [H] 승인 필요)

`@gunnflow/contract/wiring`의 `kinds[kind]`에 선택 필드 두 개:

```jsonc
"kinds": {
  "task":    { "parts": [...], "shape": "circle", "size": 0.6 },
  "gate":    { "parts": [...], "shape": "diamond", "size": 1.4 },
  "mission": { "parts": [...], "shape": "band" }
}
```

- 없으면 지금과 같다(사각형, 배율 1) — 기존 config는 그대로 유효.
- 검증: `shape`는 닫힌 집합, `size`는 0.5~3. 범위 밖·미지 값은 config 오류(다른 필드와 같은 규칙).
- wire(노드·detail·intent)는 무변경. 백엔드 몫 0.
- 버전: 계약 마이너 올림(0.4.x → 0.5.0), 게시는 [H] 묶음 때.

## 5. 목업 이미지 생성 프롬프트 (이미지 생성 모델용)

색은 프리셋일 뿐 — 레이아웃과 모양의 의도만 본다.

1. **멀리서 (줌 아웃, 라벨 없음)**: "Dark-themed node graph cockpit, zoomed far out, no text visible. Three wide horizontal rounded bands
   (missions) stacked vertically, each with a thin title strip on top. Inside each band, small circles (tasks) flow left to right connected
   by thin lines; one large diamond (a gate) sits at the right end of the second band with an amber glow ring. A few medium pills
   (deliverables). Colors only as accents. Clean, minimal, high contrast, 16:9."
2. **가까이 (줌 인, 라벨 있음)**: "Same cockpit zoomed in on one band. Circles now show a small glyph inside and the label to the right
   of each circle; the diamond shows its glyph and label inside; pills show a label inside. A thin zoom tick scale at the bottom right
   corner with one larger tick marked. Dark theme, minimal, 16:9."
3. **끌어 옮기기**: "A circle node being dragged onto another circle inside a band; a faint outline shows where it will settle beside
   the other circle with a small gap. Dark theme, minimal, 16:9."

## 6. 구현 순서 (승인 뒤)

1. 계약: `kinds[kind].shape/size` 타입·검증·conformance 테스트.
2. 엔진: 모양별 경계 상자(크기) → 레이아웃 입력 / 그리기(path) / 히트 테스트(모양 안쪽) / 라벨 자리(D-4).
3. 띠: 컨테이너 가로 우선 배치(기존 pack 경로에 가로 비율 힌트).
4. B·C 연동: 드롭 해소·줌 닻이 새 경계 상자를 쓰는지 e2e로 확인.
5. 성능: 노드 500에서 줌·팬 60fps, 네트워크 0 — devtools 캡처 1장(GF-P1b 공통 완료 기준).
