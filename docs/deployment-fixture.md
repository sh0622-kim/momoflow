# 최초 격리 설치와 A/B 준비

상태: GH-16 준비 경로와 GH-18 fixture 전용 인증 분리 후보. 아래 명령은 **외부 운영자용**이며 이 코딩 세션에서 실행하지 않았다.
일반 배포의 GitHub 자격 검사는 [배포 정책](deployment.md)을 그대로 따른다.
`8dc068b7cd837d734a406c48e0ca13fafe48fc84`는 정책 변경을 포함하므로 일반 배포 후보로
승격하지 않는다. admission이 없는 운영 버전에서 이 버전으로 넘어가는 작업은 별도 설치다.
GH-16은 운영 배포를 승인하지 않는다.

| 경로 | 필요한 근거 | 증명하는 범위 |
| --- | --- | --- |
| 최초 설치 | 외부 운영자가 검토한 고정 소스/이미지/설정, 빈 격리 자원, 설치 전 mount 비교 | admission 지원 실험 환경 준비. 정상 배포 횟수 0 |
| `kind:github` integration | 서로 다른 일반 적격 A/B, 각 방향의 실제 merge/review/host receipt | 일반 자격 gate와 실제 교체·복구 |
| `kind:fixture` integration | 아래 로컬 Git/image/build/smoke provenance | 실 Docker 상태 머신·교체·복구. 일반 GitHub 배포 gate는 미검증 |

fixture는 동일 실행 코드에 버전 표식만 추가한 복제본이다. 서로 다른 commit과 image ID를
실제로 사용하지만 기능 변경의 배포나 실제 모델 작업의 검증으로 표현하지 않는다.
fixture provenance는 GitHub 리뷰·병합·host receipt 형식이 아니며 이를 생성하거나 위조하지 않는다.
일반 `deploy.mjs`는 fixture 요청을 거부한다. fixture 실행 결과는 private journal에만 기록한다.
일반 자동 배포 전환의 모든 조건 충족을 이 실험만으로 선언하지 않는다.

## 고정 소스에서 버전 만들기

먼저 이 변경의 별도 리뷰를 끝내고, 검토된 controller commit을 외부 clean checkout
`/operator/momoflow`에 설치한다. 실행 중인 엔진의 workspace를 사용하지 않는다.
아래 예의 `/operator/fixture-source`는 검토된 원본 저장소의 로컬 checkout이다.
새 외부 저장소나 모델 호출이 필요하지 않다. A/B와 evidence 경로는 새 경로여야 한다.

```sh
fixture_source=8dc068b7cd837d734a406c48e0ca13fafe48fc84
for fixture_version in A B; do
  git clone --no-hardlinks --no-checkout /operator/fixture-source "/operator/fixture-$fixture_version"
  git -C "/operator/fixture-$fixture_version" checkout --detach "$fixture_source"
  printf '%s\n' "$fixture_version" > "/operator/fixture-$fixture_version/.momoflow-fixture-version"
  git -C "/operator/fixture-$fixture_version" add .momoflow-fixture-version
  GIT_AUTHOR_DATE=2026-10-23T00:00:00Z GIT_COMMITTER_DATE=2026-10-23T00:00:00Z \
    git -C "/operator/fixture-$fixture_version" -c core.hooksPath=/dev/null \
      -c user.name=MomoflowFixture -c user.email=fixture@example.invalid \
      commit -m "isolated deployment fixture $fixture_version"
done
# Runtime provenance reader needs BOTH commit objects in a single local repository.
git -C /operator/fixture-A fetch /operator/fixture-B HEAD
node /operator/momoflow/scripts/deploy-fixture-prepare.mjs "$fixture_source" \
  /operator/fixture-A /operator/fixture-B /operator/fixture-evidence
```

prepare는 효과 전에 두 checkout의 clean 상태, source 단일 parent, 추가 파일 하나와 A/B
바이트를 검사한다. 변경 허용은 `.momoflow-fixture-version` 하나뿐이다. 각 tree에서 기본
Dockerfile/기본 build 인자로 이미지를 빌드하고 source/commit/tree/scope label을 붙인다.
label 차이로도 서로 다른 image ID가 생기며 실행 코드·권한은 같다. 각 이미지 자체에
`smoke.sh`를 실행하여 readiness, 실제 Codex sandbox, 모의 worker 역할 계약을 검사한다.
smoke는 네트워크 없는 일회용 컨테이너를 사용하며 운영 인증/볼륨·모델을 사용하지 않는다.

산출물은 `provenance.json`, 이미지 ID 파일 두 개, 바이트 SHA256 이름의 `logs/`다.
provenance에는 source, A/B commit/tree/runner 바이트 hash/image ID와 build/smoke 로그 hash가
있다. 출력의 `{path,hash}`를 request의 `evidence`로 사용한다. 실패 시 완성 provenance를
쓰지 않으며 부분 로그/이미지는 조사 후 정리한다. 로그 내용은 private이고 공개 기록에는
검사 결과·hash만 남긴다. image label은 서명이 아니다. 신뢰 근거는 외부 운영자 소유 파일과
검토된 preparation 실행이다. provenance 파일을 수기로 성공 근거로 만들지 않는다.

## 인증 없는 최초 설치와 정상2·복구1 (GH-18 후보)

이 변경은 #18에서 명시 승인한 **fixture 전용 검증 설계 변경**이다. 별도 리뷰와 고정
controller 설치 이후 사용한다. 일반 운영 배포의 Codex login, token-file GitHub 읽기,
두 서비스와 GitHub 자격 gate는 유지한다. 운영 배포·일반 자동 승격을 승인하지 않는다.

| 경계 | fixture에서 실행하는 검사 | 미검사 |
| --- | --- | --- |
| Docker | 실제 A/B image·security·health·dashboard/state, 최초 설치의 실제 sandbox | 운영 배포 |
| 교체/복구 | 동일 pause→drain→preserve→replace→verify→resume 및 실패 시 rollback | 실제 모델 작업 |
| 실행 차단 | internal network, 고정 비자격 sentinel, 빈 Codex/launch/inbox, absent manifest, 빈 role ledger | GitHub dispatch·merge/review gate |
| 인증 | 후보에 인증 mount/service/tokenFile 없음; 새 로그인·새 App 불필요 | 후보 Codex login, 실제 GitHub token 읽기·갱신 |

sentinel `smoke-not-a-credential`은 기존 smoke와 같은 비자격 값이며 실인증으로 기록하지
않는다. `GITHUB_REPO=smoke/fixture`도 고정한다. `WORKFLOW.md`와 seccomp 바이트는 fixture
source에서 가져와 재검사한다. 모델·추론·Fast·권한·예산을 변경하지 않는다. 후보가 접수를
재개해도 외부 통신과 trusted launch를 사용할 수 없다. 기존 role/controller/launch 소유권과
활성 작업·generation 확인은 그대로 수행하며 ledger를 만들거나 초기화하지 않는다.

### 기존 A/B 근거 재사용

[PR #17의 외부 근거](https://github.com/sh0622-kim/momoflow/pull/17#issuecomment-6359207440)는
A `2efb7cd8a3f8750f8c37821cd36df34fed8317bc`,
B `61bc90707b27a2dd80917eff44d119bd2496c465`, source
`8dc068b7cd837d734a406c48e0ca13fafe48fc84`에서 build/readiness/실 sandbox/모의 role89 통과를
보고했다. provenance digest는 `5e9bf1c860599044ccb7e9a4e096207fcadc1ae8bfd30166cef19d0f7bfa7684`다.
이 댓글은 전체 교체·복구나 실인증 성공 근거가 아니다.

기존 호스트의 `.data/gh16-integration/evidence-helper/provenance.json` 및 같은 디렉터리의
`logs/`, A/B image, 두 commit이 들어 있는 로컬 Git 저장소를 보존한다. 아래 installer는
재빌드 없이 parent/marker/tree/runner source, immutable image ID/label, build/smoke log hash를
다시 검사한다. 하나라도 없거나 다르면 중단한다. 수기로 provenance를 만들지 않는다.
재사용 불가할 때에만 앞 절의 prepare로 새 근거를 만든다. 새 controller의 검사 결과와
기존 image smoke의 소스/시점은 구분한다.

### 호스트에서 실행

검토된 새 controller의 **clean 고정 checkout**을 `/operator/momoflow`에 설치한다.
이 도구는 컨테이너 내부 실행을 거부한다. host UID1000과 Docker 접근이 필요하다. Docker
Desktop의 daemon volume backing path는 호스트 realpath가 아닐 수 있으므로 named volume은
`volume inspect`의 driver/options/Mountpoint로 비교한다. local 기본 volume만 허용한다.
경로가 불확실하거나 alias/plugin 옵션이 있으면 권한·검사를 넓히지 않고 중단한다.

아래 JSON 하나만 준비한다. 실제 absolute/canonical 경로·기존 운영 container ID/project와
비어 있는 loopback port를 넣는다. `root`는 존재하지 않아야 하며 부모는 operator 소유,
canonical, group/world write 금지여야 한다. request/bundle을 수기로 구성하지 않는다.

```json
{
  "root":"/operator/gh18-isolated",
  "port":4408,
  "evidence":"/operator/gh16-integration/evidence-helper/provenance.json",
  "repository":"/operator/fixture-A",
  "integration":{
    "productionEngine":"<기존 운영 symphony container ID>",
    "productionAuth":"<기존 운영 github-auth container ID>",
    "productionProject":"<기존 운영 Compose project>"
  }
}
```

```sh
# UID1000의 신뢰된 host shell. config 파일은 chmod 600.
node /operator/momoflow/scripts/deploy-fixture-install.mjs /operator/install-gh18.json
# 성공 출력의 plan 경로 사용. 설치 자체는 정상 배포 횟수 0.
node /operator/momoflow/scripts/deploy-integration.mjs /operator/gh18-isolated/plan.json
```

Docker 설정 디렉터리가 별도라면 JSON에 `dockerConfig` absolute path를 추가할 수 있다.
이 설정은 trusted host Docker CLI에만 사용하며 후보에 mount/env로 전달하지 않는다.

installer는 효과 전에 source/images/logs, 운영 mount·port와 prospective control 경로를
대조한다. 새 무작위 `momoflow-deploy-test-...` project와 data/Codex local volume 2개만
생성한다. token volume, auth service, 개인 키 mount는 없다. 빈 root-owned volume 두 개를
모두 검사한 후 network none·read-only·CHOWN만 있는 일회용 helper가 UID1000/mode700과
`/data/log`, `/data/workspaces`를 준비한다. 기존 volume이나 운영 인증을 수정하지 않는다.
후보 런타임은 비루트·cap_drop ALL·no-new-privileges·기존 seccomp를 유지한다.

고정 source의 WORKFLOW 두 파일, seccomp, Compose 두 파일, expected runtime identity,
고유 ID의 A→B/B→A/A→B 요청 3개와 plan을 자동 생성한다. single-service A를 최초 설치해
paused ack/role/manifest, exact image/security/health와 실제 sandbox를 검사한다.
sandbox probe는 일회용 `/tmp` CODEX_HOME을 사용하여 빈 인증 볼륨에 상태를 쓰지 않는다.
`installed.json`은 최초 설치 성공만 뜻한다. image labels와 Compose가 현재 도구와
호환되지 않으면 설치를 중단하며 과거 smoke를 현재 설치 성공으로 표시하지 않는다.
installer는 고정 Compose 표면을 먼저 검사하고 실제 `compose config --format json`의
결과를 다시 검사·저장한 후 해시를 고정한다. compose-go가 false 기본값을 생략한
`bind: {}`는 fixture에서만 허용한다. host path 자동 생성(`create_host_path: true`)은
허용하지 않으며 일반 배포의 기존 bind 검사는 유지한다.

integration은 세 요청 전체의 chain/ID/파일·양방향 근거를 **첫 pause 전에** 검사한다.
이후 기존 live previous와 각 배포 사전 검사를 재확인한다. 세 번째 후보만 의도적으로
stop해 동일 verify timeout/rollback 경로를 통과시킨다. 예상 private journal phase는
`complete`, `complete`, `rolled_back`이며 auth/model/githubGate는 모두 `not-exercised`다.
일반 CLI에는 fixture/skip-auth/fault 옵션이 없다.

새 root 생성 이후 실패하면 `installation.json`, 생성된 파일·자원·journal을 보존한다.
`installation.json`은 원자적으로 갱신되는 private(mode600) 설치 journal이다.
현재 stage와 `preparing`/`failed`/`installed-paused`, 명령별 `attempted`/`completed`/
`failed`/`spawn-failed`, 종료값, 출력의 해시·바이트 수를 남긴다. 명령 시도는 실행 전에
기록하므로 중단 후 `attempted`만 남으면 실제 효과를 확인해야 한다. raw inspect/Env,
명령 인자와 출력 원문은 저장하지 않는다. stderr는 안전한 검사 이유·stage·종료값과
journal 경로를 알린다. root 생성 전 실패는 journal이 없음을 명시하며 기존 root의
기록을 덮어쓰지 않는다. 성공 시에도 `installed-paused`는 최초 설치이고 정상 배포 횟수는 0이다.
같은 root에 installer나 전체 integration을 자동 재실행하지 않는다. 이미 실행된 요청의
재호출은 기존 단일 요청 상태 머신 규칙을 따르며 새 ID로 실패를 숨기지 않는다.
복구가 불명확하거나 작업이 활성인 경우 gate를 held로 두고 외부 운영자가 실제 상태를
조사한다. 현재 도구에는 임의 restart/초기화·강제 정리 기능이 없다.

### 기존 인증 상태가 필요한 경우의 별도 최소 읽기

fixture 실행을 위한 새 로그인·App·인증 복제는 필요 없다. 기존 운영 인증 상태를
확인해야 할 별도 이유가 있을 때에만 trusted host에서 **이미 운영 중인 서비스**를
읽는다. 아래 probe는 키·토큰을 출력/복사하지 않고 기존 auth 서비스의 토큰 파일과
읽기 API 한 번만 사용한다. 후보에는 파일·env·키·Codex 인증을 전달하지 않는다.

```sh
# 위 config의 기존 운영 container ID를 production_engine/production_auth 변수로 지정한다.
docker exec "$production_engine" codex login status
docker exec "$production_auth" node -e '
const fs=require("fs");
const x=JSON.parse(fs.readFileSync("/run/momoflow-auth/token.json"));
if(typeof x.token!=="string" || !(Date.parse(x.expires_at)>Date.now()+60000) ||
   x.repository!==process.env.GITHUB_REPO) process.exit(2);
fetch("https://api.github.com/repos/"+process.env.GITHUB_REPO+"/issues?per_page=1",{
 headers:{Authorization:"Bearer "+x.token},signal:AbortSignal.timeout(5000)
}).then(r=>process.exit(r.ok?0:3)).catch(()=>process.exit(4));'
```

기존 호스트의 이 결과도 **운영 기존 인증 최소 읽기**로 별도 기록한다. 후보 인증·갱신,
새 Codex 세션, 실제 모델, 일반 배포 gate 통과로 확대하지 않는다. token 갱신/키 서명 자체를
이 probe가 검증하지 않으며 토큰이 없거나 만료됐다면 미검사/실패를 그대로 기록한다.

## 증거, 작업 보호와 정리

| 검사 | 보존할 실제 근거 |
| --- | --- |
| 준비/설치 | 기존 provenance/source와 새 controller SHA, A/B image IDs, 설치 JSON, config/file hashes, sandbox.log/hash, UID1000/layout 결과, mount/volume driver/options와 독립 port |
| 교체/복구 | 각 deploymentId의 event/journal, pause/drained/target/rollback/resumed admission과 config/image/security/health |
| 작업 보호 | stale generation·active/in_flight/미완료 ledger·controller/launch 소유권 중 실제로 검사한 항목과 모의 항목을 구분 |
| 운영 불변 | 설치 전 production runtimeIdentity, integration 전후 서비스 ID/runtime/role ledger 파일 hash snapshots; Env/credential 원문 없음 |
| 인증 경계 | 후보 auth/model/GitHub gate 미검사, 별도 기존 호스트 probe 실행 여부와 종료값 |
| 정리 | evidence 보존 위치, 정확한 test project/container/network/두 volume/control root allowlist와 삭제 결과 |

integration은 운영 engine/auth의 identity와 role ledger hash를 읽어
`deploymentRoot/integration-before.json`, `integration-after.json`으로 보존·비교한다.
운영에서 별도 작업이 진행돼 ledger가 달라져도 이를 자동 무시하지 않고 차이를 조사한다.
최초 설치 이후 운영 변경이 없다는 판정과 active worker 보호는 별도다. 단순 idle 정상2·복구1을
활성 모델 작업 보호 성공으로 표현하지 않는다. 실제 모델 호출 없이 실행할 수 있는
controller 소유권 실험은 첫 요청 전 별도로 `stateRoot/controller.lock`을 배타 획득한 채
`connectedFixture` preflight가 거부되는지 확인한다. 잠금 해제는 그 소유 프로세스만 수행한다.
모의 worker/ledger 계약 결과는 로컬 회귀 검사로 표시하고 실제 운영 ledger를 편집하지 않는다.

정리는 먼저 root 전체와 journal/image backup/provenance/log를 별도 보존한 뒤 수행한다.
`installation.json`의 project/두 volume, 생성된 Compose/requests의 경로만 allowlist로 사용한다.
운영 identity와 test gate/owners/ledger를 확인하고 test project의 symphony만 중지·제거한 뒤
해당 project network와 해당 두 volume을 제거한다. 마지막으로 정확한 test root만 제거한다.
실패·활성 작업·복구 불명확 시 자동 강제 정리하지 않는다. `docker system prune`, 운영
compose down, 운영 인증·ledger 삭제는 금지한다. 정리 결과도 #16에 남긴다.

이 코딩 환경에는 Docker CLI/socket이 없다. 실제 Compose config/build, installer/UID helper,
readiness/sandbox·정상2/복구1·활성 작업 보호·운영 불변·allowlist 정리는 **미실행**이다.
새로운 유료 모델 실행이나 외부 자원은 만들지 않았다. #18 구현 PR의 별도 리뷰/검사와
#16의 실험 완료는 구분한다. #16은 실제 정상2·복구1과 나머지 조건을 확인하기 전 닫지 않으며,
기존 2/3 및 terminal 기록은 보존하고 재실행 라벨이나 예산 초기화를 하지 않는다.
