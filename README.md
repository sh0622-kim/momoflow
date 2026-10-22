# momoflow

에이전트가 주도하고, 작은 검증된 개선을 반복하며, 자기 자신도 발전시키는 개발 플로우 앱.

**개인용 웹 · Docker · Codex · Symphony 기반 · MVP first**

첫 버전은 upstream Symphony 기반 엔진과 내장 웹 대시보드를 사용한다.
momoflow는 자신의 개발 원칙과 재귀 개선 워크플로부터 소유한다. 자체 UI와 엔진 기능은
실제 사용에서 필요가 확인되는 순서대로 추가한다.

## 구성

```text
브라우저 → Symphony 웹 대시보드 (localhost:4000)
                  │
GitHub Issues → Symphony → 작업별 workspace → Codex app-server
                  │                              │
             WORKFLOW.md               구현 → 검증 → 리뷰 → 수정
                                                 │
                                       PR / 실행 근거 / 후속 개선
```

별도 앱 서버, DB, 큐, 스케줄러는 없다. 봇 인증 모드에는 토큰 갱신 전용 컨테이너 하나가 추가된다.
첫 작업 트래커는 Symphony가 지원하는 GitHub Issues를
사용한다. 프로젝트의 GitHub 저장소가 필요하며, 첫 대상은 momoflow 자체다.

## 시작하기

### GitHub App 봇 인증 (기본 운영 방식)

사람은 개인 GitHub 계정, 개발 에이전트는 GitHub App 설치 인증을 사용한다.
`.env.example`을 `.env`로 복사하고 다음 값을 입력한다. 개인 키 자체는 저장소 밖에 둔다.

```dotenv
GITHUB_REPO=owner/momoflow
GITHUB_APP_ID=your-app-id
GITHUB_INSTALLATION_ID=your-installation-id
GITHUB_APP_PRIVATE_KEY_FILE=/home/your-user/.config/momoflow/secrets/github-app.pem
COMPOSE_FILE=compose.yaml:compose.github-app.yaml
```

키 파일은 권한 `600`, 상위 디렉터리는 `700`으로 제한한다. 현재 컨테이너 UID는 `1000`이므로
호스트 키 소유자도 UID `1000`이어야 한다. 다른 UID 환경에서는 이미지 사용자를 조정한다.
호스트 Codex 로그인은 기존 방식으로 재사용한다.

```bash
docker compose build
sh scripts/start-github-app.sh
docker compose ps
```

`github-auth`만 개인 키를 읽는다. 대상 저장소로 제한한 설치 토큰을 만료 10분 전에 갱신하고,
권한 `600`의 공유 볼륨 파일을 원자적으로 교체한다. 실패하면 30초 간격으로 재시도한다.
Symphony와 Git 인증 helper는 요청마다 유효한 토큰 파일을 읽는다. 파일이 없거나 만료·손상되면
개인 계정 토큰으로 돌아가지 않고 인증을 실패시킨다. 토큰 갱신을 위해 엔진을 재시작하지 않는다.

개인 키는 Symphony나 작업 컨테이너에 마운트하지 않는다. 다만 설치 토큰 파일은 Symphony
컨테이너에서 읽을 수 있다. Codex의 읽기 접근까지 격리하는 보안 경계는 아니므로 에이전트를
불신하는 멀티테넌트 환경에는 적합하지 않다. 키·토큰·볼륨 내용을 출력하거나 커밋하지 않는다.
이 모드에서는 `GITHUB_TOKEN` 환경 변수를 비우며 GitHub App 권한 이상의 권한을 부여하지 않는다.

설치 권한: Contents/Issues/Pull requests 읽기·쓰기, Actions/Checks/Commit statuses 읽기,
Metadata 기본 읽기. Workflows·Administration 쓰기는 부여하지 않는다. 앱 인증 연결만으로
사람의 댓글·승인 자동 감지나 배포 자동화가 구현되는 것은 아니다.

```bash
node scripts/smoke-github-auth.mjs
docker run --rm --network none --mount "type=bind,src=$PWD/scripts,dst=/checks,readonly" \
  momoflow-symphony elixir -pa '_build/prod/lib/*/ebin' /checks/smoke-github-token-file.exs
sh scripts/smoke.sh
```

첫 명령은 가짜 응답으로 JWT·갱신·실패·만료를 검사한다. 두 번째는 실제 Symphony 클라이언트의
토큰 재읽기와 실패 처리를 네트워크 없이 검사한다. 실제 GitHub 인증 검증과 구분한다.
운영 중인 서비스 교체는 [배포 절차](docs/deployment.md)를 따른다.

### 현재 환경의 인증 재사용

개인 계정 인증을 의도적으로 사용하는 기존 방식이다. 봇 운영 중에는 아래 스크립트를 실행하지 않는다.
호스트에서 `gh`와 `codex`에 이미 로그인했다면 다음 명령으로 시작한다.

```bash
docker compose build
sh scripts/start-local.sh
```

GitHub 토큰은 기존 로그인에서 읽어 Compose 실행 환경으로만 전달한다. `.env`나 저장소에
토큰을 쓰지 않는다. Codex 인증은 stdin으로 전용 Docker 볼륨에 최초 복사하며 파일 권한은
`600`이다. 이후 컨테이너가 갱신한 인증을 보존하기 위해 기존 파일은 덮어쓰지 않는다.
호스트의 전체 Codex 설정이나 세션 디렉터리는 마운트하지 않는다. 저장소는 현재 GitHub
remote에서 확인하며 `GITHUB_REPO` 환경 변수로 지정할 수도 있다.

이 방식에서도 토큰은 컨테이너 환경에 있으므로 Docker 관리 권한이 있는 사용자는 읽을 수
있다. `docker compose config`의 전체 출력이나 컨테이너 환경을 외부에 공유하지 않는다.
호스트 재로그인 후에도 컨테이너 인증이 만료되어 있다면 컨테이너에서 다시 로그인한다.
인증 캐시 복사는 [공식 OpenAI 인증 문서](https://learn.chatgpt.com/docs/auth)에 설명된 방식이다.

### 새 인증으로 설정

Docker Engine과 Compose가 필요하다. 먼저 이 저장소를 GitHub에 준비하고 현재 파일들을
커밋·푸시한다. 엔진은 원격 저장소의 커밋된 코드를 복제하므로 로컬 미커밋 변경은 실행에
포함되지 않는다.

```bash
cp .env.example .env
```

`.env`에 `GITHUB_REPO=owner/momoflow`와 해당 저장소에 접근할 `GITHUB_TOKEN`을 설정한다.
토큰은 필요한 저장소로 범위를 제한하고 Issues, Contents, Pull requests의 읽기·쓰기
권한을 설정한다. CI 결과를 확인하려면 관련 읽기 권한도 필요하다. 자격 증명은 커밋하지 않는다.

```bash
docker compose config --quiet
docker compose build
sh scripts/smoke.sh
docker compose run --rm symphony codex login --device-auth
docker compose up -d
```

Codex 로그인은 전용 `codex-home` 볼륨에 보관된다. API 키 인증을 사용하는 경우에는
컨테이너에서 `codex login --with-api-key`의 stdin 입력 방식으로 로그인할 수 있다.
웹 주소는 **http://localhost:4000**이다.

```bash
docker compose ps
docker compose logs --tail=100 symphony
docker compose down
```

일반 `down`은 인증과 작업 볼륨을 보존한다. `down -v`는 해당 데이터를 삭제하므로 초기화가
필요할 때만 사용한다. 엔진의 헬스 체크는 HTTP 응답 여부이며, Codex 인증이나 실제 작업
완료까지 보증하지 않는다.

## 첫 작업 실행

1. GitHub 저장소에 `momoflow:ready` 라벨을 만든다.
2. 작은 목표, 변경 범위, 완료 조건, 반복 예산을 담은 이슈를 작성한다.
3. 실행할 이슈에만 `momoflow:ready`를 붙인다.
4. Symphony가 이슈를 가져와 Codex를 실행한다. 웹 대시보드에서 진행 상황을 확인한다.

에이전트는 구현·검증·리뷰·수정을 기본적으로 자율 수행한다. 세 번의 반복 후에도 해결되지
않으면 근거를 남기고 실행 라벨을 제거해 중단한다. 후속 개선 이슈를 제안할 수 있지만,
목표 간 자동 실행과 하드 예산 관리는 후속 단계다. [다음 작은 개선 후보](docs/roadmap.md)를
작은 시작점으로 사용할 수 있다.

## 실행 경계

- 호스트에는 localhost 포트만 공개한다. 인증 없는 개인용 구성이므로 팀 서비스로 노출하지 않는다.
- Docker 소켓이나 호스트 저장소를 에이전트에 마운트하지 않는다.
- 작업 공간과 로그는 `workspaces` 볼륨에 저장한다. 종료된 이슈의 작업 공간은 Symphony가 정리할 수 있다.
- Codex는 `workspace-write`로 실행한다. 샌드박스 밖 권한 요청은 기본 거절된다.
- 기본 샌드박스의 명령 네트워크 접근은 제한된다. 외부 의존성 설치가 필요하면 그 작업의
  요구를 확인한 뒤 제한된 준비 절차를 추가한다. 임의로 sandbox를 해제하지 않는다.
- GitHub 토큰은 Symphony가 호스트 측에서 사용한다. Codex에는 `github_api` 도구를 제공하고
  토큰과 토큰 파일 경로 환경 변수를 제거한다. 봇 모드의 clone hook에서는 Git helper도 단기 토큰 파일을 읽는다.
  파일 자체는 같은 컨테이너에서 읽을 수 있으므로 이를 완전한 자격 증명 격리로 표현하지 않는다.
- Dockerfile은 upstream의 실행 확인 플래그를 포함한다. 이 플래그는 upstream CLI의 필수
  조건이며, 실제 momoflow 실행 정책은 WORKFLOW.md에 명시한다.

## 기반 버전과 개발 원칙

- Symphony: `be10a1b79df723d6d7612b5651c8522704dafb2e`에 고정.
  `patches/github-token-file.patch` 하나만 적용한다. 고정 토큰만 지원하는 upstream의 관찰된 한계를
  보완해 요청마다 유효기간이 있는 토큰 파일을 읽는다. 스케줄러·실행 엔진은 변경하지 않는다.
- Codex CLI: `0.163.0`에 고정.
- upstream 소스의 LICENSE와 NOTICE는 이미지의 `/opt/symphony/`에 유지된다.
- [에이전트 개발 규칙](AGENTS.md) · [문서 지도](docs/README.md) · [GitHub 개선 흐름](docs/github-flow.md)

현재 구성은 부트스트랩이다. 실제 GitHub/Codex 자격 증명을 연결한 작업 실행 검증은 별도로
필요하다. 자체 대시보드, 지속적인 목표 간 자기개선, 자동 배포는 아직 구현하지 않았다.

빌드 중 upstream의 고정 의존성에서 Hex 보안 권고가 보고되었다(Bandit, Plug, Req 등).
현재는 원본 의존성을 유지하며, 외부 공개 전에 해당 권고의 영향과 업데이트를 검증해야 한다.

참고: [Symphony](https://github.com/openai/symphony),
[실행 명세](https://github.com/openai/symphony/blob/main/SPEC.md),
[Elixir 참조 구현](https://github.com/openai/symphony/blob/main/elixir/README.md).
