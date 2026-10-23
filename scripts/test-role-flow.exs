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
