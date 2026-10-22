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
