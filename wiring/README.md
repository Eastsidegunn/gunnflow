# wiring/

이 디렉토리는 **사용자 본인의** wiring 파일 자리다. 저장소는 여기에 아무 config도 싣지 않는다
(`wiring/*.json`은 gitignore — 이 README만 추적). 백엔드별 예시는
[`examples/wiring/`](../examples/wiring/README.md)에 있고, 복사해 넣거나 `wiringDir`을 그쪽으로
가리켜 쓴다. 설정 화면에서 저장한 사용자 편집본은 `90-user.json`으로 이 디렉토리에 남는다.

이 디렉토리의 `*.json` wiring config 파일은 전부 읽혀 **파일명 정렬 순**으로 기본 config
위에 병합된다(앞에 오게 하려면 `10-…`, `20-…`처럼 번호를 붙인다). 파일이 없으면 기본
config만 쓴다. 위치는 `gunnflow.config.json`의 `wiringDir` 또는 env `GUNNFLOW_WIRING_DIR`로 바꿀 수 있다.

병합 규칙:

- `render` · `relations` · `viewers` · `kinds` · `actions`: 키 단위 덮어쓰기 — 뒤 파일의 같은 키가 항목 전체를 대체, 새 키는 추가.
  (`actions`는 행동 이름별 표시 라벨 `{ "label": "…" }` — 없으면 버튼에 원문 이름.)
- `attention`: cause 단위 — 같은 cause는 뒤 파일 규칙이 그 자리에서 교체, 새 cause는 뒤에 추가(첫 일치 우선 유지).
  `group`(표시 무리 이름, 선택)을 말하지 않은 교체 규칙은 앞 규칙의 `group`을 이어받는다.
  단 `group`을 하나라도 말하는 파일은 무리 순서를 말한 것으로 본다: 그 파일의 규칙이 그 순서대로 앞에 서고,
  그 파일이 말하지 않은 앞 파일의 cause가 뒤를 잇는다(결정함·토글의 무리 순서 = 병합 결과에 처음 나온 순서).
- `detail`: 목록 단위 대체 — 뒤 파일이 말한 `emphasis`(강조) · `collapsed`(기본 접힘) · `copyable`(바이트 그대로
  복사 상자) 목록이 그 목록 전체를 새로 말한다(label 원문 일치). 말하지 않은 목록은 앞 파일 것이 남는다.
  목록을 하나도 말하지 않은 `"detail": {}`은 예전 뜻 그대로 앞 파일의 detail 전체를 대체(비움)한다.
- 파일마다 `validateWiringConfig`로 따로 검사하고, 불합격 파일은 건너뛴다(사유는 화면 디버그 요약과 콘솔에 남는다).
- 병합 결과를 다시 전체 검사한다. 불합격이면 기본 config로 돌아가고 사유를 표시한다.

예시 (`20-triage.json`):

```json
{
  "version": "0.1.0",
  "render": { "triaged": { "glyph": "diamond", "tone": "accent" } },
  "relations": { "blocks": { "style": "bold" } },
  "attention": [{ "match": { "cause": "escalated" }, "mechanism": "interrupt" }]
}
```

백엔드가 자기 어휘용 wiring 초안을 제공하면(예: `examples/wiring/`), 그 JSON을 이 디렉토리에 복사해 넣는 것으로 적용된다.
