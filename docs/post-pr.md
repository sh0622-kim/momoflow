# PR 이후 호스트 조정 후보

상태: GH-7 후보 코드이며 **미배포·실제 호스트 통합 미검증**이다. 현재 운영 WORKFLOW와
기존 runner는 publish에서 종료한다. 이 문서의 설치는 구현 세션 밖 운영자의 작업이다.
이 후보를 개발 중인 세션이 자기 엔진이나 컨트롤러를 교체·기동하거나 자기 변경을 승인하지 않는다.

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
2. [배포 정책](deployment.md)에 따라 다음 엔진 버전을 별도로 검증·반영한다. 이미 실행 중인
   GH-7 세션/terminal ledger는 이 후보로 자동 migration하지 않는다. ledger 삭제·done→build
   수동 편집은 금지한다. GH-7 자체의 exact-head 검증/병합은 기존 위임 범위의 외부 운영자가
   수행하고 실제 통합 잔여 조건과 구분해 기록한다.
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
승인으로 해석하지 않는다. 후보는 자동 deployment나 목표 간 재귀를 수행하지 않는다.
