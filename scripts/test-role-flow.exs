# Contract tests: fake stage executor, real local Git snapshots, no model calls.
ExUnit.start()
Code.require_file("../engine/role_runner.ex", __DIR__)

defmodule RoleFlowTest do
  use ExUnit.Case, async: false
  alias SymphonyElixir.RoleRunner, as: R

  setup do
    root = Path.join(System.tmp_dir!(), "role-contract-#{System.unique_integer([:positive])}")
    workspace = Path.join(root, "workspace")
    File.mkdir_p!(workspace)
    git(workspace, ["init", "-q"])

    git(workspace, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture"
    ])

    on_exit(fn -> File.rm_rf!(root) end)

    opts = [
      repo: "fixture/repo",
      state_root: Path.join(root, "ledger"),
      initial_count: fn -> 0 end,
      eligible: fn _ -> :ok end,
      halt: fn _, reason ->
        send(self(), {:halt, reason})
        :ok
      end
    ]

    %{workspace: workspace, root: root, opts: opts}
  end

  defp git(w, args) do
    {text, 0} = System.cmd("git", args, cd: w, stderr_to_stdout: true)
    text
  end

  defp effective(role) do
    setting = R.settings(role)

    %{
      "model" => setting["model"],
      "reasoningEffort" => setting["config"]["model_reasoning_effort"],
      "serviceTier" => "default",
      "approvalPolicy" => R.denied_approvals(),
      "sandbox" => %{"type" => "workspaceWrite", "networkAccess" => false}
    }
  end

  defp executor(statuses, mutate \\ fn _, _ -> :ok end) do
    fn w, _, role, prompt, on_message ->
      send(self(), {:stage, role, prompt})
      mutate.(w, role)
      count = Process.get(:stages, 0) + 1
      Process.put(:stages, count)
      thread = "fake-thread-#{count}"

      session = %{
        thread_id: thread,
        session_id: "#{thread}-turn",
        turn_id: "turn",
        effective_settings: effective(role)
      }

      on_message.(Map.put(session, :event, :session_started))

      File.write!(
        Path.join(w, ".momoflow-role-result.json"),
        Jason.encode!(%{
          status: statuses.(role, count),
          summary: "contract evidence #{role}",
          checks: ["mock stage, no live calls"]
        })
      )

      {:ok, session}
    end
  end

  defp run(c, executor, extra \\ []) do
    R.run(
      c.workspace,
      %{id: "1"},
      "issue acceptance criteria",
      fn _ -> :ok end,
      Keyword.merge(c.opts, [run_stage: executor] ++ extra)
    )
  end

  defp ledger(c) do
    [path] = Path.wildcard(Path.join(c.root, "ledger/*.json"))
    Jason.decode!(File.read!(path))
  end

  test "admission is opt-in; configured missing/malformed controls fail closed", c do
    alias SymphonyElixir.Admission, as: A
    assert A.open?()
    System.put_env("MOMOFLOW_ADMISSION_ROOT", c.root)
    on_exit(fn -> System.delete_env("MOMOFLOW_ADMISSION_ROOT") end)
    refute A.open?()
    for value <- ["{", ~s({"v":1,"generation":"bad","paused":false}),
                   ~s({"v":1,"generation":"#{String.duplicate("a",64)}","paused":false,"extra":true})] do
      File.write!(Path.join(c.root,"active.json"),value)
      assert A.status().paused
      assert A.status().error == "invalid_gate"
    end
    File.write!(Path.join(c.root,"active.json"),Jason.encode!(%{v: 1,generation: String.duplicate("a",64),paused: false}))
    assert A.open?()
    System.delete_env("MOMOFLOW_ADMISSION_ROOT")
  end

  test "actual poll and retry dispatch remain fenced and retain claims/retry metadata", c do
    alias SymphonyElixir.Orchestrator, as: O
    connected(c)
    workflow=Path.join(c.root,"WORKFLOW.md")
    File.write!(workflow,String.replace(File.read!(workflow),"github","memory"))
    System.put_env("MOMOFLOW_ADMISSION_ROOT", c.root)
    on_exit(fn ->
      System.delete_env("MOMOFLOW_ADMISSION_ROOT")
      Application.delete_env(:symphony_elixir,:memory_tracker_issues)
    end)
    issue=struct(SymphonyElixir.Tracker.Issue,id: "1",identifier: "GH-1",title: "fixture",state: "open",labels: ["momoflow:ready"],dispatchable: true)
    Application.put_env(:symphony_elixir,:memory_tracker_issues,[issue])
    token=make_ref()
    retry=%{attempt: 1,retry_token: token,due_at_ms: 1,identifier: "GH-1",workspace_path: "/preserved",error: "prior error"}
    state=struct(O.State, claimed: MapSet.new(["1"]), retry_attempts: %{"1" => retry})
    # Missing gate fails closed at the REAL retry-message entrypoint, with memory tracker reads.
    {:noreply, retried}=O.handle_info({:retry_issue,"1",token},state)
    assert retried.claimed == state.claimed
    assert retried.running == %{}
    assert retried.retry_attempts["1"].attempt == 1
    assert retried.retry_attempts["1"].workspace_path == "/preserved"
    assert retried.retry_attempts["1"].error == "prior error"
    # Polling still reconciles, but cannot dispatch the eligible memory-tracker issue.
    {:noreply, polled}=O.handle_info(:run_poll_cycle,retried)
    assert polled.claimed == retried.claimed
    assert polled.running == %{}
    assert polled.retry_attempts == retried.retry_attempts
    File.write!(Path.join(c.root,"active.json"),Jason.encode!(%{v: 1,generation: String.duplicate("b",64),paused: true}))
    # Snapshot is acknowledged by the actual orchestrator handler, not an HTTP-only reader.
    {:reply,snapshot,_}=O.handle_call(:snapshot,nil,state)
    assert snapshot.admission.generation == String.duplicate("b",64)
    assert snapshot.admission.paused
    assert snapshot.admission.claimed == ["1"]
    assert snapshot.admission.retrying == ["1"]
    assert snapshot.admission.running == []
    assert snapshot.admission.pending_dispatch == false
    # Normal reconciliation of a now-absent issue releases the claim while admission stays closed.
    Application.put_env(:symphony_elixir,:memory_tracker_issues,[])
    {:noreply,released}=O.handle_info({:retry_issue,"1",retried.retry_attempts["1"].retry_token},retried)
    assert released.claimed == MapSet.new()
    assert released.retry_attempts == %{}
    assert released.running == %{}
    System.delete_env("MOMOFLOW_ADMISSION_ROOT")
  end

  test "actual upstream Orchestrator sums thread usage without resetting accumulated totals" do
    alias SymphonyElixir.Orchestrator, as: O
    entry = %{session_id: nil}

    state =
      struct(O.State,
        running: %{"1" => entry},
        codex_totals: %{
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          seconds_running: 0
        }
      )

    update = fn state, message ->
      {:noreply, state} =
        O.handle_info(
          {:codex_worker_update, "1", Map.put(message, :timestamp, DateTime.utc_now())},
          state
        )

      state
    end

    start = fn thread, turn ->
      %{event: :session_started, thread_id: thread, session_id: "#{thread}-#{turn}"}
    end

    usage = fn i, o ->
      %{
        event: :notification,
        payload: %{
          "method" => "thread/tokenUsage/updated",
          "params" => %{
            "tokenUsage" => %{
              "total" => %{
                "inputTokens" => i,
                "outputTokens" => o,
                "totalTokens" => i + o
              }
            }
          }
        }
      }
    end

    state = update.(state, start.("plan", "1"))
    state = update.(state, usage.(100, 20))
    state = update.(state, usage.(100, 20))
    # A new turn in the SAME thread must not reset its cumulative baseline.
    state = update.(state, start.("plan", "2"))
    state = update.(state, usage.(100, 20))
    state = update.(state, start.("build", "1"))
    state = update.(state, usage.(60, 10))
    state = update.(state, usage.(60, 10))

    assert Map.take(state.codex_totals, [:input_tokens, :output_tokens, :total_tokens]) ==
             %{input_tokens: 160, output_tokens: 30, total_tokens: 190}

    assert state.running["1"].codex_total_tokens == 190
    state = update.(state, start.("review", "1"))
    state = update.(state, usage.(10, 5))
    assert state.codex_totals.total_tokens == 205
    assert state.running["1"].codex_total_tokens == 205
  end

  for role <- ~w(plan build review publish) do
    @blocked_role role
    test "valid blocked #{@blocked_role} preserves evidence and stops subsequent roles", c do
      role = @blocked_role
      base = executor(fn _, _ -> "complete" end)

      exec = fn w, issue, current, prompt, handler ->
        {:ok, session} = base.(w, issue, current, prompt, handler)

        if current == role do
          File.write!(
            Path.join(w, ".momoflow-role-result.json"),
            Jason.encode!(%{
              status: "blocked",
              summary: "Acceptance failed: expected 42, observed 41",
              checks: ["offline numeric check failed: 41 != 42"]
            })
          )
        end

        {:ok, session}
      end

      assert :ok = run(c, exec)
      state = ledger(c)
      assert state["stage"] == "blocked"
      assert state["in_flight"] == false
      event = List.last(state["events"])
      assert event["role"] == role
      assert event["result"]["status"] == "blocked"
      assert event["session"]["effective_settings"] == effective(role)
      assert event["settings"] == R.settings(role)
      assert event["before"] == event["after"]
      assert event["before"] == R.snapshot!(c.workspace)
      assert is_binary(event["session"]["thread_id"])
      assert_received {:halt, reason}
      assert reason =~ "expected 42, observed 41"
      assert reason =~ "offline numeric check failed: 41 != 42"
      assert reason =~ "Ledger:"
      assert state["reason"] =~ "expected 42, observed 41"

      stages =
        for _ <- 1..length(state["events"]) do
          assert_receive {:stage, current, _}
          current
        end

      assert List.last(stages) == role
      refute_received {:stage, _, _}
    end
  end

  for role <- ~w(plan build review publish),
      {summary, checks, label} <- [
        {"", ["check passed"], "empty summary"},
        {" \n\t", ["check passed"], "blank summary"},
        {"meaningful result", [], "empty checks"},
        {"meaningful result", [""], "empty check item"},
        {"meaningful result", ["check passed", " \n\t"], "blank check item"}
      ] do
    @invalid_role role
    @invalid_summary summary
    @invalid_checks checks
    test "#{role} rejects #{label} before advancing", c do
      base = executor(fn _, _ -> "complete" end)

      exec = fn w, issue, role, prompt, handler ->
        result = base.(w, issue, role, prompt, handler)

        if role == @invalid_role do
          File.write!(
            Path.join(w, ".momoflow-role-result.json"),
            Jason.encode!(%{
              status: "complete",
              summary: @invalid_summary,
              checks: @invalid_checks
            })
          )
        end

        result
      end

      assert :ok = run(c, exec)
      state = ledger(c)
      assert state["stage"] == "blocked"
      assert state["reason"] =~ "summary or checks evidence"
      assert_received {:halt, _}
      for _ <- 1..(length(state["events"]) + 1), do: assert_receive({:stage, _, _})
      refute_received {:stage, _, _}
      refute Enum.any?(state["events"], &(&1["role"] == @invalid_role))
    end
  end

  test "plan, build, distinct review, Sol correction, rereview, publish share count", c do
    exec =
      executor(fn role, n ->
        if role == "review" and n == 3, do: "changes_requested", else: "complete"
      end)

    assert :ok = run(c, exec)
    state = ledger(c)
    assert state["stage"] == "done"
    assert state["iterations"] == 2
    assert Enum.map(state["events"], & &1["role"]) == ~w(plan build review build review publish)
    assert length(Enum.uniq_by(state["events"], & &1["session"]["thread_id"])) == 6

    assert Enum.map(state["events"], & &1["settings"]["model"]) ==
             ~w(gpt-6-astra gpt-6.1-sol gpt-6-astra gpt-6.1-sol gpt-6-astra gpt-6.1-sol)

    assert Enum.all?(state["events"], &(&1["settings"]["serviceTier"] == "default"))
    assert Enum.all?(state["events"], &is_binary(&1["after"]["head"]))
    assert :ok = run(c, exec)
    assert ledger(c)["iterations"] == 2
    assert_receive {:halt, _}
  end

  test "every role explains composite fingerprint without bypassing tree checks", c do
    exec = executor(fn _, _ -> "complete" end)

    inspect_prompt = fn w, issue, role, prompt, cb ->
      assert prompt =~ "engine-owned composite fingerprint, NOT a plain git diff SHA-256"
      assert prompt =~ "ordered untracked {path, Git mode, content or symlink target} tuples"
      assert prompt =~ "excluding .momoflow-role-result.json"
      assert prompt =~ "Do not compare it with sha256sum of git diff"
      assert prompt =~ "still rejects unauthorized tree changes"
      assert prompt =~ "this candidate's compiled module in the same workspace"
      assert prompt =~ "SymphonyElixir.RoleRunner.snapshot!(workspace)"
      exec.(w, issue, role, prompt, cb)
    end

    run(c, inspect_prompt)
    assert ledger(c)["stage"] == "done"
    assert Enum.map(ledger(c)["events"], & &1["role"]) == ~w(plan build review publish)
  end

  test "clean tree fingerprint uses Erlang composite rather than plain diff hash", c do
    snapshot = R.snapshot!(c.workspace)
    hash = fn bytes -> Base.encode16(:crypto.hash(:sha256, bytes), case: :lower) end
    assert snapshot["diff_sha256"] == hash.(:erlang.term_to_binary({"", []}))
    refute snapshot["diff_sha256"] == hash.("")
    File.write!(Path.join(c.workspace, ".momoflow-role-result.json"), "reserved")
    assert R.snapshot!(c.workspace) == snapshot
  end

  test "shared budget survives restart and never permits fourth build", c do
    exec =
      executor(fn role, _ -> if role == "review", do: "changes_requested", else: "complete" end)

    assert :ok = run(c, exec)
    state = ledger(c)
    assert state["iterations"] == 3
    assert state["stage"] == "blocked"
    assert Enum.count(state["events"], &(&1["role"] == "build")) == 3
    assert :ok = run(c, exec)
    assert ledger(c)["iterations"] == 3
  end

  defp enrolled(c, limit) do
    root = Path.join(c.root, "launch")
    inbox = Path.join(c.root, "inbox")
    File.mkdir_p!(root)
    File.mkdir_p!(inbox)
    manifest = %{"v" => 1, "id" => String.duplicate("a", 64), "repo" => "fixture/repo",
      "issue" => "1", "base" => "main", "limit" => limit}
    file = Path.join(root, "active.json")
    File.write!(file, Jason.encode!(manifest))
    {[launch_root: root, inbox_root: inbox], file, manifest}
  end

  for limit <- 1..3 do
    @limit limit
    test "persisted launch limit #{@limit} prevents next actual build executor, including restart", c do
      {opts, _, manifest} = enrolled(c, @limit)
      exec = executor(fn role, _ -> if role == "review", do: "changes_requested", else: "complete" end)
      run(c, exec, opts)
      state = ledger(c)
      assert state["iterations"] == @limit
      assert state["launch"] == manifest
      assert state["stage"] == "blocked"
      assert Enum.count(state["events"], &(&1["role"] == "build")) == @limit
      # This counts actual executor invocations, rather than just testing arithmetic.
      calls = Stream.repeatedly(fn -> receive do {:stage, role, _} -> role after 0 -> nil end end)
        |> Enum.take_while(& &1)
      assert Enum.count(calls, &(&1 == "build")) == @limit
      run(c, fn _, _, _, _, _ -> flunk("No new executor after restart") end, opts)
      assert ledger(c)["iterations"] == @limit
    end
  end

  for fault <- [:delete, :change, :malformed, :disabled] do
    @fault fault
    test "enrolled launch fails closed after #{@fault} across same-PR host resume", c do
      {exec, connected_opts, inbox} = connected(c)
      {launch_opts, file, manifest} = enrolled(c, 2)
      opts = Keyword.merge(connected_opts, launch_opts)
      run(c, exec, opts)
      assert ledger(c)["stage"] == "await_validation"
      host_exchange(c, inbox, "code_failure")
      case @fault do
        :delete -> File.rm!(file)
        :change -> File.write!(file, Jason.encode!(Map.put(manifest, "limit", 3)))
        :malformed -> File.write!(file, "{")
        :disabled -> :ok
      end
      opts = if @fault == :disabled, do: Keyword.put(opts, :launch_root, nil), else: opts
      run(c, fn _, _, _, _, _ -> flunk("Changed/deleted contract must not dispatch") end, opts)
      assert ledger(c)["iterations"] == 1
      assert ledger(c)["launch"] == manifest
      assert ledger(c)["stage"] == "blocked"
    end
  end

  test "enrollment prevents single-session fallback after BOTH opt-in flags are removed", c do
    {exec, connected_opts, _} = connected(c)
    {launch_opts, _, _} = enrolled(c, 2)
    run(c, exec, Keyword.merge(connected_opts, launch_opts))
    flags = ~w(MOMOFLOW_ROLE_FLOW MOMOFLOW_LAUNCH_ROOT)
    old = Map.new(flags, &{&1, System.get_env(&1)})
    Enum.each(flags, &System.delete_env/1)
    on_exit(fn -> Enum.each(old, fn {k,v} -> if v, do: System.put_env(k,v), else: System.delete_env(k) end) end)
    assert R.required?(%{id: "1"}, state_root: Path.join(c.root, "ledger"))
    run(c, fn _, _, _, _, _ -> flunk("No single-session or role fallback") end, Keyword.put(connected_opts, :launch_root, nil))
    assert ledger(c)["stage"] == "blocked"
    assert ledger(c)["iterations"] == 1
  end

  test "installed capability identifies actual runner source/config and mount access", c do
    connected(c)
    status = R.launch_status()
    assert status.contract == 1
    assert status.repo == "fixture/repo"
    assert status.source == Base.encode16(:crypto.hash(:sha256, File.read!(Path.expand("../engine/role_runner.ex", __DIR__))), case: :lower)
    assert status.launch_root == nil
    refute status.launch_read_only
    assert is_boolean(status.inbox_read_only)
  end

  test "capability reads and validates the engine-visible manifest without enrollment", c do
    connected(c)
    {opts, file, manifest} = enrolled(c, 2)
    assert R.launch_status(opts).manifest == %{status: "present", value: manifest}
    for {key, value} <- [{"id", String.duplicate("b", 64)}, {"limit", 1}, {"base", "other"}, {"issue", "2"}] do
      changed = Map.put(manifest, key, value)
      File.write!(file, Jason.encode!(changed))
      assert R.launch_status(opts).manifest == %{status: "present", value: changed}
    end
    for invalid <- ["{", "[]", Jason.encode!(Map.put(manifest, "limit", 4)), Jason.encode!(Map.put(manifest, "repo", "other/repo")), Jason.encode!(Map.put(manifest, "extra", true))] do
      File.write!(file, invalid)
      assert R.launch_status(opts).manifest == %{status: "invalid"}
    end
    File.rm!(file)
    assert R.launch_status(opts).manifest == %{status: "absent"}
    File.ln_s!("missing", file)
    assert R.launch_status(opts).manifest == %{status: "invalid"}
    refute File.exists?(Path.join(c.root, "ledger"))
  end

  test "two-limit runner and real host exchange allow final review/publish but forbid third correction", c do
    {exec, connected_opts, inbox} = connected(c)
    {launch_opts, _, _} = enrolled(c, 2)
    opts = Keyword.merge(connected_opts, launch_opts)
    run(c, exec, opts)
    assert host_exchange(c, inbox, "code_failure") =~ "correction"
    run(c, exec, opts)
    state = ledger(c)
    assert state["iterations"] == 2
    assert state["stage"] == "await_validation"
    assert Enum.map(Enum.take(state["events"], -3), & &1["role"]) == ~w(build review publish)
    [ledger_path] = Path.wildcard(Path.join(c.root, "ledger/*.json"))
    {out, status} = System.cmd("node", [Path.join(__DIR__, "post-pr-exchange-fixture.mjs"), ledger_path, inbox, "code_failure"], stderr_to_stdout: true)
    assert status != 0
    assert out =~ "budget exhausted 2/2"
    # Retained stale inbox cannot start a third build on restart either.
    run(c, fn _, _, _, _, _ -> flunk("Third build must not start") end, opts)
    assert ledger(c)["iterations"] == 2
  end

  test "enrollment tombstone blocks reseeding a missing ledger", c do
    {opts, _, _} = enrolled(c, 1)
    run(c, executor(fn _, _ -> "blocked" end), opts)
    [path] = Path.wildcard(Path.join(c.root, "ledger/*.json"))
    File.rm!(path) # Simulated storage fault, never operator recovery advice.
    run(c, fn _, _, _, _, _ -> flunk("Missing enrolled ledger cannot reseed") end, opts)
    assert ledger(c)["stage"] == "blocked"
    assert ledger(c)["iterations"] == nil
    assert ledger(c)["reason"] =~ "Enrolled ledger missing"
  end

  test "legacy ledger is never automatically adopted into launch mode", c do
    run(c, executor(fn _, _ -> "blocked" end))
    {opts, _, _} = enrolled(c, 2)
    run(c, fn _, _, _, _, _ -> flunk("Legacy adoption forbidden") end, opts)
    assert ledger(c)["stage"] == "blocked"
    assert ledger(c)["reason"] =~ "legacy ledger adoption"
  end

  test "already exhausted workpad prevents any model call", c do
    exec = fn _, _, _, _, _ -> flunk("must not run a role") end
    run(c, exec, initial_count: fn -> 3 end)
    assert ledger(c)["stage"] == "blocked"
    assert ledger(c)["events"] == []
  end

  test "mismatched effective settings stop without fallback", c do
    exec = executor(fn _, _ -> "complete" end)

    bad = fn w, i, r, p, cb ->
      {:ok, s} = exec.(w, i, r, p, cb)
      {:ok, put_in(s, [:effective_settings, "model"], "wrong-model")}
    end

    run(c, bad)
    assert ledger(c)["stage"] == "blocked"
    assert ledger(c)["events"] == []
    assert ledger(c)["active_session"]["thread_id"] == "fake-thread-1"
  end

  test "failed stage persists in-flight evidence; restart does not repeat", c do
    exec = fn _, _, _, _, cb ->
      cb.(%{
        event: :session_started,
        thread_id: "failed-thread",
        turn_id: "turn",
        session_id: "failed-session"
      })

      {:error, :model_unavailable}
    end

    run(c, exec)
    assert ledger(c)["active_session"]["thread_id"] == "failed-thread"
    assert ledger(c)["in_flight"]
    run(c, fn _, _, _, _, _ -> flunk("no restart") end)
    assert ledger(c)["stage"] == "blocked"
  end

  test "review cannot modify candidate unnoticed", c do
    exec =
      executor(fn _, _ -> "complete" end, fn w, role ->
        if role == "review", do: File.write!(Path.join(w, "intrusion"), "changed")
      end)

    run(c, exec)
    assert ledger(c)["stage"] == "blocked"
    assert ledger(c)["reason"] =~ "changed the reviewed tree"
    assert Enum.map(ledger(c)["events"], & &1["role"]) == ~w(plan build)
  end

  test "missing result cannot count as success", c do
    run(c, fn _, _, _, _, _ ->
      {:ok, %{thread_id: "id", session_id: "id-turn", effective_settings: effective("plan")}}
    end)

    assert ledger(c)["stage"] == "blocked"
  end

  test "cancelled eligibility starts no role", c do
    run(c, fn _, _, _, _, _ -> flunk("cancelled") end, eligible: fn _ -> raise "cancelled" end)
    assert ledger(c)["events"] == []
  end

  test "snapshot detects untracked executable mode changes", c do
    file = Path.join(c.workspace, "new-script")
    File.write!(file, "target")
    File.chmod!(file, 0o644)
    before = R.snapshot!(c.workspace)
    File.chmod!(file, 0o755)
    refute before == R.snapshot!(c.workspace)
    File.chmod!(file, 0o644)
    assert before == R.snapshot!(c.workspace)
  end

  test "snapshot detects same-content regular file becoming a symlink", c do
    file = Path.join(c.workspace, "new-link")
    File.write!(file, "target")
    before = R.snapshot!(c.workspace)
    File.rm!(file)
    File.ln_s!("target", file)
    refute before == R.snapshot!(c.workspace)
  end

  defp github_workflow(c, repo) do
    old_env = Map.new(~w(GITHUB_REPO GITHUB_TOKEN_FILE), &{&1, System.get_env(&1)})
    System.put_env("GITHUB_REPO", "fixture/repo")
    System.delete_env("GITHUB_TOKEN_FILE")

    config = %{
      "tracker" => %{
        "kind" => "github",
        "active_states" => ["open"],
        "terminal_states" => ["closed"],
        "provider" => %{"repo" => repo, "token" => "fixture-not-a-credential"}
      }
    }

    path = Path.join(c.root, "WORKFLOW.md")
    File.write!(path, "---\n#{Jason.encode!(config)}\n---\nfixture")
    SymphonyElixir.Workflow.set_workflow_file_path(path)

    on_exit(fn ->
      SymphonyElixir.Workflow.clear_workflow_file_path()

      Enum.each(old_env, fn {key, value} ->
        if value, do: System.put_env(key, value), else: System.delete_env(key)
      end)
    end)
  end

  for repo <- ["fixture/repo", "$GITHUB_REPO", nil, " fixture/repo "] do
    for outcome <- [:complete, :ineligible, :failure, :no_workpad, :blocked] do
      @tag repo: repo, outcome: outcome
      test "default GitHub paths #{inspect(repo)} / #{outcome}", c do
        github_workflow(c, c.repo)
        pad = %{"id" => 42, "body" => "<!-- momoflow:workpad -->\n| 누적 반복 | 0/3 |"}
        comments = if c.outcome == :no_workpad, do: [], else: [pad]

        transport = fn method, path, params, body, settings ->
          assert settings.repo == "fixture/repo"
          send(self(), {:request, method, path, params, body})

          case {method, path} do
            {"GET", "/repos/fixture/repo/issues/1/comments"} ->
              assert params == %{"per_page" => 100}
              {:ok, %{status: 200, body: comments}}

            {"GET", "/repos/fixture/repo/issues/1"} ->
              labels = if c.outcome == :ineligible, do: [], else: [%{"name" => "momoflow:ready"}]
              {:ok, %{status: 200, body: %{"state" => "open", "labels" => labels}}}

            {"DELETE", "/repos/fixture/repo/issues/1/labels/momoflow%3Aready"} ->
              {:ok, %{status: 200, body: []}}

            {"GET", "/repos/fixture/repo/issues/1/labels"} ->
              {:ok, %{status: 200, body: []}}

            {"PATCH", "/repos/fixture/repo/issues/comments/42"} ->
              assert body["body"] =~ pad["body"]
              assert body["body"] =~ "Ready removal verified"

              if c.outcome == :blocked do
                assert body["body"] =~ "plan blocked: contract evidence plan"
                assert body["body"] =~ "mock stage, no live calls"
                assert body["body"] =~ "Ledger:"
                assert length(ledger(c)["events"]) == 1
              end

              {:ok, %{status: 200, body: %{}}}

            {"POST", "/repos/fixture/repo/issues/1/comments"} ->
              assert body["body"] =~ "<!-- momoflow:workpad -->"
              {:ok, %{status: 201, body: %{}}}

            other ->
              flunk("Unexpected request: #{inspect(other)}")
          end
        end

        exec =
          if c.outcome in [:ineligible, :failure] do
            fn _, _, _, _, _ -> raise "fixture stage failure" end
          else
            executor(fn _, _ -> if c.outcome == :blocked, do: "blocked", else: "complete" end)
          end

        # Keep all default workpad, eligibility, halt and comment-update functions.
        opts =
          c.opts
          |> Keyword.drop([:repo, :initial_count, :eligible, :halt])
          |> Keyword.merge(request_fun: transport, run_stage: exec)

        assert :ok == R.run(c.workspace, %{id: "1"}, "fixture", fn _ -> :ok end, opts)

        assert ledger(c)["stage"] ==
                 if(c.outcome in [:ineligible, :failure, :blocked], do: "blocked", else: "done")

        key = Base.encode16(:crypto.hash(:sha256, "fixture/repo:1"), case: :lower)
        assert File.exists?(Path.join(c.root, "ledger/#{key}.json"))
        assert_receive {:request, "GET", "/repos/fixture/repo/issues/1/comments", _, _}
        assert_receive {:request, "GET", "/repos/fixture/repo/issues/1", _, _}

        assert_receive {:request, "DELETE",
                        "/repos/fixture/repo/issues/1/labels/momoflow%3Aready", _, _}

        assert_receive {:request, "GET", "/repos/fixture/repo/issues/1/labels", _, _}
        assert_receive {:request, "GET", "/repos/fixture/repo/issues/1/comments", _, _}

        if c.outcome == :no_workpad do
          assert_receive {:request, "POST", "/repos/fixture/repo/issues/1/comments", _, _}
        else
          assert_receive {:request, "PATCH", "/repos/fixture/repo/issues/comments/42", _, _}
        end

        if c.outcome == :ineligible, do: assert(ledger(c)["events"] == [])
      end
    end
  end

  test "invalid repo is rejected before any transport or role starts", c do
    github_workflow(c, "owner/repo/extra")

    opts =
      c.opts
      |> Keyword.drop([:repo, :initial_count, :eligible, :halt])
      |> Keyword.merge(
        request_fun: fn _, _, _, _, _ -> flunk("invalid repo request") end,
        run_stage: fn _, _, _, _, _ -> flunk("invalid repo role") end
      )

    assert_raise ArgumentError, fn ->
      R.run(c.workspace, %{id: "1"}, "fixture", fn _ -> :ok end, opts)
    end

    assert Path.wildcard(Path.join(c.root, "ledger/*.json")) == []
  end

  test "settings reject missing effort, Fast tier, approvals and network changes" do
    for role <- ~w(plan build review publish) do
      base = effective(role)
      assert :ok == R.verify_settings(base, R.settings(role), R.denied_approvals())

      for response <- [
            Map.delete(base, "reasoningEffort"),
            Map.put(base, "serviceTier", "fast"),
            Map.put(base, "approvalPolicy", "never"),
            Map.put(base, "sandbox", "invalid"),
            put_in(base, ["sandbox", "networkAccess"], true),
            nil
          ] do
        assert {:error, :role_settings_mismatch} ==
                 R.verify_settings(response, R.settings(role), R.denied_approvals())
      end
    end
  end

  test "corrupt ledger is preserved and never starts another role", c do
    File.mkdir_p!(Path.join(c.root, "ledger"))
    key = Base.encode16(:crypto.hash(:sha256, "fixture/repo:1"), case: :lower)
    path = Path.join(c.root, "ledger/#{key}.json")
    File.write!(path, "broken ledger bytes")
    run(c, fn _, _, _, _, _ -> flunk("corrupt ledger must stop") end)
    assert File.read!(path <> ".corrupt") == "broken ledger bytes"
    assert ledger(c)["stage"] == "blocked"
    assert ledger(c)["iterations"] == nil
  end

  test "workpad count is strict, and comments cannot authorize budget expansion" do
    pad = fn text -> %{"body" => "<!-- momoflow:workpad -->\n| 누적 반복 | #{text} |"} end
    assert R.count_from_comments!([]) == 0
    assert R.count_from_comments!([pad.("2 / 3")]) == 2
    assert_raise RuntimeError, fn -> R.count_from_comments!([pad.("3/6")]) end
    assert_raise RuntimeError, fn -> R.count_from_comments!([pad.("3/6\n누적 반복 0/3")]) end
    assert_raise RuntimeError, fn -> R.count_from_comments!([pad.("0/30")]) end
    assert_raise RuntimeError, fn -> R.count_from_comments!([pad.("1/3"), pad.("1/3")]) end

    assert_raise RuntimeError, fn ->
      R.count_from_comments!(List.duplicate(%{"body" => "ordinary comment"}, 100))
    end
  end

  defp connected(c) do
    config_path = Path.join(c.root, "WORKFLOW.md")

    File.write!(
      config_path,
      "---\n" <>
        Jason.encode!(%{
          "tracker" => %{
            "kind" => "github",
            "active_states" => ["open"],
            "terminal_states" => ["closed"],
            "required_labels" => ["momoflow:ready"],
            "provider" => %{"repo" => "fixture/repo", "token" => "fixture-not-a-credential"}
          }
        }) <> "\n---\nfixture"
    )

    SymphonyElixir.Workflow.set_workflow_file_path(config_path)
    on_exit(fn -> SymphonyElixir.Workflow.clear_workflow_file_path() end)
    inbox = Path.join(c.root, "inbox")
    File.mkdir_p!(inbox)
    base = executor(fn _, _ -> "complete" end)

    exec = fn w, i, role, prompt, cb ->
      {:ok, session} = base.(w, i, role, prompt, cb)

      if role == "publish" do
        file = Path.join(w, ".momoflow-role-result.json")
        result = Jason.decode!(File.read!(file))

        publication = %{
          "repo" => "fixture/repo",
          "issue" => "1",
          "pr" => 2,
          "base" => "main",
          "head" => String.duplicate("a", 40)
        }

        File.write!(file, Jason.encode!(Map.put(result, "publication", publication)))
      end

      {:ok, session}
    end

    transport = fn method, path, _, _, _ ->
      body =
        cond do
          path =~ "/git/commits/" ->
            %{"tree" => %{"sha" => R.tree!(c.workspace)}}

          method == "GET" and path =~ "/pulls/2" ->
            %{
              "state" => "open",
              "head" => %{
                "sha" => String.duplicate("a", 40),
                "repo" => %{"full_name" => "fixture/repo"}
              },
              "base" => %{
                "ref" => "main",
                "sha" => String.duplicate("9", 40),
                "repo" => %{"full_name" => "fixture/repo"}
              }
            }
        end

      {:ok, %{status: 200, body: body}}
    end

    {exec, [inbox_root: inbox, request_fun: transport], inbox}
  end

  defp expected_publication_scope(prompt) do
    [_, json] = Regex.run(~r/Engine-owned expected publication scope \(JSON\): ([^\n]+)/, prompt)
    Jason.decode!(json)
  end

  test "legacy no-inbox publish has no connected publication contract", c do
    exec = executor(fn _, _ -> "complete" end)
    run(c, fn w, i, role, prompt, cb ->
      refute prompt =~ "Engine-owned expected publication scope"
      exec.(w, i, role, prompt, cb)
    end)
    assert ledger(c)["stage"] == "done"
  end

  test "publish receives JSON string scope without inventing a legacy base", c do
    {exec, opts, _} = connected(c)
    inspect_prompt = fn w, i, role, prompt, cb ->
      if role == "publish" do
        assert expected_publication_scope(prompt) == %{"repo" => "fixture/repo", "issue" => "1"}
        assert prompt =~ "Before any GitHub API side effect"
        assert prompt =~ "never a JSON number"
        assert prompt =~ "positive JSON integer"
        assert prompt =~ "actual published commit SHA"
        assert prompt =~ "Check the serialized result's types and exact scope"
      else
        refute prompt =~ "Engine-owned expected publication scope"
      end
      exec.(w, i, role, prompt, cb)
    end
    run(c, inspect_prompt, opts)
    assert ledger(c)["stage"] == "await_validation"
    assert ledger(c)["publication"]["issue"] === "1"
  end

  test "publish receives the trusted launch base", c do
    {exec, opts, _} = connected(c)
    {launch_opts, file, manifest} = enrolled(c, 3)
    File.write!(file, Jason.encode!(Map.put(manifest, "base", "release")))
    run(c, fn w, i, role, prompt, cb ->
      if role == "publish" do
        assert expected_publication_scope(prompt) == %{"repo" => "fixture/repo", "issue" => "1", "base" => "release"}
      end
      exec.(w, i, role, prompt, cb)
    end, Keyword.merge(opts, launch_opts))
    assert ledger(c)["reason"] =~ "Launch base mismatch"
  end

  for {field, value} <- [
        {"issue", 1}, {"issue", nil}, {"issue", true}, {"issue", []}, {"issue", %{}},
        {"issue", :missing}, {"issue", "2"}, {"repo", "other/repo"},
        {"pr", "2"}, {"pr", 0}, {"base", "other"},
        {"head", String.duplicate("b", 40)}, {"head", "invalid"}
      ] do
    @publication_field field
    @publication_value value
    test "publication rejects #{@publication_field}=#{inspect(value)}", c do
      {exec, opts, _} = connected(c)
      run(c, fn w, i, role, prompt, cb ->
        result = exec.(w, i, role, prompt, cb)
        if role == "publish" do
          file = Path.join(w, ".momoflow-role-result.json")
          data = Jason.decode!(File.read!(file))
          p = if @publication_value == :missing,
            do: Map.delete(data["publication"], @publication_field),
            else: Map.put(data["publication"], @publication_field, @publication_value)
          File.write!(file, Jason.encode!(Map.put(data, "publication", p)))
        end
        result
      end, opts)
      state = ledger(c)
      assert state["stage"] == "blocked"
      expected = if @publication_field == "base" or
                    (@publication_field == "head" and @publication_value != "invalid"),
        do: "Published tree/head/base mismatch", else: "Missing exact reviewed publication"
      assert state["reason"] == expected
      refute state["publication"]
    end
  end

  test "publication still rejects a remote tree that differs from the reviewed tree", c do
    {exec, opts, _} = connected(c)
    transport = opts[:request_fun]
    opts = Keyword.put(opts, :request_fun, fn method, path, params, body, config ->
      if path =~ "/git/commits/",
        do: {:ok, %{status: 200, body: %{"tree" => %{"sha" => String.duplicate("0", 40)}}}},
        else: transport.(method, path, params, body, config)
    end)
    run(c, exec, opts)
    assert ledger(c)["reason"] == "Published tree/head/base mismatch"
  end

  test "publish cannot change the reviewed snapshot", c do
    {exec, opts, _} = connected(c)
    run(c, fn w, i, role, prompt, cb ->
      result = exec.(w, i, role, prompt, cb)
      if role == "publish", do: File.write!(Path.join(w, "unreviewed"), "changed")
      result
    end, opts)
    assert ledger(c)["reason"] == "publish changed the reviewed tree"
    refute ledger(c)["publication"]
  end

  defp host_exchange(c, inbox, kind) do
    [path] = Path.wildcard(Path.join(c.root, "ledger/*.json"))

    {out, code} =
      System.cmd("node", [Path.join(__DIR__, "post-pr-exchange-fixture.mjs"), path, inbox, kind],
        stderr_to_stdout: true
      )

    assert code == 0, out
    out
  end

  test "full production exchange: publish, host code failure, same-PR correction, separate review, revalidate/finalize",
       c do
    {exec, opts, inbox} = connected(c)
    run(c, exec, opts)
    first = ledger(c)
    assert first["stage"] == "await_validation", inspect(first["reason"])
    assert first["publication"]["tree"] == R.tree!(c.workspace)
    assert host_exchange(c, inbox, "code_failure") =~ "correction"
    diagnostic_exec = fn w, i, role, prompt, cb ->
      if role == "publish" do
        assert expected_publication_scope(prompt) == %{"repo" => "fixture/repo", "issue" => "1", "base" => "main"}
        assert prompt =~ "Reuse the prior publication's PR/base"
        assert prompt =~ Jason.encode!(first["publication"])
      end
      if role == "build" do
        assert prompt =~ "contract_failure_example: expected 1, received 2"
        assert prompt =~ first["publication"]["head"]
      end
      exec.(w, i, role, prompt, cb)
    end
    run(c, diagnostic_exec, opts)
    second = ledger(c)
    assert second["iterations"] == 2
    assert second["stage"] == "await_validation"
    assert Enum.take(second["events"], length(first["events"])) == first["events"]
    assert Enum.map(Enum.take(second["events"], -3), & &1["role"]) == ~w(build review publish)
    assert second["publication"]["pr"] == first["publication"]["pr"]
    assert second["publication"]["review_thread"] != first["publication"]["review_thread"]
    assert host_exchange(c, inbox, "passed") =~ "done"
    # Old inbox is retained as evidence but cannot authorize another correction.
    run(c, fn _, _, _, _, _ -> flunk("replayed request must not run") end, opts)
    assert ledger(c)["iterations"] == 2
    assert ledger(c)["stage"] == "blocked"
  end

  test "third correction may review/publish, fourth build is forbidden across restart", c do
    {exec, opts, inbox} = connected(c)
    run(c, exec, opts)

    for expected <- [2, 3] do
      host_exchange(c, inbox, "code_failure")
      run(c, exec, opts)
      assert ledger(c)["iterations"] == expected
      assert ledger(c)["stage"] == "await_validation"
    end

    [path] = Path.wildcard(Path.join(inbox, "*.json"))
    envelope = Jason.decode!(File.read!(path))
    state = ledger(c)

    envelope =
      Map.merge(envelope, %{
        "publication" => state["publication"],
        "generation" => length(state["events"]),
        "id" => String.duplicate("f", 64)
      })

    File.write!(path, Jason.encode!(envelope))
    run(c, fn _, _, _, _, _ -> flunk("fourth build forbidden") end, opts)
    assert ledger(c)["iterations"] == 3
    assert ledger(c)["reason"] =~ "exhausted"
  end

  for fault <- [:generation, :head, :in_flight, :workspace, :missing, :crash] do
    @resume_fault fault
    test "resume fails safely: #{fault}", c do
      {exec, opts, inbox} = connected(c)
      run(c, exec, opts)
      host_exchange(c, inbox, "code_failure")
      [file] = Path.wildcard(Path.join(inbox, "*.json"))
      envelope = Jason.decode!(File.read!(file))

      case @resume_fault do
        :generation ->
          File.write!(file, Jason.encode!(Map.put(envelope, "generation", 0)))

        :head ->
          File.write!(
            file,
            Jason.encode!(put_in(envelope, ["publication", "head"], String.duplicate("0", 40)))
          )

        :in_flight ->
          [path] = Path.wildcard(Path.join(c.root, "ledger/*.json"))
          File.write!(path, Jason.encode!(Map.put(ledger(c), "in_flight", true)))

        :workspace ->
          File.write!(Path.join(c.workspace, "unreviewed"), "changed")

        :missing ->
          File.rm!(file)

        :crash ->
          :ok
      end

      runner =
        if @resume_fault == :crash,
          do: fn _, _, _, _, _ -> raise "crash after durable build consumption" end,
          else: fn _, _, _, _, _ -> flunk("invalid request started model") end

      run(c, runner, opts)
      used = if @resume_fault == :crash, do: 2, else: 1
      assert ledger(c)["iterations"] == used
      assert ledger(c)["stage"] == "blocked"

      if @resume_fault == :crash do
        assert ledger(c)["in_flight"]
        assert List.last(ledger(c)["events"])["resume_id"] == envelope["id"]
      end

      run(c, fn _, _, _, _, _ -> flunk("interrupted execution replayed") end, opts)
      assert ledger(c)["iterations"] == used
    end
  end

  test "Git tree matches real Git including mode/symlink/deletion/new file", c do
    File.write!(Path.join(c.workspace, "deleted"), "delete")
    File.write!(Path.join(c.workspace, "script"), "script")
    git(c.workspace, ["add", "."])

    git(c.workspace, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=f@invalid",
      "commit",
      "-qm",
      "files"
    ])

    File.rm!(Path.join(c.workspace, "deleted"))
    File.chmod!(Path.join(c.workspace, "script"), 0o755)
    File.mkdir_p!(Path.join(c.workspace, "dir"))
    File.write!(Path.join(c.workspace, "dir/new"), "new")
    File.ln_s!("script", Path.join(c.workspace, "link"))
    tree = R.tree!(c.workspace)
    git(c.workspace, ["add", "-A"])
    assert tree == String.trim(git(c.workspace, ["write-tree"]))
  end

  test "actual upstream retry releases absent-ready claim, then dispatch honors ready/claim/single slot",
       c do
    connected(c)
    alias SymphonyElixir.Orchestrator, as: O
    alias SymphonyElixir.Tracker.Issue

    issue =
      struct(Issue,
        id: "1",
        identifier: "GH-1",
        title: "fixture",
        state: "open",
        labels: [],
        dispatchable: true
      )

    state = struct(O.State, max_concurrent_agents: 1, claimed: MapSet.new(["1"]))
    refute O.should_dispatch_issue_for_test(issue, state)
    released = O.handle_retry_issue_lookup_for_test(issue, state, "1", 1, %{})
    refute MapSet.member?(released.claimed, "1")
    ready = %{issue | labels: ["momoflow:ready"]}
    assert O.should_dispatch_issue_for_test(ready, released)
    refute O.should_dispatch_issue_for_test(ready, %{released | claimed: MapSet.new(["1"])})

    refute O.should_dispatch_issue_for_test(ready, %{
             released
             | running: %{"other" => %{issue: ready, worker_host: nil}}
           })

    assert {:skip, ^issue} =
             O.revalidate_issue_for_dispatch_for_test(ready, fn ["1"] -> {:ok, [issue]} end)

    assert {:ok, ^ready} =
             O.revalidate_issue_for_dispatch_for_test(ready, fn ["1"] -> {:ok, [ready]} end)
  end
end

defmodule RoleRPCContractTest do
  use ExUnit.Case, async: false
  alias SymphonyElixir.Codex.AppServer
  alias SymphonyElixir.RoleRunner, as: R

  setup do
    root = Path.join(System.tmp_dir!(), "role-rpc-#{System.unique_integer([:positive])}")
    w = Path.join(root, "workspace")
    File.mkdir_p!(Path.join(w, ".git"))

    config = %{
      "tracker" => %{
        "kind" => "github",
        "active_states" => ["open"],
        "terminal_states" => ["closed"],
        "provider" => %{"repo" => "fixture/repo", "token" => "fixture-not-a-credential"}
      },
      "workspace" => %{"root" => root},
      "codex" => %{
        "command" => "node #{Path.join(__DIR__, "fixture-codex-rpc.mjs")}",
        "approval_policy" => R.denied_approvals(),
        "thread_sandbox" => "workspace-write",
        "read_timeout_ms" => 3000
      }
    }

    path = Path.join(root, "WORKFLOW.md")
    File.write!(path, "---\n#{Jason.encode!(config)}\n---\nfixture")
    SymphonyElixir.Workflow.set_workflow_file_path(path)

    on_exit(fn ->
      SymphonyElixir.Workflow.clear_workflow_file_path()
      File.rm_rf!(root)
    end)

    %{workspace: w}
  end

  test "patched Symphony sends role overrides and returns separate thread/settings evidence", c do
    sessions =
      Enum.map(~w(plan build review build), fn role ->
        {:ok, s} = AppServer.start_session(c.workspace, role_settings: R.settings(role))

        try do
          assert :ok ==
                   R.verify_settings(s.effective_settings, R.settings(role), R.denied_approvals())

          assert {:ok, %{thread_id: id, turn_id: "fixture-turn"}} =
                   AppServer.run_turn(s, "fixture", %{
                     id: "1",
                     identifier: "GH-1",
                     title: "fixture"
                   })

          assert id == s.thread_id
          id
        after
          AppServer.stop_session(s)
        end
      end)

    assert length(Enum.uniq(sessions)) == 4

    requests =
      File.read!(Path.join(c.workspace, ".git/mock-rpc.jsonl"))
      |> String.split("\n", trim: true)
      |> Enum.map(&Jason.decode!/1)

    starts = Enum.filter(requests, &(&1["method"] == "thread/start"))

    assert Enum.map(starts, & &1["params"]["model"]) ==
             ~w(gpt-6-astra gpt-6.1-sol gpt-6-astra gpt-6.1-sol)

    assert Enum.all?(starts, &(&1["params"]["serviceTier"] == "default"))
    assert Enum.all?(starts, &(&1["params"]["approvalPolicy"] == R.denied_approvals()))
  end

  test "settings mismatch rejects session before any turn", c do
    File.write!(Path.join(c.workspace, ".git/rpc-mode"), "mismatch")

    assert {:error, :role_settings_mismatch} =
             AppServer.start_session(c.workspace, role_settings: R.settings("plan"))

    refute File.read!(Path.join(c.workspace, ".git/mock-rpc.jsonl")) =~ "turn/start"
  end

  test "turn/completed with failed status is an error", c do
    File.write!(Path.join(c.workspace, ".git/rpc-mode"), "failed")
    {:ok, s} = AppServer.start_session(c.workspace, role_settings: R.settings("build"))

    try do
      assert {:error, {:unsuccessful_turn, "failed"}} =
               AppServer.run_turn(s, "fixture", %{id: "1", identifier: "GH-1", title: "fixture"})
    after
      AppServer.stop_session(s)
    end
  end
end
