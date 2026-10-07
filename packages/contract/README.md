# @gunnflow/contract

Gunnflow가 소유하는 백엔드 계약. 타입, 런타임 validator, 어댑터용 conformance 스위트를 담는다.
런타임 의존성은 없다(conformance 스위트만 vitest를 선택적 peer로 요구).

## 소비 방법

- **모노레포 내부**: `"@gunnflow/contract": "workspace:*"` — 소스(`src/`)를 직접 해석한다.
- **외부 프로젝트(현재)**: tarball 또는 파일 의존.
  ```sh
  pnpm --filter @gunnflow/contract build
  pnpm --filter @gunnflow/contract pack --pack-destination <dir>
  npm install <dir>/gunnflow-contract-0.3.1.tgz   # 또는 "file:<경로>"
  ```
  pack 시 `publishConfig`가 적용되어 exports가 빌드 산출물(`dist/`, `.d.ts` 포함)을 가리킨다.
- **향후 publish**: 같은 `publishConfig`로 레지스트리에 올린다(현재 `private: true`).

```ts
import { CONTRACT_VERSION, validateIntent, lookupCapability, type Intent } from '@gunnflow/contract';
```

## direct wire

어댑터 없이 계약을 네이티브로 말하는 백엔드의 HTTP 규약은 [WIRE.md](./WIRE.md)에 있다
(경로·이벤트 이름은 `DIRECT_WIRE`로 코드에도 고정). Gunnflow BFF는 `upstream: "direct"`로 붙는다.

## conformance 스위트

백엔드 작성자는 자기 백엔드를 계약 형태로 비추는 `ConformanceTarget`을 만들어 주입한다.
스위트는 정식 형태만 검사한다 — 계약 형태로 말하는 것은 백엔드의 몫이다.

```ts
// my-backend.conformance.test.ts (vitest)
import { defineConformanceSuite } from '@gunnflow/contract/conformance';

defineConformanceSuite('my-backend', async () => ({
  contractVersion: '0.3.1',
  nodes: () => myBackend.nodes(),            // { id, capabilities, artifacts, streams? }[]
  relay: (intent) => myBackend.relay(intent), // 전달 전에 validateIntent로 구조 검사할 것
  settle: () => myBackend.idle(),             // 선택: 비동기 반영 대기
  streams: {                                  // 선택: stream을 선언하는 백엔드
    open: (nodeId, streamId, lastSeenSeq) => myBackend.openStream(nodeId, streamId, lastSeenSeq),
    produce: (nodeId, streamId, count) => myBackend.emit(nodeId, streamId, count),
    declareLoss: (nodeId, streamId, count) => myBackend.drop(nodeId, streamId, count),
  },
}));
```

검사 항목: 버전 호환(엄격 semver), 노드 구조(kind·state·relations·attention·capability·artifact·
stream, 노드 내 id 중복, edit 대상·evidence의 실재), 부재 노드·미선언 action·스키마 외 키·
disabled/hidden action·짝 규칙 위반·필수 input 누락 intent의 거부, digest 규약, stream의 resync
선행·음수 없는 seq 연속·upstream 전용 gap·재개. 해당 노드가 없는 항목은 skip으로 표시되지만,
`features`로 edit/stream을 선언한 어댑터가 시험 대상을 내놓지 않으면 실패한다.
참고 구현: `testing/fake-contracts/test/conformance.test.ts`.

## 보장 범위

conformance 통과가 **증명하는 것**: 어댑터가 내보내는 projection·intent 처리·stream이 계약의
구조를 지킨다는 것 — 스키마와 짝 규칙, 거부해야 할 intent의 거부, digest 규약(전송 UTF-8 bytes의
sha256), stream seq의 연속성과 gap 귀속.

**증명하지 못하는 것**: 조종석 런타임의 성질은 백엔드 conformance의 대상이 아니다.
- relay가 인간 전용이라는 것(AI가 커밋 채널을 갖지 않음)
- attestation의 진실성(표시 기록이 실제 표시를 반영함)
- viewer 격리(isolated origin·sandbox·CSP)
- 백엔드 판단의 옳고 그름(거부 사유의 타당성, 상태의 의미)
이들은 Gunnflow 코어의 테스트와 불변식이 지킨다.

## digest 규약

`digest` = 원본 bytes의 **sha256 소문자 hex**. `Intent.edit.body`는 **UTF-8로 직렬화한 bytes 그대로**
(BOM 없음, 줄바꿈 무변환)가 digest 대상이며, 백엔드가 저장한 산출물의 digest와 일치해야 한다.
`digestOfBody(body)`가 이 규칙의 기준 구현이다.

## 버전 정책

`CONTRACT_VERSION`은 semver이며, 0.x 동안에는 minor가 다르면 호환되지 않는 것으로 본다(스위트가 major.minor 일치를 검사).

> 0.2.0: adds the optional node-detail surface (`NodeDetail`, `validateNodeDetail`, `DIRECT_WIRE.detail`, WIRE.md §detail). Additive, but 0.x compatibility is minor-strict: consumers must re-pack and claim `contractVersion: '0.2.x'`.

> 0.3.1: packaging only — the optional `vitest` peer (used by the conformance suite) now accepts `^3 || ^4 || ^5`. No contract change; consumers claiming `0.3.x` need nothing.
>
> 0.3.0: adds the optional execution surface (`ExecutionSnapshot`, `validateExecutionSnapshot`, `DIRECT_WIRE.execution`, WIRE.md §execution — GET + SSE full-snapshot republish). Additive, but 0.x compatibility is minor-strict: consumers must re-pack and claim `contractVersion: '0.3.x'`.
