# PR 이후 호스트 조정

상태: 2026-10-23 관찰 기준, GH-7/PR #8의 선택 기능은
`2627ef65324530275eefb81b107607121e18e6ee`로 운영 배포되고 별도 컨트롤러도 설치됐다.
[운영 배포·설치 기록](https://github.com/sh0622-kim/momoflow/pull/8#issuecomment-6356520917)은
해당 SHA/tree의 실제 GitHub→Docker 검사(Compose/build/readiness/sandbox 통과,
역할 계약 74 tests/0 failures, Node 78 tests/0 failures)를 남긴다. 이 계약 검사의 모의 모델/RPC
경로는 실제 새 runner의 모델 게시·자동 마무리 통합 증거와 구분한다.

[GH-9/PR #10 완료 근거](https://github.com/sh0622-kim/momoflow/pull/10#issuecomment-6356756800)는
새 실행의 publication→await_validation→host exact-head 검사→fresh gates→SHA 병합·보존·
이슈 종료를 관찰했다. head `872ee451cebb54ddec8406992fbeb727b49ad09c`, merge
`573ea276df12c8830576f033a6d082e16085d820`, 역할74/host78 검사가 기록됐다.
자연 코드 실패가 없어 실제 모델 수정 재개는 미관찰이며, GH-7 terminal migration이나
GH-11 후보 launch의 live 검증 증거로 사용하지 않는다. GH-9의 별도 승인·사용량 기록은
[해당 workpad](https://github.com/sh0622-kim/momoflow/issues/9#issuecomment-6356628473)에 보존한다.

기능은 `MOMOFLOW_ROLE_FLOW=1`, `MOMOFLOW_POST_PR_INBOX`, read-only inbox mount와
운영자가 설치·설정한 별도 controller가 있어야 연결된다. 기본 Compose는 post-PR flag/mount나
controller를 자동 설치하지 않으며, post-PR flag 없는 runner는 publish→done을 유지한다.
설치·기동은 구현 세션 밖 운영자의 작업이다. 개발 중인 세션이 자기 엔진이나 컨트롤러를
교체·기동하거나 자기 변경을 승인하지 않는다.

## 구현 범위

`scripts/post-pr.mjs`는 단일 repo/issue의 반복 호출 가능한 reconcile 명령이다.
기존 Symphony polling/claim/slot/retry가 모델 실행을 맡는다. 새 서비스·DB·스케줄러는 없다.
`--watch`는 같은 reconcile을 30초마다 호출하며 대기 중 모델을 시작하지 않는다. 완료 또는 실제 차단 사유에서는 종료한다.
후속 이슈 dispatch, 자연어 승인 해석, 배포는 구현하지 않는다.

| 경계 | 소유자·검증 |
| --- | --- |
| 실행·공유 3회 예산 | RoleRunner ledger; 구현 진입 시 증가. 호스트는 ledger를 수정하지 않음 |
| 게시 근거 | runner가 별도 리뷰 세션·snapshot·원격 PR head/base·전체 Git tree를 대조 |
| 호스트 권한 | workspace 밖 운영자 JSON의 repo/issue/base, authority, hold. PR 본문/라벨은 권한 아님 |
| 호스트 검사 | 운영자가 고정한 컨트롤러·Compose 이미지·seccomp/probe. 후보 셸/Compose를 호스트에서 실행하지 않음 |
| 검사 산출물 | SHA/tree/request/controller/image, 이름·원래 exit·로그 digest, 양수 test 수·실패 수. host 전용 디렉터리 보존 |
| 수정 요청 | host 전용 inbox에 atomic JSON, 엔진에는 read-only mount. 대상 publication·ledger generation·요청 ID 확인 |
| 병합 | fresh head·검사 producer·리뷰/thread·저장소 규칙 확인 후 `sha` 조건 REST merge, 실제 병합 재조회 |
| 종료 | merge 전후 영속 근거 보존, PR 및 같은 workpad 갱신·ready 제거 확인 후 close·재조회 |

최소 버전은 **branch.protected=false와 active rules=[]를 모두 확인한 저장소**만 병합한다.
403, 규칙 조회 불완전, 보호된 branch, merge queue 등 미지원 규칙은 구체적인 차단 사유다.
필수 외부 check 목록은 운영 설정에서 명시한다. 외부 check가 없는 저장소는 빈 배열을 명시할 수
있지만 고정 host 검사(compose/build/contracts/node/sandbox/readiness)와 양수 테스트 근거는
항상 필수다. 기존 64개 이상 역할 계약과 양수 Node 테스트를 확인하며, 검사0건이나 모델의 passed 문자열을 성공으로 받지 않는다. check name+App ID와
정확한 head를 검사한다. pending·아직 생성되지 않은 필수 check·GitHub mergeability 계산은
대기하며 `--watch`가 같은 head를 다시 확인한다. 실제 실패·서로 충돌하는 producer·권한 문제는
차단한다. GitHub 필수 사람 리뷰를 Astra 리뷰로 대체하지 않는다.
설정한 사람 리뷰어는 별도 인간 계정이어야 하며 App/PR 작성자·권한 없는 계정·오래된 승인·
changes_requested·미해결 thread를 허용하지 않는다. REST 100건 이상/GraphQL 다음 페이지는
불완전한 조회로 차단한다. 외부 status 실패는 코드 수정으로 추측하지 않는다.

`post-pr-docker.mjs`는 REST tree/blob identity를 확인해 별도 임시 context를 만든다.
후보 Dockerfile의 build 단계는 Docker builder 안에서 실행하며 host 인증/운영 볼륨·secret·
socket을 전달하지 않는다. materialize는 모든 symlink의 절대/경로 이탈 target을 거절하고
전체 체인의 realpath도 context 안인지 확인한다. dangling/cyclic link는 차단하며
Dockerfile/.dockerignore 등 host reader에도 같은 경계를 적용한다. in-tree link는 허용한다.
Docker CLI도 빈 별도 config를 사용한다. Compose 파싱은 socket 없는
고정 CLI 컨테이너 안에서 수행한다. 후보 image의 기본 entrypoint/user를 사용하지 않고 제한된
비루트·network none·cap_drop ALL·no-new-privileges·고정 seccomp·자원 제한 컨테이너를 시작한다.
검사에는 인증·운영 볼륨이 없고 fixture token만 있다. 코드/테스트는 컨테이너 안에서 실행한다.
후보의 권한 프로필·호스트 smoke.sh·hooks는 실행하지 않는다. 고정 probe는 실제 sandbox의
작업공간 쓰기/외부 쓰기 거절/네트워크 거절/mount 거절을 검사한다.

ExUnit/TAP의 양수 테스트 수와 실패 수, 원래 process exit를 함께 보존한다. exit=0과
실패=0이 일치할 때만 해당 suite를 통과로 인정한다. exit=1/2와 양수 assertion 실패가
일치하고 다른 host 검사가 모두 통과한 경우만 code_failure로 분류한다. exit=0/실패>0,
exit=2/실패=0, 그 밖의 tool exit나 모순된 근거는 host_failure로 차단한다. 숫자 2 자체는
코드 실패 판정 태그가 아니다. build/Compose/인증/도구/호스트 실패나 해석 불가능한 결과는 자동 수정
반복으로 바꾸지 않는다. assertion 실패의 컨테이너 출력에서 check당 최대 약 6,100자의 진단
발췌를 전달한다. 제어 문자·일반적인 token/비밀번호/key 형식을 제거하며 원본 로그
digest/head/tree와 함께 inbox→runner 수정 프롬프트에 보존한다. 운영 로그/설정/환경은 붙이지
않고 host 전용 전체 로그는 공개하지 않는다. 검사 감소·추가 권한·대체 개인 토큰으로 우회하지 않는다.

## 설치와 사전 검사

1. 운영자는 독립 리뷰가 끝난 컨트롤러 commit을 workspace 밖 별도 checkout에 고정한다.
   이 checkout의 scripts/security/WORKFLOW를 `trustedRoot`로 사용한다. 그 디렉터리와 설정·
   journal·inbox는 후보 에이전트가 쓸 수 없어야 한다. Node 22와 Docker/Compose가 필요하다.
2. 다른 설치나 다음 엔진 버전은 [배포 정책](deployment.md)에 따라 별도로 검증·반영한다.
   기존 GH-7 세션/terminal ledger는 자동 migration하지 않는다. ledger 삭제·done→build
   수동 편집은 금지한다. PR #8 병합·배포와 설치 검사는 위 운영 기록에 보존돼 있으며,
   새 runner의 실제 통합 잔여 조건과 구분한다.
3. 다음 새 실행부터 엔진에 `MOMOFLOW_POST_PR_INBOX=/run/momoflow-resume`를 지정하고,
   host inbox(디렉터리 755, 비밀 없는 envelope 644)를 해당 경로에 read-only bind mount한다. Docker socket/키/추가 capability는
   엔진에 주지 않는다. host는 기존 `/data/log/roles`를 읽기만 한다. 이 설정을 기본 compose에
   자동 적용하지 않았으므로 flag 없이 기존 publish→done 경로가 유지된다.
4. host 전용 JSON을 아래 형식으로 작성한다. SHA/image digest·경로·App ID·범위는 실제
   검증된 값으로 채운다. 토큰 파일은 기존 github-auth의 expiring JSON이며 키를 복사하지 않는다.

```json
{
  "repo": "sh0622-kim/momoflow",
  "issue": "7",
  "base": "main",
  "controllerVersion": "<reviewed controller commit: 40 hex>",
  "trustedRoot": "/opt/momoflow-controller",
  "stateRoot": "/var/lib/momoflow-post-pr",
  "ledgerRoot": "/srv/momoflow-data/log/roles",
  "inboxRoot": "/srv/momoflow-resume",
  "tokenFile": "/srv/momoflow-auth/token.json",
  "engineURL": "http://127.0.0.1:4000",
  "composeImage": "docker:<operator-verified CLI version>@sha256:<64 hex>",
  "requiredChecks": [],
  "requiredReviewers": [],
  "authority": {"validate": true, "resume": true, "merge": true, "close": true},
  "hold": false
}
```

`requiredChecks`의 각 외부 검사는 `{"name":"실제 검사명","appId":실제_숫자}`다.
사전 위임된 issue만 등록한다. GH-7 예시는 현 terminal ledger가 자동 채택된다는 뜻이 아니다.
새 scope는 해당 이슈의 위임 근거가 필요하다. 설정 변경은 컨트롤러를 중단하고 재시작한다.
실행 중 파일이 달라지면 외부 효과 직전 차단한다. 컨트롤러 자체도 trustedRoot의 clean Git checkout/고정 commit 및 실행 파일 실경로를 확인한다. `hold:true`는 별도 보류다.

```sh
node /opt/momoflow-controller/scripts/post-pr.mjs /etc/momoflow/post-pr.json --preflight
node /opt/momoflow-controller/scripts/post-pr.mjs /etc/momoflow/post-pr.json
node /opt/momoflow-controller/scripts/post-pr.mjs /etc/momoflow/post-pr.json --watch
```

첫 명령은 GET 및 읽기 전용 GraphQL만 사용하며 Docker/모델/원격 mutation/inbox 쓰기가 없다.
receipt가 있는 await_validation 실행에서 정확한 head/tree/규칙/리뷰를 확인한다. 다음 명령은
허용한 외부 효과를 실행하므로 **이 구현 세션에서는 실행하지 않는다**. 운영자는 최초 실행의
실제 GitHub/Docker 산출물과 수정→재검증의 실제 모델 세션 evidence를 같은 workpad에 남긴다.
모의 계약 검사 성공을 실제 통합 검증 완료로 표시하지 않는다.

## 재시작과 복구

host state는 repo:issue SHA-256 디렉터리에 `journal.json`, request별 journal 보관본,
`evidence-<digest>.json`, `logs/<digest>`를 남긴다. merge intent와 정확한 검증 결과를 먼저
보존한다. 보존 후 병합 직전에 전체 검사·producer·리뷰/thread·저장소 규칙을 다시 조회하고
원본 이슈가 여전히 open인지도 새로 확인해 실제 gate 근거와 시각을 journal에 저장한다.
검증·보존 중 이슈를 닫았다면 병합하지 않는다. 컨트롤러가 확정한 병합의 후속 복구는
허용하되 보고·종료 직전 이슈를 다시 읽고, 이미 닫힌 이슈의 state_reason을 덮어쓰지 않는다. inbox 쓰기와 ready 재부여 전에도 신뢰 설정·
resume 권한/hold·released worker·동일 ledger/head를 재확인한다.

병합 요청은 attempting/rejected/uncertain/confirmed를 구분한다. 정상 응답의 merged=true와
merge SHA를 durable journal에 저장하고, GitHub 재조회 및 merge commit의 첫/둘째 parent가
게시 당시 base/head인지 확인해야 종료할 수 있다. 확정 응답을 기록한 뒤의 crash는 같은
병합을 재실행하지 않고 보고/보존/종료를 이어간다. 4xx 거절이나 merged=false 응답 뒤 외부
병합은 성공 근거가 아니다. 응답 유실·요청 중 crash로 확정 SHA를 보존하지 못했다면 이미
병합됐어도 자동 성공/종료하지 않고, 사실·근거를 보존하고 운영자 확인을 요청한다. 아직
open이어도 불명확한 요청을 자동 재전송하지 않는다. intent만으로 승인을 추정하지 않는다.
이미 완료한 병합·닫기·보고는
다시 생성하지 않는다. 새 head는 이전 검증을 재사용하지 않는다. 게시 당시 base commit이 바뀌면 보수적으로 차단하고 rebase/review 근거를 요구한다. 외부 병합·닫기는 자동으로
정상 완료로 인정하지 않으며 근거 확인을 요구한다.

동시 컨트롤러는 `lock`의 exclusive 생성으로 막는다. crash가 남긴 lock은 자동 만료하지 않는다.
운영자가 해당 PID/프로세스가 종료됐음을 확인하고 lock 파일만 제거한 뒤 같은 설정/journal로
재실행한다. ledger/inbox/events/검증 근거를 삭제하거나 예산을 초기화하지 않는다.
수정 build 진입의 count·요청 소비·in_flight를 한 ledger 저장으로 기록하므로 crash 후 같은
요청이 모델을 중복 실행하지 않는다. in_flight 중단은 구체적인 수동 복구 대상이다.

정상 CI 대기는 사람 판단 요청이 아니다. 지정된 사람 리뷰 대기는 needs-review, 권한·예산·
host 장애는 needs-decision과 PR/같은 workpad의 구체적 이유·다음 행동으로 표시한다.
ready는 제거하고 재조회한다. 다른 보류/필수 승인 우회 권한은 없으며, 라벨을 지웠다는 사실을
승인으로 해석하지 않는다. 이 기능은 자동 deployment나 목표 간 재귀를 수행하지 않는다.

## 승인된 단일 이슈 시작 (GH-11 후보, 별도 설치 필요)

`launch.mjs`는 운영자가 **이미 승인한** repo/issue/base/권한/1~3회 한도를 한 명령으로
준비하고 foreground controller에 연결한다. 이슈를 선택하거나 승인 댓글을 해석하지 않는다.
ready·댓글·같은 계정 작성은 권한이 아니다. 기존 Symphony polling/claim/worker/재시도와
`post-pr.mjs`의 exact-head 검사·별도 리뷰 receipt·fresh gate·SHA merge·보존·종료를 재사용한다.
모델/추론/Fast/네트워크/승인 정책은 바꾸지 않는다. 이 기능의 검사는 모의 계약이며
현재 GH-11에 소급 적용하거나 후보 controller로 자기 PR을 승인하지 않는다.

| 설정 | 추가 계약 |
| --- | --- |
| `launchId` | 운영자가 한 번 생성한 64자리 hex ID; 재시작에도 동일 |
| `iterationLimit` | 정수 1, 2, 3 중 명시; 기본 3보다 확대 불가 |
| `launchRoot` | host 전용 실제 디렉터리의 절대 경로; 엔진에 `/run/momoflow-launch:ro`로 연결 |
| `authority.launch` | 명시적 true; 기존 validate/merge/close도 true, resume은 명시 true/false |
| 기존 config | 승인된 repo/issue/base, 고정 controllerVersion/checkout, 단일 stateRoot, ledgerRoot/inboxRoot/tokenFile, hold=false, check/reviewer 목록 유지 |

기존 JSON에 다음 **실제 운영 값**을 추가한다. 예시는 승인이나 실행 가능한 완성 설정이 아니다.

```json
{
  "launchId": "<운영자가 생성·보존한 64 hex>",
  "iterationLimit": 2,
  "launchRoot": "/srv/momoflow-launch",
  "authority": {"launch": true, "validate": true, "resume": true, "merge": true, "close": true}
}
```

운영자는 승인된 버전·이미지·설정 묶음을 [배포 정책](deployment.md)에 따라 별도 설치한다.
엔진의 `MOMOFLOW_ROLE_FLOW=1`, `MOMOFLOW_POST_PR_INBOX=/run/momoflow-resume`와 기존
read-only inbox에 더해 `MOMOFLOW_LAUNCH_ROOT=/run/momoflow-launch`와 read-only launch
디렉터리 mount를 설정한다. 기본 Compose에는 자동 활성화하지 않는다. 새 state API의
`momoflow_launch`는 실제 repo, 동시 이슈 수, 역할 flag, mount 경로/ro 여부와 runner 소스
SHA-256 및 엔진이 실제 읽은 manifest의 검증 상태/전체 계약을 반환한다. CLI는 검토된 checkout
소스와 일치하고 최초에는 엔진 쪽 manifest가 없어야 진행한다. 설치 후 ready 직전에는
version/ID/repo/issue/base/limit 전체가 host 계약과 일치해야 한다. 다른 bind source의 빈 디렉터리나
다른 계약은 ready 전에 차단한다. 과거 이미지의 HTTP
200만으로 호환성을 인정하지 않는다. launch mode에서 manifest가 없으면 runner는 모델을
시작하지 않는다. 기존 작업이 없는 설치 경계에서 켜고, 기존 GH-7/GH-9를 채택하지 않는다.

경로는 symlink 없이 후보 workspace/checkout 밖에 둔다. 운영 디렉터리는 group/other 쓰기를
허용하지 않고, host만 쓰며 엔진은 읽기만 한다. engine 전체에 controller **하나와 동일한
stateRoot 하나**를 사용한다. 다른 checkout/stateRoot로 띄운 과거 watcher를 먼저 중지·확인한다.
인증은 기존 github-auth가 갱신하는 만료 token 파일이다. 후보 auth 코드는 발급 응답의
`permissions`와 제한한 `repository` 메타데이터를 함께 보존한다. launch는 contents/issues/
pull_requests write와 checks read/write, repo 및 만료를 검사하고 실제 GitHub GET도 수행한다.
키 custody·요청 권한·토큰 발급 scope는 그대로다. 구버전 token에 메타데이터가 없으면 차단하며,
권한 확대나 수동 token 편집 대신 외부 운영자가 같은 권한의 auth 버전을 설치·갱신한다.
발급 시점 권한 메타데이터와 실제 GET은 이후 모든 write 성공을 보증하지 않으므로 원격 효과는
별도로 재조회한다. 자격 증명을 출력하지 않는다.

```sh
node /opt/momoflow-controller/scripts/launch.mjs /etc/momoflow/issue.json --preflight
node /opt/momoflow-controller/scripts/launch.mjs /etc/momoflow/issue.json
```

첫 명령은 설정·설치·권한 메타데이터·실제 열린 이슈/base·ready 대상·현재 running/retrying·
controller/ledger/manifest 상태·경로를 읽고 필수 `composeImage`의 `@sha256:<64 hex>` pin을 검사한다. 파일/lock/댓글/라벨/inbox를 쓰지 않고 Docker나
모델을 실행하지 않는다. 닫힌 이슈/PR, 다른 ready 또는 실행, hold, 불완전한 API 결과,
terminal/중단/기존 legacy ledger, 다른 미완료 journal/ledger는 구체적 이유로 차단한다.

두 번째 명령은 동일 검사를 exclusive 소유권 안에서 다시 수행하고 `launch.json` intent를
먼저 보존한다. `active.json` manifest를 exclusive 생성한 후 설정·runtime·이슈를 다시 읽고
단일 workpad를 준비한 뒤 ready를 마지막으로 부여·조회한다. 직접 Codex를 호출하지 않는다.
최초 ledger가 없는 구간은 정상 준비 대기이며 최대 5분 관찰 후 실패를 보존하고 ready를
제거·확인한다. 한 번 관찰한 ledger가 사라지면 재생성 대기가 아니라 복구 장애다.
watch는 정상 worker/CI/리뷰 대기 동안 소유권을 유지하고 완료/차단 때 종료한다.
실패 watcher를 무한 재시작하는 서비스 restart 정책을 붙이지 않는다.

### 영속 예산과 복구

manifest의 version/ID/repo/issue/base/limit를 runner가 ledger의 `launch`에 고정한다.
처음 launch는 0에서 시작하며 댓글로 예산을 만들지 않는다. runner는 별도 `.json.enrolled`
표식을 먼저 보존해 ledger 유실 후 초기화를 막는다. 매 역할 진입과 host 수정 재개에서
동일 manifest를 요구한다. 삭제/변경/잘못된 내용/flag 해제는 기존 ledger에 기본3을
적용하는 대신 차단한다. 두 opt-in flag를 모두 제거해도 enrollment 표식이 역할 경로를 유지해
단일 세션으로 우회하지 않는다. 한도를 낮추는 변경도 자동 채택하지 않는다. count·events·terminal은
runner만 소유한다. 운영자/host는 이를 편집하지 않으며 표식도 삭제하지 않는다.

실제 build executor 진입 전에 count가 증가한다. limit=2면 두 번째 build 뒤 별도 리뷰와
게시까지 마칠 수 있으나 세 번째 build는 시작하지 않는다. 같은 PR 수정, 재시작·재시도도
같은 한도다. host는 receipt와 inbox/ready 직전 ledger의 남은 한도 및 manifest를 재검사한다.
이것은 build 반복 횟수 제한이며 lifetime 토큰·금액 하드 한도가 아니다.
launch에 등록되지 않은 기존 ledger는 기본3 의미를 유지하고 새 계약에 자동 편입하지 않는다.
GH-7의 3회 및 GH-9의 별도 1/2 승인·운영 기록은 그대로이며 잔여 예산을 전용하지 않는다.

`stateRoot/controller.lock`은 launch와 기존 reconcile/watch가 공유하며 watch sleep에도 유지한다.
동일/다른 scope의 중복 실행을 막는다. crash가 남긴 lock은 자동 만료하지 않는다. 운영자는
PID·실제 프로세스·이슈/ledger/manifest/journal/PR head를 확인하고 종료된 프로세스의 lock만
제거한다. 확정 dispatch의 재호출은 같은 intent를 관찰하고 ready를 다시 만들지 않는다.
intent/manifest 생성 중 실패, ready 응답 유실, blocker, 변경된 설정 또는 ledger 유실은 자동
재dispatch하지 않는다. workpad의 다음 행동과 보존한 journal을 확인하고 외부 운영자가 복구를
판단한다. 예산/terminal을 편집하는 복구 명령은 제공하지 않는다. 성공한 launch의 후속 scope는
완료 근거를 보존하고 worker가 없는 설치 경계에서 운영자가 이전 manifest를 보관·교체한다.
이 명령이 후속 이슈를 선택하거나 자동 실행하지 않는다.

### Docker Desktop/WSL과 외부 검증 인계

Docker Desktop named volume은 WSL의 `/var/lib/docker/volumes/.../_data`로 직접 읽힌다고
가정하지 않는다. `ledgerRoot`는 매 조회마다 실제 `/data/log/roles`를 읽어야 하며 `docker cp`로
한 번 복사한 ledger를 재개 판단에 사용하면 안 된다. 운영자는 Node22/git/Docker CLI/Compose가
있는 **신뢰된 controller helper 환경**에서 controller를 실행할 수 있다. 해당 helper에 named
workspaces volume을 `/engine-data:ro`로 연결하고 `ledgerRoot=/engine-data/log/roles`를 지정한다.
운영 bind 디렉터리의 state/launch/inbox는 host helper만 쓰며 launch/inbox만 엔진에 ro로 준다.
engine의 network namespace를 공유하면 CLI의 `engineURL=http://127.0.0.1:4000`을 유지할 수 있다.
Docker CLI/socket은 검증을 수행하는 trusted host/helper에만 두고 엔진·후보 검사 컨테이너에는
전달하지 않는다. helper 이미지/CLI/Compose 버전과 mount/권한을 운영자가 고정·검증한다.
이것은 새 상주 서비스가 아니라 외부 controller의 설치 방식이며 구현 세션에서 기동하지 않는다.

배포 운영자는 정확한 후보 SHA/image/controllerVersion·이전 버전·권한/mount를 기록한 뒤
Docker build, 기존 sandbox/readiness smoke와 전체 계약 검사를 수행해야 한다. 이후 승인된
새 단일 이슈에서 preflight 무변경, 한 번의 launch, 실제 모델 세션/ledger/작은 한도,
publication→host exact-head→병합/보존/종료를 관찰한다. 자연 코드 실패가 없으면 실제
모델 수정 재개는 미관찰로 남긴다. 이 PR의 모의 상태 전이 검사와 실제 설정 조회를 새 버전의
live Docker/GitHub/모델 통합 증거로 바꾸어 쓰지 않는다.

## 외부 완료된 중단 실행의 정리 (GH-22 후보, 별도 설치 필요)

`reconcile-external.mjs`는 원본 실행을 성공으로 바꾸지 않고, 외부 복구·검증·병합·배포가
완료된 중단 기록에 별도 `externally-reconciled` receipt를 연결한다. 최초 지원 범위는
GH20의 원본 Symphony 3/3과 외부 복구 4회다. `ledger`, enrollment, events, active_session,
in_flight, 원본 `launch.json` 및 controller journal 바이트는 그대로 남는다. 이 기능의
리뷰·배포 여부와 실제 운영 정리 성공은 별도 근거로 확인해야 한다.

운영자가 깨끗한 고정 checkout을 설치한 뒤 **별도의 private 설정 파일**을 준비한다.
기존 host config의 repo/issue/base, trustedRoot/controllerVersion, stateRoot/inboxRoot/
ledgerRoot/tokenFile/engineURL, authority와 check/reviewer 필드를 사용한다. 여기에 다음을
명시한다. 파일은 candidate checkout 및 `/data/workspaces` 밖에 있어야 한다.

| 설정 | 값과 근거 |
| --- | --- |
| `authority.reconcile`, `hold` | 명시적으로 `true`, `false`; label/comment는 권한 아님 |
| `launchRoot`, `gateRoot` | 현재 운영 launch/admission bind source의 canonical host 경로 |
| `pr`, `head`, `tree`, `merge` | 외부 완료 PR과 정확한 head/tree/merge SHA |
| `originalIterations`, `externalIterations` | 원본 3과 외부 4를 별도로 기록; 합치거나 초기화하지 않음 |
| `engineContainer`, `engineImage`, `productionProject` | 현재 healthy engine의 전체 container ID, immutable image ID, project |
| `operatorContainer`, `operatorImage`, `operatorSocketGroup` | container에서 실행할 때 실제 독립 helper 전체 ID, 고정 image, 기존 Docker socket group `1001` |
| `evidence` | 아래 8개 `{path, hash}`; hash는 **원본 파일 바이트 SHA-256** |

`evidence`의 고정 이름은 `ledger`, `enrollment`, `manifest`, `launchJournal`,
`controllerJournal`, `gate`, `recovery`, `validation`이다. 앞의 여섯 경로는 해당 scope의
기존 설치 경로와 정확히 일치해야 한다. controller journal이 없으면 그 경로와 `hash:null`로
부재 자체를 고정한다. 나머지는 원본 hash가 필수다. `recovery`는 GH20 외부 복구 완료
record (`fourth-complete-validated`, 정확한 PR/head/tree, 사용 횟수, Docker tests)를,
`validation`은 해당 merge/image의 실제 배포 검증 record (`status:deployed`)를 가리킨다.
원본 파일을 재직렬화해서 hash를 만들지 않는다. token 파일 내용은 이 evidence에 넣지 않는다.

```sh
node /operator/pinned/scripts/reconcile-external.mjs /operator/reconcile-gh20.json --check
node /operator/pinned/scripts/reconcile-external.mjs /operator/reconcile-gh20.json --apply
```

설치된 ledgerRoot가 `/engine-data/log/roles`이면 기존 외부 operator helper의 **실제 named
volume을 read-only로 연결**해 실행한다. host에 과거 ledger를 복사하거나 token을 복제하지
않는다. helper는 clean controller/config를 RO, state/inbox/launch/admission을 RW로 연결하고,
recovery/validation 원본 두 파일을 같은 absolute 경로에 각각 RO로 연결한다. 기존 `/tmp`와
Docker socket RW bind도 유지한다. mount 추가·중복은 거부한다. engine의 `/data`와 같은 live
named volume을 `/engine-data:ro`에, engine의 auth volume을 `/run/momoflow-auth:ro`에 연결한다.
tokenFile은 `/run/momoflow-auth/token.json`이다. bind 및 named-volume 대응은 fresh kernel
mount/stat metadata로 확인한다. helper bind의 Docker Source는 설정된 absolute host 경로와
정확히 같아야 하며 alias/translated source는 지원하지 않는다. 특히 다른 stateRoot에 journal을
복사한 구성은 거부한다. launch/admission/inbox backing은 helper 내부의 일치만으로 인정하지
않고 live engine의 해당 read-only bind와도 직접 대조한다. helper는 현재 engine과 다른 전체 ID·실제 hostname,
controller service label, 고정 image/default Env, user `1000:1000`, socket group, read-only root,
cap-drop ALL/no-new-privileges 및 현재 engine의 container network 연결을 검증한다. coding
engine 자체나 확인할 수 없는 helper는 거부한다. 새 권한·engine mount 변경은 필요 없다.
필요하면 `docker create`의 idle node helper ID를 config에 먼저 고정하고 start 후 `docker exec`로
위 CLI를 실행한다. command가 watch일 필요는 없으며 host 실행도 live ledger를 직접 볼 때만
가능하다. 설치/권한 검사를 생략하는 container flag는 없다.
host `/tmp`에 `.X11-unix` 등의 하위 mount가 있으면 helper의 `/tmp` bind에
`bind-recursive=disabled`를 지정해 상속하지 않는다. nested mount 검사를 완화하지 않는다.

`--check`는 파일·GitHub·worker·engine 상태를 읽고 적격성/이유를 제시하며 lock, archive,
manifest, admission 또는 원격 상태를 쓰지 않는다. `--apply`는 기존 launch/watch/deploy와
같은 `stateRoot/controller.lock`을 잡고 같은 검사를 다시 수행한다. Codex 또는 알 수 없는
engine child process, 불완전한 process 조회, running/retrying/claimed/blocked/pending 작업,
다른 unfinished owner나 stale lock이 있으면 중단한다. process 이름은 기존 init/BEAM/OTP
보조 프로세스만 허용한다. `docker top <engineID> -eo pid,comm`의 `PID COMMAND` 형식과
양의 고유 PID를 검사하고 전후 engine identity도 다시 확인한다. 일시적인 healthcheck `node`도 불확실한 상태로 거부하며 권한을
넓히거나 임의로 worker를 종료하지 않는다.

원본들은 `stateRoot/<scopeKey>/external-reconciliation/<evidenceId>/`에 exclusive 생성으로
보관하고, `external-reconciliation-intent.json`을 남긴다. idle admission fence가 engine에
확인된 뒤 원격 PR과 원본 바이트를 재검사하고, 정확히 일치하는 이전 `active.json`만
퇴역시킨다. engine의 manifest 부재까지 확인한 후 기존 admission gate를 원본 바이트로
복원·확인하고 `external-reconciliation.json`을 완료한다. 중단되면 같은 config/evidence로만
재개한다. manifest 부재와 미완료 receipt는 새 launch를 승인하지 않는다. crash가 남긴
shared lock은 자동 만료·삭제하지 않으며 운영자 확인 대상이다.

후속 **다른 이슈**의 trusted launch는 이 receipt와 archive 및 현재 원본 ledger/enrollment/
journal/외부 근거 hash를 다시 확인한 경우에만 해당 과거 owner를 조정된 기록으로 인정한다.
같은 이슈의 기존 ledger 채택·재실행은 여전히 거부한다. 자동 ready·새 manifest·후속 dispatch는
없다. 외부 근거 파일도 완료 후 불변으로 보존해야 한다. GH-24 후보는 같은 receipt 검증을
일반 배포 소유권 판단에도 연결한다. 정확한 live ledger/enrollment·archive·journal·scope가
일치하고 해당 manifest가 다시 활성화되지 않은 과거 owner만 인정한다.
[읽기 전용 소유권 검사](deployment.md#gh-24-후보-외부-완료-owner의-읽기-전용-검사)를 따르며,
배포 lifecycle·권한·검사 예외를 만들지 않는다. 후보 설치와 실운영 검사는 별도 경계다.

### Controller-only external completion v2 (GH-24)

기존 GH20 v1 receipt와 배포 증거 계약은 그대로 유지한다. `profile:"controller-only-v2"`는
원본 publish artifact의 숫자 issue 때문에 `Missing exact reviewed publication`으로 막힌
실행만 지원한다. 원본 ledger는 blocked/in-flight/active_session 및 review 완료 상태 그대로
보존한다. 이 runner 형식 오류는 [GH-26](https://github.com/sh0622-kim/momoflow/issues/26)의
별도 수정 범위이며 이 정리 과정은 publication을 고쳐 쓰지 않는다.

v2 설정은 `originalIterations:2`, `originalLimit:3`, `externalIterations:1`,
`controllerVersion:merge`, `controllerTree:tree`, 현재 `dataVolume`을 요구한다. 기존 여덟
근거 외에 `publishArtifact`, `review`, `tests`, `ownership`, `ownershipRequest`의 원본
바이트 hash를 고정한다. 추가 파일 다섯 개는 helper에서 같은 absolute 경로로 각각 RO
연결한다. key 파일이나 전체 현재 배포 bundle을 helper로 복사하지 않는다.

| 근거 | 필수 기록 |
| --- | --- |
| recovery | `kind:controller-external-attempt-v2`, status completed, originalUsed 2/limit 3/externalUsed 1/totalUsed 3, buildSession, originalHead, originalHashes (ledger/publishArtifact/launchJournal/manifest) |
| review | `kind:controller-external-review-v2`, status approved, model gpt-6-astra/reasoning high/fast false, buildSession과 다른 session |
| tests | `kind:controller-external-tests-v2`, status passed, tests ≥356/failures 0/skipped 0, node/syntax/diff 각각 exit 0 및 logHashes |
| validation | `kind:controller-install-v2`, status installed, commit/controllerVersion merge, controllerTree tree, engineUnchanged true, engineContainer/engineImage, ownershipHash |

위 네 기록은 모두 정확한 repo/string issue/pr/final reviewed head/tree를 포함한다. merge와
head는 달라도 tree는 같아야 한다. 설치된 clean controller의 실제 HEAD/tree도 검사한다.

`ownershipRequest`는 배포를 하지 않는 별도 current-only 계약이다. `ownershipVersion:1`,
`authority:{observe:true}`, `hold:false`, repo/issue/base, 설치 경로
(stateRoot/inboxRoot/launchRoot/gateRoot/trustedRoot/ledgerRoot/tokenFile), controllerVersion,
project/dataVolume/engineURL/verifyMs, 현재 manifest와 **current bundle 하나**를 고정한다.
current에는 기존 배포 bundle의 commit/image/authImage/runnerSource/composeFile/composeHash/
files/inspect를 사용한다. previous/target 및 deploy 권한은 필요 없다.

```sh
node /operator/pinned/scripts/deploy.mjs /operator/current-ownership.json --ownership-check
```

이 full CLI는 host에서 canonical Compose 파일과 engine/auth의 모든 bind source를 실제
kernel mount/stat 대응으로 검증한다. Docker Desktop의 opaque Source 문자열을 추측하거나
치환하지 않는다. default network의 Compose 직렬화 `ipam:{}`만 허용하며 nonempty/null/array는
거부한다. 실제 실행 권한·mount type/RW·runtime identity와 관찰 전후 container ID는 유지한다.
결과 JSON 전체를 `ownership` 근거로 보존한다. sourceRequest hash, 원본 ledger/enrollment hash,
manifest hash, runtime idle, controller lock 부재, engine/auth runtime 및 mount identity hash가
포함된다. 아직 조정하지 않은 원본 때문에 ownersIdle false인 것은 성공으로 위조하지 않는다.

정리 transaction은 엄격히 검증된 기존 helper에서 같은 live named volume/launch 및 두 서비스의
filesystem/runtime hash를 다시 읽어 host proof와 비교한다. key 내용·Env·token은 출력하지
않으며 helper key custody를 확장하지 않는다. 다른 owner/worker/lock, 변경된 hash/head/tree는
계속 차단한다. 기존 archive/fence/manifest 퇴역/idempotent retry 경로를 사용하며 원본 실행의
성공·예산 초기화·자동 ready/dispatch를 만들지 않는다. 완료 receipt는 보존된 근거를 검사하는
역사 기록이므로 이후 무관한 정상 engine/controller upgrade나 다른 manifest를 금지하지 않는다.

원본 한도를 초과한 **이 case의 외부 복구**는 원본 ledger 한도를 수정하지 않는다. 명시적
사용자 요청에 따라 운영자가 private config에 `authority.externalBudget:true`와
`externalBudget:{externalLimit:2,totalLimit:4}`를 고정하면 `externalIterations:2`를 기록할 수
있다. originalIterations 2/originalLimit 3은 계속 불변이다. 외부 사용량은 할당 이하이고
할당된 totalLimit은 originalIterations + externalLimit과 정확히 같아야 한다. 무한/비정수
한도나 근거 없는 추가 시도는 거부한다. 최초 v2의 2+1≤3 경우는 이 확장 없이 그대로 검증한다.

확장에는 추가 `evidence.authorization` 원본 파일을 같은 absolute 경로로 helper에 RO
연결해야 한다. 해당 record는 `kind:controller-external-budget-v1`,
`profile:controller-only-v2`, 정확한 repo/string issue/pr, originalIterations/originalLimit,
externalLimit/totalLimit, `source:explicit-user-request`, 비어 있지 않은 실제 `userRequest`와
기록한 `operator`, originalHashes(ledger/publishArtifact/launchJournal/manifest)를 포함한다.
label/comment나 공유 credential 자체는 사용자 승인 증거가 아니다. 이 record는 운영자가
확인한 구체적 요청과 할당을 보존하며 새 issue의 예산이나 일반 runner 정책을 바꾸지 않는다.
recovery record의 externalUsed/totalUsed에는 실제 외부 시도 수와 실제 합계(현재 2/4)를
기록한다. authorization도 immutable archive/receipt 및 매 transaction 재검사에 포함된다.

과거 receipt가 참조하는 외부 근거도 helper에서 원본 경로로 읽을 수 있어야 한다. 예를 들어
GH20의 recovery-status와 원본 deployment validation 파일은 각각 exact absolute path의 RO
bind로 연결한다. 허용 경로는 설정의 임의 추가 mount 목록이 아니라 **검증을 통과한 과거
receipt/archive/current original bytes**의 외부 evidence ref에서만 도출한다. 해당 파일의
현재 바이트 hash도 계속 재검사한다. exact Docker Source·RO·filesystem 대응을 모두 확인하며
광범위한 `.data` mount, 다른 경로에 복사한 파일 또는 archive를 source 대신 쓰는 방식은
허용하지 않는다. 실제 current ledger/enrollment와 journal 등의 기존 mount 계약은 유지한다.

원래 publication PR이 이미 병합된 뒤 같은 recovery의 별도 corrective PR이 필요하면 v2에
`originalPr`을 명시한다. 예: originalPr 25, `pr`은 새 corrective PR 번호다. 원본 numeric
publication artifact는 originalPr와 기존 originalHead 그대로 보존한다. recovery와 budget
authorization에도 originalPr을 기록하되, 두 record의 `pr` 및 review/tests/install의
pr/head/tree/merge는 **최종 corrective PR**과 정확히 일치해야 한다. 최종 controller 설치도
해당 corrective merge/tree여야 한다. originalPr을 생략한 기존 동일-PR v2는 pr을 원본 번호로
사용한다. 이 구분은 원본 PR을 재발행하거나 기존 artifact를 바꾸지 않는다. 현재 할당은
original 2/3 + external 3, 실제 합계 5이며 externalLimit 3/totalLimit 5를 별도 승인 근거에
고정한다.

live ownership의 manifestContract는 보존한 원본 manifest를 parse한 object의 digest와
대조한다. ledger.launch와 원본 manifest의 내용은 구조적으로 같아야 하지만 JSON key
삽입 순서는 달라도 된다. 원본 파일 바이트 hash와 archive는 계속 각각 검증하며, global
digest 규칙을 바꾸거나 ledger/manifest를 재직렬화해서 원본을 대체하지 않는다.
