# 최초 격리 설치와 A/B 준비

상태: GH-16 구현 후보. 아래 명령은 **외부 운영자용**이며 이 코딩 세션에서 실행하지 않았다.
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

## 최초 설치 (배포 성공 횟수에 포함하지 않음)

운영자는 `momoflow-deploy-test-...` project, 아래에서 새로 만들 외부 named data/Codex/token volume,
별도 gate/launch/inbox/state/deployment 경로와 loopback port를 준비한다. 운영 data snapshot을
마운트하거나 ledger/count를 초기화하지 않는다. 시작 gate는 `{v:1,generation:64hex,paused:true}`,
launch manifest는 absent다. 설치되는 WORKFLOW/권한/모델/예산은 검토된 원본을 유지한다.
read-only launch/inbox/admission, 실제 seccomp와 auth key custody는 배포 bundle 계약을 따른다.

**인증은 fixture로 대체하지 않는다.** 현재 하네스는 기존 Codex login 및 token-file GitHub 읽기
검사를 그대로 실행한다. 별도로 승인·준비된 test Codex 인증과 test GitHub App/key custody가
없으면 설치/실행을 중단하고 필요한 권한을 보고한다. 운영 키·token·Codex 인증을 복사하거나
공유하지 않는다. preparation/smoke에는 인증이 필요 없다. 모델 turn을 보내지 않는다.

먼저 새 자원 이름을 정한다. 같은 shell에서 아래 변수들을 유지하고, 세 이름을 A/B 양쪽
Compose의 external volume name 및 request의 dataVolume에 반영한다. 이미지 ID는 preparation의
A 산출물이며 이후 초기화 컨테이너도 이 고정 이미지만 사용한다.

```sh
set -eu
fixture_nonce=$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')
fixture_project="momoflow-deploy-test-$fixture_nonce"
fixture_data="${fixture_project}-data"
fixture_codex="${fixture_project}-codex"
fixture_token="${fixture_project}-token"
fixture_image=$(cat /operator/fixture-evidence/image-0.id)
```

볼륨 생성·초기화와 최초 `compose up` 전에 운영 engine **및 github-auth**의 inspect를 메모리에서 읽고,
계획된 A의 두 `inspect`에 있는 mount를 `isolatedResources()`와 대조한다. 예:

```js
import {isolatedResources} from '/operator/momoflow/scripts/deploy-fixture.mjs';
// production: 두 실제 Docker inspect 객체 (원문 Env/키는 출력하지 않는다).
// request: 아래의 운영자 고정 A→B request, previous는 설치할 A bundle.
const prospective=Object.values(request.previous.inspect).map(x=>({
  Mounts:x.mounts.map(m=>({Type:m.type,Name:m.source,Source:m.source})),
  HostConfig:{PortBindings:x.ports}
}));
isolatedResources(request,production,prospective);
```

bind source는 부모/자식 경로도 겹치면 거부한다. read-only 설정/키도 이 실험에서는 공유하지
않는다. named volume은 이름을 비교한다. 서로 다른 volume이 같은 외부 저장소를 alias하는지,
bind symlink가 같은 경로를 가리키는지도 운영자가 Docker volume inspect/canonical path로
확인한다. 다른 daemon에서 얻은 inspect로 이 검사를 대신하지 않는다.

### 빈 볼륨 초기화와 설치 전 검사

위 격리 검사를 통과한 **이번 실험의 새 allowlist 세 볼륨에만** 다음 명령을 실행한다.
`volume.nocopy:true`를 유지하므로 Dockerfile의 소유권/디렉터리가 빈 mount로 복사되지 않는다.
명령은 기본 local driver와 옵션 없는 새 볼륨을 만들며, 기존 이름이 하나라도 있으면 중단한다.
실패한 명령을 기존 볼륨에 재실행하거나 운영 볼륨을 인자로 바꾸지 않는다. 부분 생성 자원은
이름·inspect를 보존하여 조사하고 해당 실험 allowlist로만 정리한다.

초기화 helper는 네트워크·인증·host bind 없이 빈 볼륨에 디렉터리와 소유권만 준비한다.
일회용 UID 0과 CHOWN capability는 이 준비 단계에만 쓰며 engine/auth 런타임 설정은
계속 UID/GID 1000, `cap_drop:ALL`, 기존 seccomp와 `no-new-privileges`를 유지한다.
이미지 USER도 먼저 확인한다. 두 번째 helper는 UID/GID 1000, capability 없이 실제 쓰기를
검사한다. 검사 로그에는 소유권·모드·성공 여부만 남기고 인증 내용은 남기지 않는다.

```sh
# Run in the same shell, after the mount/alias comparison above, with the variables above.
set -eu
case "$fixture_image" in sha256:*) ;; *) exit 1 ;; esac
test "$(docker image inspect --format '{{.Config.User}}' "$fixture_image")" = momo
# Verify daemon access before checking absence; never reuse an existing named volume.
docker info >/dev/null
for fixture_volume in "$fixture_data" "$fixture_codex" "$fixture_token"; do
  if docker volume inspect "$fixture_volume" >/dev/null 2>&1; then
    echo 'Refusing existing fixture volume' >&2
    exit 1
  fi
done
for fixture_volume in "$fixture_data" "$fixture_codex" "$fixture_token"; do
  docker volume create --driver local --label "momoflow.fixture=$fixture_nonce" "$fixture_volume"
done
# Preserve this metadata privately with the exact allowlist. Driver=local, Options=null/{}.
docker volume inspect "$fixture_data" "$fixture_codex" "$fixture_token"
docker run --rm --pull never --network none --read-only --user 0:0 \
  --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges:true \
  --mount "type=volume,src=$fixture_data,dst=/fixture-data,volume-nocopy" \
  --mount "type=volume,src=$fixture_codex,dst=/fixture-codex,volume-nocopy" \
  --mount "type=volume,src=$fixture_token,dst=/fixture-token,volume-nocopy" \
  --entrypoint node "$fixture_image" -e '
const fs=require("fs");
const roots=["/fixture-data","/fixture-codex","/fixture-token"];
// Check ALL roots before writing; never chmod/chown existing data or authentication.
for(const p of roots) {
  const s=fs.lstatSync(p);
  if(!s.isDirectory() || s.uid!==0 || s.gid!==0 || fs.readdirSync(p).length)
    throw Error("Expected fresh empty root-owned volume");
}
for(const p of ["/fixture-data/log","/fixture-data/workspaces"])
  fs.mkdirSync(p,{mode:0o700});
// Children first: no recursive chown, symlink traversal or ledger/count creation.
for(const p of ["/fixture-data/log","/fixture-data/workspaces",...roots]) {
  fs.chmodSync(p,0o700); fs.chownSync(p,1000,1000);
  console.log(p+" uid=1000 gid=1000 mode=700");
}'
docker run --rm --pull never --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=volume,src=$fixture_data,dst=/fixture-data,volume-nocopy" \
  --mount "type=volume,src=$fixture_codex,dst=/fixture-codex,volume-nocopy" \
  --mount "type=volume,src=$fixture_token,dst=/fixture-token,volume-nocopy" \
  --entrypoint node "$fixture_image" -e '
const fs=require("fs");
for(const p of ["/fixture-data","/fixture-data/log","/fixture-data/workspaces",
                "/fixture-codex","/fixture-token"]) {
  const s=fs.lstatSync(p);
  if(!s.isDirectory() || s.uid!==1000 || s.gid!==1000 || (s.mode&0o777)!==0o700)
    throw Error("Invalid fixture ownership/mode/layout");
  const probe=p+"/.installation-write-probe";
  fs.writeFileSync(probe,"probe",{flag:"wx",mode:0o600}); fs.unlinkSync(probe);
}
if(fs.existsSync("/fixture-data/log/roles")) throw Error("Unexpected role state");
console.log("UID1000 fixture layout/write preflight passed; roles absent");'
```

이 명령의 성공은 파일시스템 준비만 증명한다. 이후 승인된 독립 test 인증을 빈 Codex/token
볼륨에 별도로 설치하고 auth key는 별도 test source만 read-only로 연결한다. helper에 키나
토큰을 넣지 않는다. gate/launch/inbox 등 host bind 경로도 UID1000이 필요한 접근을 할 수
있는지 확인하며, gate 파일의 regular-file/소유권/모드는 기존 계약을 따른다.
그 뒤에만 A bundle을 설치하고 실제 image/config/health, paused gate ack, role/manifest
계약을 확인한다. live data에서 기존 `readRoleRows()`가 빈 목록을 반환함을 확인한다
(`/data/log`, `/data/workspaces`는 존재, `/data/log/roles`는 아직 없음). 초기 설치에 실패하면
일반 배포/정상 횟수로 기록하지 않는다. 최초 설치를 `deploy.mjs`의 예외 플래그로 수행하지 않는다.

## 정상 2회와 실패 복구 1회

[일반 request 필드와 bundle 형식](deployment.md#운영자-요청과-후보-묶음)을 사용한다.
각 WORKFLOW는 서로 다른 보존 파일에 두고 auth/image/runtime shape는 동일하게 유지한다.
각 요청은 operator 소유 canonical regular JSON이며 group/world write를 허용하지 않는다.

fixture 요청에 추가할 필드:

```json
{
  "fixtureSource":"8dc068b7cd837d734a406c48e0ca13fafe48fc84",
  "fixtureRepository":"/operator/fixture-A",
  "integration":{
    "productionEngine":"<운영 engine 컨테이너 ID>",
    "productionAuth":"<운영 github-auth 컨테이너 ID>",
    "productionProject":"<운영 project>"
  }
}
```

`evidence`는 prepare의 결과다. `controllerVersion`은 설치한 **새 controller commit**이며
fixtureSource와 다를 수 있다. `validationOrigin` 필드는 기존 request 형식상 필요하지만
fixture를 실제 host validation receipt로 만들지 않는다. `authority.deploy:true`는 이 격리
실험의 효과만 허용하며 운영 배포 권한이 아니다. 세 요청의 모든 bundle/manifest/control
roots는 같다. request1=A→B, request2=B→A, request3=A→B이고 deploymentId는 각각 새 64hex다.

```json
{"kind":"fixture","requests":["/operator/test/one.json","/operator/test/two.json","/operator/test/rollback.json"]}
```

```sh
node /operator/momoflow/scripts/deploy-integration.mjs /operator/test/plan.json
```

runner는 첫 효과 전에 전체 chain, 고유 ID, 두 방향 provenance/로그/image label과 bundle
파일을 검사한다. 각 실제 배포 전에는 해당 live previous, 일반 runtime/권한/인증/계약 검사를
다시 수행한다. 세 번째 요청에서만 격리 target engine을 stop하여 기존 verify timeout과 rollback을
거친다. 일반 CLI에는 fault injection 옵션이 없다. 중간 실패 시 journal을 보존하고 gate를
held로 둔다. uncertain effect를 자동 재실행하거나 ID를 바꿔 재시도하지 않는다.

## 증거와 정리

| 검사 | 보존할 실제 근거 |
| --- | --- |
| 설치/격리 | source/controller SHA, A/B parent/tree/build labels/image ID, config/file hashes, 운영 및 test runtimeIdentity, volume driver/옵션·source 분리, 새 볼륨 allowlist/초기화 UID·mode 및 UID1000 쓰기/layout 검사 로그, 포트 |
| gate/작업 보호 | 각 deploymentId와 pauseAdmission/drainedAdmission, target/rollback/resumed admission ack, active 작업이 있는 동안 교체되지 않은 시간별 관찰, drain/timeout 결과 |
| 교체/검증 | 세 journal `complete`, `complete`, `rolled_back`; exact image/config/security/health, readiness/dashboard, 실제 sandbox 로그 hash, 실제 auth 종류/결과 |
| 복구 | 세 번째 target stop 시각·ID, 이전 A image/config/인증/접수 재개, ledger/count/manifest 보존 비교 |
| 경계 | GitHub merge/review gate 미실행, 실제 GitHub token 읽기와 준비 provenance 구분, 실제 sandbox와 모의 worker 구분, 추가 실제 모델 turn 미실행 |
| 정리 | 운영 identity/volume/port/ledger 불변 재대조; test 자원 명시 allowlist와 삭제 결과 |

단순 idle 성공으로 활성 작업 보호 실험을 대신하지 않는다. 모의 worker로 작업 보호를
확인하면 fixture 검증으로 표시한다. 실제 모델 실행이 필요하면 별도 승인 범위를 확인한다.
실험 전후 운영 identity는 Env 원문 없이 `runtimeIdentity()`로 보존한다.
정리는 보존된 journal/provenance/log와 필요한 rollback artifact를 먼저 안전한 위치에 보존한 뒤
정확한 test container/project/volume/network/control 경로 allowlist만 대상으로 한다.
`docker system prune`, 운영 compose down, 운영 인증 삭제는 사용하지 않는다.
복구 불명확/작업 활성 상태이면 강제로 정리하지 않는다. 정리 실패 역시 미완료로 기록한다.

현재 구현 workspace에는 Docker CLI/socket이 없다. 실제 정상2/복구1, 활성 작업 보호와
격리 자원 정리의 실측 결과는 외부 검증 전까지 **미실행**이다. 이 문서는 성공 영수증이 아니다.
