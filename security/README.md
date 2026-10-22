# Codex 컨테이너 샌드박스

Codex 0.163.0의 bubblewrap은 컨테이너 안에 별도 user/mount/IPC/PID/network namespace를
만든다. 기본 Docker seccomp에서는 해당 clone 호출이 EPERM으로 거부되어 모델은 응답해도
로컬 명령 실행이 시작되지 않았다. 이는 GitHub 인증이나 모델의 문제가 아니다.

`codex-seccomp.json`은 [Moby 기본 프로필](https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json)을
기반으로 다음 허용 규칙만 추가한 프로필이다. 기본값은 계속 `SCMP_ACT_ERRNO`다.
출처 커밋은 `6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef`이며 라이선스는
[LICENSE.moby](LICENSE.moby)에 보존한다. Docker 내장 프로필과 바이트 단위로 동일하다는
뜻은 아니므로 Docker 보안 업데이트 때 upstream 변경도 검토해야 한다.

| 호출 | 추가 허용 범위 | 실제 관찰된 용도 |
| --- | --- | --- |
| `clone` | amd64, flags `0x78020011`만 | NEWUSER + NEWNS + NEWIPC + NEWPID + NEWNET + SIGCHLD |
| `mount` | 호출 허용, 커널 capability 검사는 유지 | 새 mount namespace의 격리 파일시스템 구성 |
| `pivot_root` | 호출 허용, 커널 capability 검사는 유지 | 새 namespace 내부 루트 교체 |
| `umount2` | flags `MNT_DETACH`만 | 이전 루트 분리 |
| `unshare` | flags `CLONE_NEWUSER`만 | bubblewrap의 추가 user namespace 구성 |

이 예외는 syscall 접근면을 넓히므로 무위험한 변경은 아니다. 대신 `privileged`,
`CAP_SYS_ADMIN`, seccomp 전체 해제, legacy sandbox 전환은 사용하지 않는다.
비루트 UID, `cap_drop: ALL`, `no-new-privileges`, Codex workspace-write 및 네트워크 차단을
유지한다. 인증 컨테이너에는 이 프로필을 적용하지 않는다. 다른 아키텍처나 Codex 버전에서는
조용히 허용 범위를 늘리지 말고 재검증한다.

## 회귀 검사

`sh scripts/smoke.sh`는 상태 API·대시보드뿐 아니라 실제 `codex sandbox`로
`scripts/smoke-sandbox.mjs`를 실행한다. 모델 호출이나 실제 인증은 필요 없다.

- 작업공간 내 파일 쓰기 성공.
- 같은 UID로 원래 쓰기 가능한 작업공간 밖 canary의 변경 거절.
- 작업공간의 symlink를 통한 외부 파일 쓰기 거절.
- 컨테이너의 일반 프로세스에서 접근 가능한 TCP 서버에 샌드박스에서는 접근 불가.
- 컨테이너 바깥쪽 프로세스의 mount 권한이 여전히 없음.

검사는 인증·운영 작업 볼륨 없는 일회용 컨테이너에서 수행한다. 성공은 전체 커널 공격면의
안전성을 증명하는 것이 아니라, 이 복구에서 유지해야 할 경계의 회귀 근거다.

참고: [Docker seccomp 안내](https://docs.docker.com/engine/security/seccomp/).
