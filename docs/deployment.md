# 배포 운영과 자동화

상태: 운영 정책과 GH-14 외부 배포 CLI 후보. 설치·격리 실 Docker 검증 전이며 자동 승격은 비활성이다.

## 목적과 역할

자기개선은 변경을 병합하는 데서 끝나지 않는다. 검증된 변경을 실행 중인 시스템에
반영하고, 실제 결과를 다음 개선 판단에 사용하는 것까지 연결해야 한다. 배포 자동화는
필수 후속 단계이며 자체 UI나 엔진 재작성 뒤로 무기한 미루지 않는다.

초기에는 개발 에이전트가 PR·검증 근거·배포 후보를 준비하고, 사용자가 배포 시점을
정한다. 대화 보조자는 요청받은 배포와 실패 복구를 수행할 수 있다. 이는 운영 역할이며
기능 개발을 대신 맡는 권한이 아니다. 자동화 구현도 개발 루프의 작업으로 진행한다.

## 초기 배포 절차

1. **대상 고정:** 병합 및 검증된 커밋 SHA를 선택한다. 해당 버전의 이미지, Compose 및
   WORKFLOW.md를 한 배포 단위로 식별하고, 이전 정상 배포의 이미지·설정을 보존한다.
2. **새 버전 검증:** 현재 엔진을 유지한 채 선택한 커밋으로 이미지를 빌드하고 격리된
   스모크 검사를 수행한다. 검사한 이미지 자체를 배포하며 이동하는 latest 태그에 의존하지 않는다.
3. **작업 마무리:** 신규 실행을 막고 진행 중인 작업의 종료·결과 보존을 기다린다.
   대기 중이거나 재시도할 이슈도 기록한다. 일정 시간 안에 끝나지 않으면 배포를 연기하며
   단지 배포를 진행하려고 실행 중인 작업의 라벨을 제거하거나 강제 종료하지 않는다.
4. **교체:** 진행 중인 작업이 없는 경계에서 엔진을 중지하고 이미지와 설정을 함께 교체한다.
   인증·작업 볼륨은 보존한다. 재기동 직후에는 신규 작업 접수를 재개하지 않는다.
5. **확인:** 실행 버전, 대시보드, 상태 API, Codex 인증, GitHub 이슈 조회를 확인한다.
   HTTP 응답만으로 모든 실행 기능이 정상이라고 판단하지 않는다.
6. **재개 또는 복구:** 정상이면 신규 작업 접수를 재개한다. 실패하면 이전 이미지와 설정으로
   돌아가 같은 확인을 수행한다. 복구도 실패하면 접수를 멈춘 채 구체적인 장애를 보고한다.
7. **기록:** 대상·이전 커밋, 이미지 식별자, 설정 버전, 검사 결과, 시작·종료 시각,
   복구 여부를 GitHub 배포 기록 또는 연결된 이슈에 남긴다. 자격 증명은 기록하지 않는다.

기존 운영 구성에는 신규 실행만 멈추는 전용 drain/pause 기능이 없다. GH-14 후보의 선택적 gate는 아래 설치 절을 따른다. `docker compose down`은
진행 중인 작업의 정상 종료를 기다리는 절차를 대신하지 않으며, running 수가 잠시 0이라는
것만으로 신규 작업이 배정되지 않는다고 보장할 수 없다. 실제 교체 전에 접수 차단 수단과
작업 마무리 여부를 확인해야 한다. 이 빈틈은 배포 자동화의 선행 개선 항목이다.

데이터 형식이나 인증 저장 방식이 바뀌는 배포에는 호환성·백업·복구 계획이 필요하다.
이미지만 되돌려서는 데이터 변경이 복구되지 않는다. 초기 자동 배포 범위에는 그런 변경을
포함하지 않는다.

## 자동화로 전환하는 순서

| 단계 | 실행 방식 | 다음 단계로 넘어갈 근거 |
| --- | --- | --- |
| 운영 절차 확립 | 사용자가 시점을 정하고 운영자가 수행 | 배포 기록, 정확한 버전 식별, 작업 마무리와 복구 경로 확보 |
| 수동 시작·자동 수행 | 요청 한 번으로 검사·접수 중지·교체·확인·복구 수행 | 같은 절차로 두 번 연속 배포 성공, 격리 환경의 의도적 실패에서 복구 한 번 성공 |
| 조건부 자동 배포 | 검증된 병합을 배포 후보로 받아 작업 종료 경계에서 자동 반영 | 아래 조건을 모두 검사하고 결과를 영속적으로 기록 |

두 번의 성공과 한 번의 복구 검증은 초기 전환 기준이다. 횟수만 채우는 것이 아니라
정확한 이미지와 설정의 교체, 작업 보존, 실패 시 접수 중단까지 확인한다. 조건이 갖춰지면
일반 변경은 매번 사람의 배포 승인을 요구하지 않는 것이 목표다.

자동 배포가 확인해야 할 조건:

- 대상 커밋의 필수 검사·리뷰 통과와 검사한 이미지의 일치.
- 작업 접수 차단과 활성 작업 종료; 중복 배포 방지 및 실패 후 재실행의 일관성.
- 이전 정상 버전과 설정의 복구 가능성, 호환되는 데이터 형식.
- 제한된 시간 안의 기동·인증·이슈 조회 확인과 실패 시 자동 복구.
- 권한·예산·검증 기준·배포 정책 변경이 일반 자동 승격 경로에 섞이지 않음.

배포 실행 주체는 교체 대상인 Codex 작업 세션 밖에 둔다. 처음에는 호스트에서 실행하는
작은 절차로 충분하며, 별도 서버나 대규모 배포 플랫폼을 먼저 만들지 않는다. 개발 에이전트가
자기 세션에서 Docker 소켓을 얻거나 실행 중인 엔진을 직접 교체하도록 만들지 않는다.

## 재귀 개선의 완료 기준

`개선 Issue → PR → 검증·리뷰 → 병합 → 배포 → 운영 확인 → 후속 개선 판단`이 연결되고,
실패 시 이전 정상 버전으로 돌아가 다음 판단을 할 수 있어야 한다. 배포 자동화가 아직
없다면 코드 개선 루프와 운영 시스템의 자기개선 루프가 모두 완성되었다고 표현하지 않는다.

## GH-14 후보: 외부 운영 명령 (설치·실 Docker 검증 전)

이 후보의 `scripts/deploy.mjs`는 **명시 요청 한 번의 실행**을 구현한다. 일반 병합의
자동 승격은 켜지 않는다. 코딩 세션에서 실행하거나 현재 엔진을 교체하지 않는다.
기존 [PR #12 수동 배포 근거](https://github.com/sh0622-kim/momoflow/pull/12#issuecomment-6357554301)는
검사한 이미지 자체·이전 설정 보존의 기준이며, 이번 자동화의 실제 검증 근거가 아니다.

```sh
# 외부 운영자: 검토/설치한 고정 checkout에서만 실행
node /operator/momoflow/scripts/deploy.mjs /operator/requests/deploy.json --preflight
node /operator/momoflow/scripts/deploy.mjs /operator/requests/deploy.json
```

`--preflight`는 설정·이미지·merge/review/검사 로그·현재 컨테이너·계약·controller 소유권을
조회한다. lock/journal/comment/label/manifest 생성, pull/build/create/stop은 하지 않는다.
작업이 진행 중이면 실제 실행의 pause 이후 drain에서 기다린다. 검사 성공은 배포 성공이 아니다.
CLI에는 임의 명령 hook, 후보 스크립트 실행, 자동 label, ledger 수정 기능이 없다.

| 단계 | 실제 경계/실패 처리 |
| --- | --- |
| 사전 검사 | 신뢰 설정의 authority, exact merge SHA/parents/tree, 별도 review/publish receipt, 검사 producer/head, 로그 hash, role≥87/host≥126, 검사 image ID, 완전 렌더 Compose/config hash를 대조 |
| 잠금·접수 중지 | deployment.lock과 기존 stateRoot/controller.lock 배타 획득. gate 세대 기록 후 orchestrator의 같은 세대 ack 대기. polling/retry 양쪽을 차단하고 기존 작업 유지 |
| drain | running/retrying/claimed/blocked/pending_dispatch 모두 비었고, role ledger에 active/in_flight/미완료 단계가 없고, 남은 controller/launch journal/lock이 없어야 교체. 최종 경계에서 재검사 |
| 보존·교체 | intent를 fsync한 뒤 설정·merge 근거·live data volume의 읽기 전용 tar를 보존. image pull/build 없이 엔진만 Compose up. App auth 서비스/image·권한·키 custody·토큰 갱신 유지 |
| 확인·재개 | 여전히 paused인 채 image ID·mount/security/env hash·파일 hash·healthy·dashboard/state API·Codex login status·실제 엔진 token-file GitHub 읽기·role/launch 계약 확인. 모델 호출 없음 |
| 실패 | 이전 image/config로 복원하고 같은 검사 후 재개. resume 응답이 불확실하면 다시 fence/drain하여 새 worker를 죽이지 않음. 복구 실패/활성 작업/소유권 불명은 paused로 보존 |
| 기록·중복 | 단계별 intent/event/journal 및 GitHub 요약. 완료 ID는 실제 상태를 재조회/검사/보고만 수행. 중간 상태는 fence 후 운영자 복구로 차단, 효과 재실행 없음. 보고 실패는 journal 보존 후 같은 ID로 보고 재시도 |

### 외부 설치와 첫 admission bootstrap

기존 배포에는 gate가 없다. 이 CLI는 구형 엔진의 순간 running0을 drain으로 간주하지 않고
`Admission installation/bootstrap required`로 거부한다. 첫 설치는 외부 운영자가 기존 수동
절차로 신규 접수를 막고 활성 실행·controller/launch 소유권·대기 claim/retry 및 ledger를
직접 확인한 별도 운영 작업이다. 이번 실행에서 현재 엔진을 교체하지 않는다.

후보 이미지의 `engine/admission.ex`와 `patches/admission.patch`는 upstream에 없는 admission
경계만 추가한다. 운영자가 소유하는 **디렉터리**를 `/run/momoflow-admission:ro`로 mount하고
`MOMOFLOW_ADMISSION_ROOT=/run/momoflow-admission`을 지정한다. 단일 파일 bind는 atomic rename을
따라가지 못하므로 쓰지 않는다. 시작 전 아래 JSON을 `active.json`으로 설치한다.

```json
{"v":1,"generation":"<64자리 소문자 hex 운영 세대>","paused":true}
```

설정된 gate가 없거나 손상되면 restart 후에도 fail closed다. 미설정은 기존 upstream 동작이다.
새 `/api/v1/state.admission`은 orchestrator 프로세스에서 gate를 읽고 같은 상태의
running/retrying/claimed/blocked/pending_dispatch를 반환한다. 정상 진행 중인 worker를
종료하지 않으며, fence 중 retry timer는 기존 claim/metadata를 유지한다. 따라서 retry가
남아 있으면 자동 배포는 timeout으로 연기한다. `/data` mount의 실제 named volume과
기본 log/workspaces 디렉터리를 확인한 뒤 roles 디렉터리 부재만 새 볼륨의 빈 상태로
허용한다. 기존 roles/ledger의 손상·읽기 실패·symlink는 차단한다.
released `await_validation` ledger는 파일명/repo/issue/publication/request/head/tree 및
confirmed merge가 일치하는 trusted host `journal.done=true`가 있어야 유휴로 인정한다.
완료된 host 작업 때문에 ledger를 done으로 고쳐 쓰지 않는다. 이를 없애려고 ledger/label을 편집하지 않는다.

운영 CLI는 host Node/Docker Compose 또는 독립 operator helper에서 실행한다. helper는
engine과 다른 수명·자체 network namespace를 사용하며 `--network container:<engine>`을
사용하지 않는다. 컨테이너 실행은 request의 `operatorContainer`가 실제 자기 hostname이고
engine 서비스가 아닌지 조회한다. Docker socket은 **operator만** 가진다. engine/auth에는
socket/추가 capability/키 접근을 주지 않는다. 외부 운영 directory는 engine의 쓰기 가능한
mount 밖에 두고, 후보 workspace에서 request/receipt/운영 Compose를 복사해 신뢰하지 않는다.

Docker Desktop/WSL에서는 daemon의 named volume `_data` 경로를 가정하지 않는다. ledger는
실행 엔진의 `docker exec`로 live 조회하고 backup은 socket/network 없는 이전 정상 이미지의
read-only volume mount로 tar한다. helper는 Desktop에서 `engineURL=http://host.docker.internal:PORT`로 host publish에 접근한다.
Linux에서 해당 주소가 loopback publish에 도달하지 못하면 host CLI를 사용한다.
helper 안의 host bind 경로는 daemon과 동일한 절대 경로로
mount해야 한다. journal/backup 디렉터리는 operator 전용이며 backup helper UID1000이 쓸 수
있어야 한다. tokenFile은 기존 갱신 service의 token volume을 operator helper에 read-only
mount한 경로를 사용할 수 있다. private key를 operator/engine에 복사하지 않는다.

### 운영자 요청과 후보 묶음

request는 candidate가 아닌 운영자가 소유하는 canonical regular JSON 파일이다. group/world
write를 허용하지 않는다. 고정 설치 checkout은 clean이며 `controllerVersion`과 일치해야 한다.
`verifyInstall`의 기존 경로 조건도 유지한다. 데이터/request/evidence는 checkout 밖에 둔다.

필수 request 필드는 다음과 같다. 생략된 값은 자동 추론하거나 PR 문장에서 승인으로 만들지 않는다.

| 필드 | 운영자가 고정할 값 |
| --- | --- |
| repo, issue, base, deploymentId | 정확한 저장소/근거 이슈/base, 새 64hex ID. 완료 ID의 설정 변경/재사용 금지 |
| authority, hold, compatibility, exceptional | `{deploy:true}`, `false`, `unchanged-data`, `false`. 호환 불가 데이터 변경·예외 정책 변경은 이 MVP가 거부 |
| controllerVersion, validationOrigin | 설치 CLI commit, 보존된 host 검사 producer commit. 서로 다른 버전이면 각각 명시 |
| trustedRoot, stateRoot, inboxRoot, ledgerRoot, tokenFile | 기존 고정 controller 경로 계약. ledgerRoot는 기존 설치 호환 metadata이며 존재 여부/host 복사본을 drain 근거로 쓰지 않음; live volume 조회 |
| deploymentRoot, gateRoot, project, dataVolume, engineURL | 영속 operator 기록 경로, host gate 디렉터리, 기존 Compose project, 기존 data named volume, host의 `http://127.0.0.1:PORT` 또는 Desktop helper의 `http://host.docker.internal:PORT` |
| drainMs, verifyMs | 각각 ≤3600000/≤300000의 양의 ms. Docker 외부 호출·HTTP도 timeout 적용 |
| requiredChecks, requiredReviewers | 기존 host 설정과 같은 명시 검사 producer `{name,appId}` 및 필수 human login 배열. 빈 배열은 실제 규칙이 없을 때만 |
| manifest | 현재 engine의 `{status:"absent"}` 또는 `{status:"present",value:{v,id,repo,issue,base,limit}}`. limit 1/2/3과 전체 내용 보존 |
| target, previous | 아래의 exact 후보/정상 bundle. 두 image/commit은 달라야 실제 교체로 인정 |
| evidence | `{path,hash}`: 기존 controller가 merge 전에 보존한 `{ledger,publication,validation,pr,merge}`. hash는 `digest(parsedJSON)`, 옆 logs 디렉터리에 원래 check.log별 로그 보존 |

각 bundle은 `{commit,image,authImage,runnerSource,composeFile,composeHash,files,inspect}`다.
image/authImage는 로컬에 이미 존재하는 `sha256:...` ID이며 moving tag는 거부한다.
`runnerSource`는 exact merge의 `engine/role_runner.ex` 바이트 SHA256과 대조한다.
`files`는 absolute path→바이트 SHA256 map이며 Compose와 WORKFLOW/seccomp 등 모든 고정 bind
파일을 포함한다. secret key·token·Codex auth 파일은 bundle/로그에 복사하지 않는다.

Compose는 운영자가 검토한 완전 렌더 JSON이어야 한다 (`docker compose ... config --format json`).
`name`/절대 경로/외부 named volume/고정 image를 포함하고, build/env_file/extends/include/
secrets/configs 간접 참조는 지원하지 않는다. 렌더를 다시 실행한 결과가 JSON과 구조적으로 같아야 한다 (object 키 순서는 무관, 파일/근거 hash는 별도).
후보 Compose를 privileged host에서 실행하지 않는다. engine/auth 두 기존 service만 지원하며
이 MVP는 auth image·환경·권한·mount를 바꾸지 않는다. 엔진은 image와 고정 WORKFLOW 파일의
source만 바꿀 수 있다. 이전/후보 WORKFLOW는 **서로 다른 보존 경로**를 써야 rollback 시
이전 바이트로 복원된다. live data/Codex/auth/launch/inbox volume과 제어 경계는 같다.

교체 전 service와 immutable image 기본값으로 user/argv/env/mount/network/security/port를
계산하여 `inspect` 기대값과 대조한다. 지원하지 않는 service/top-level 필드는 거부한다.
기존 `${project}_default` network 하나, `external:true`와 정확한 name을 가진 named volume,
long-form mount만 지원한다. bind는 `bind:{create_host_path:false}`, volume은
`volume:{nocopy:true}`를 명시한다. init=true/restart=unless-stopped를 유지하며
build/develop/hooks/devices/pid/network_mode 등 추가 실행·권한 설정은 지원하지 않는다.
Compose 전체 shape는 symphony image와 WORKFLOW source 외에는 이전/후보가 같아야 한다.
image Env 배열 순서는 의미가 없으므로 `runtimeIdentity()`는 정렬한 배열의 hash를 사용한다.
기대 identity는 이 버전의 함수로 생성한다.
Compose의 `seccomp=/절대/경로.json`은 고정 파일의 바이트 hash를 먼저 확인한 뒤
프로필 JSON 내용으로 비교한다. Docker inspect는 파일 경로 대신 inline JSON을 반환하므로
`runtimeIdentity()`도 같은 방식으로 object 키를 정렬한다. 배열 순서와 모든 값은 보존한다.
경로를 inspect 기대값에 직접 넣지 않는다. 변경된 프로필·`unconfined`는 거부한다.
이 표현은 [Compose 2.40.3의 프로필 파일 처리](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/create.go#L415-L447)에 맞춘다.

`inspect`는 `{symphony: identity, "github-auth": identity}`다. 운영자가 기존/격리 후보
컨테이너에 대해 `runtimeIdentity()`로 산출한다. 이 함수는 Env 원문 대신 hash를 기록한다.
다음 명령은 inspect 원문을 터미널/파일에 남기지 않는다 (고정 operator checkout에서 실행).

```sh
docker inspect ENGINE_CONTAINER AUTH_CONTAINER | node --input-type=module -e '
import {runtimeIdentity} from "./scripts/deploy.mjs";
let b=""; for await (const s of process.stdin) b+=s;
console.log(JSON.stringify(Object.fromEntries(JSON.parse(b).map(x=>
 [x.Config.Labels["com.docker.compose.service"],runtimeIdentity(x)])),null,2));'
```

이 기대값은 operator 신뢰 입력이지 후보가 주장한 실측값이 아니다. 최종 실제 컨테이너의
image/command/user/mount/security/network/ports/env hash와 매번 대조한다. `engineURL`은 engine
container namespace에 기대지 않는 loopback publish 포트와 같아야 한다. config 사전 검사는
정확한 후보 설정의 렌더/안전 계약 검사이며, 실제 기동/auth 검사는 교체 뒤 paused 상태의
별도 증거다. 검사기준·권한·예산·정책 관련 파일 변경은 PR files 조회로 일반 경로에서
거부한다. GH-14 자체의 첫 설치/정책 변경을 이 CLI로 자기 승인/자동 배포하지 않는다.

### 영속 기록과 운영자 복구

`deploymentRoot/ID/journal.json`과 단계별 event JSON에 target/previous bundle·시간·결과·복구·
다음 행동이 남는다. bundle/, images.tar 및 data.tar는 rollback 근거다. 이미지가 사라진 외부 복구는 images.tar의 image load를 사용하고 exact ID를 재대조한다. **data.tar를 live ledger 위에
복원하지 않는다.** 이 MVP는 호환 데이터 유지와 image/config rollback만 수행한다.
GitHub에 같은 ID의 요약 comment를 갱신하며 reporting 실패는 terminal journal을 취소하지 않는다.
완료/복구 완료 ID의 재호출은 현재 상태 재검사/보고만 하며 재배포하지 않는다.

crash로 lock이 남으면 자동으로 훔치지 않는다. 운영자는 PID만 보지 말고 실제 operator/
controller/launch 프로세스·journal intent/event·현재 image/mount·gate ack·live ledger를 함께
조회해야 한다. 중간 journal 재호출은 차단된다. 접수는 paused로 두고 이전 정상 bundle의
동일 검증을 끝낸 뒤에만 수동 재개를 판단한다. ledger/journal 초기화로 새 시도를 만들지 않는다.
외부 효과가 불분명하면 신규 request도 실행하지 않고 인계한다. 완료된 request의 GitHub 보고만
실패한 경우 기존 ID로 다시 실행할 수 있다. controller.lock이 남았다면 그 소유권 해소가 먼저다.

### 격리 실 Docker 검증 인계 (미실행)

일반 적격 A/B가 없는 최초 실험은 [최초 설치와 fixture 준비](deployment-fixture.md)를 따른다.
로컬 fixture provenance를 일반 GitHub 배포 자격으로 승격하지 않는다.

로컬 `node scripts/post-pr.test.mjs`의 deployment tests는 **외부 효과를 모의한 계약**이다.
실 Docker·Codex 인증·실 모델 실행을 증명하지 않는다. `sh scripts/test-role-flow.sh`는 실제
patched orchestrator 코드를 컴파일하지만 worker/model은 모의한다. 외부 운영자의
일반 `kind:github` 검사는 별도 Docker project/volume/port와 승인된 GitHub 읽기 인증을 준비한 뒤 실행한다.
인증 없는 `kind:fixture`는 아래 GH-18 예외와 전용 installer를 따른다.

1. gate 지원 정상 이미지 A로 `momoflow-deploy-test-...` 프로젝트를 따로 설치한다. 별도
   data/Codex/auth volume, gate/launch/inbox 디렉터리와 포트를 사용한다. 기존 auth custody를
   유지하며 test Codex 인증을 명시적으로 준비한다. 운영 volume의 snapshot을 live로 mount하지 않는다.
2. 승인·독립 리뷰·host 검사/merge 근거가 있는 서로 다른 이미지 A/B를 준비한다. 요청1=A→B,
   요청2=B→A, 요청3=A→B를 각 새 deploymentId와 해당 bundle/이슈/evidence로 고정한다. B의
   실패 검증은 image를 변조하거나 검사 근거를 위조하지 않고 **격리 후보 컨테이너를 stop**한다.
3. 각 request에 `integration:{productionEngine:"<현재 운영 engine ID>",productionAuth:"<운영 github-auth ID>",productionProject:"<운영 project>"}`를
   명시한다. helper에서 실제 운영 identity를 읽을 수 있어야 한다. runner는 test project 접두사,
   운영 engine/auth identity, 다른 mount/credential source/port를 검사한다. production CLI에는
   fault injection flag가 없다.
4. 운영자가 다음 plan JSON과 명령을 실행한다. 별도 `deploy-integration.mjs`는 같은
   production CLI 경로로 정상2회 후 세 번째 교체 직후 test candidate만 stop한다. production
   verify timeout→이전 bundle rollback→동일 auth/contract 검사→접수 재개를 실제로 수행한다.

   ```json
   {"kind":"github","requests":["/operator/test/one.json","/operator/test/two.json","/operator/test/rollback.json"]}
   ```

   ```sh
   node /operator/momoflow/scripts/deploy-integration.mjs /operator/test/plan.json
   ```

5. 세 journal의 phase가 `complete`, `complete`, `rolled_back`인지 확인한다. 각 실제 image/config,
   gate 세대/paused·runtime 상태, 인증/계약, data/ledger 보존과 timestamps를 별도 운영 검증
   기록에 보존한다. 의도적 장애가 시작되기 전 정상2회가 실제 서로 다른 버전을 교체해야 한다.
   실패하면 성공 횟수로 기록하지 않는다. 운영 project/volume/port 불변도 확인한다.

현재 workspace에는 Docker CLI/socket이 없어 이 실험과 `docker compose build`,
`sh scripts/smoke.sh`를 실행하지 않았다. 이 인계를 실제 성공으로 표시하거나 조건부 무인
배포를 활성화하지 않는다. 외부 exact-head 검사·별도 리뷰·설치와 본 실험의 근거가 남아야
자동화 전환 완료 조건을 판단할 수 있다.

## GH-18: fixture 인증 분리 예외 (별도 리뷰·설치 필요)

격리 Docker 교체/복구만 검증하는 fixture에서는 새 Codex 로그인이나 새 GitHub App을
요구하지 않는다. 별도 `deploy-fixture-install.mjs` → `kind:fixture` integration 경로만
자격 증명 없는 단일 서비스를 허용한다. 후보의 실제 image/security/readiness/sandbox와
pause/drain/ownership/rollback 검사를 유지하고, auth/model/GitHub gate는 미검사로 기록한다.
외부 통신 차단, 고정 비자격 sentinel, 빈 Codex/launch/inbox 및 absent manifest가 필수다.
원본 WORKFLOW·모델·권한·예산을 변경하지 않으며 운영 인증을 후보에 복사하지 않는다.

일반 `deploy.mjs`는 fixture 요청을 효과 전에 거부한다. 일반 운영 배포의 두 서비스,
Codex login status, token-file GitHub 읽기, 자격 gate와 예외 배포 정책은 그대로다.
필요한 기존 인증 확인은 trusted host/기존 서비스의 최소 읽기로 별도 기록하며, 이를
후보 인증 성공으로 표시하지 않는다. [실행 명령과 증거 경계](deployment-fixture.md#인증-없는-최초-설치와-정상2복구1-gh-18-후보)를 따른다.

이 정책/구현 PR의 완료는 #16의 실 Docker 실험 완료나 운영 배포 승인이 아니다.
실제 정상2·복구1 및 나머지 조건 전에는 #16을 완료하지 않고 기존 2/3·terminal 기록을 유지한다.
