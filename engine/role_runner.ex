defmodule SymphonyElixir.RoleRunner do
  @moduledoc "Sequential, fail-closed role flow for the personal GitHub deployment."
  alias SymphonyElixir.Codex.AppServer
  alias SymphonyElixir.GitHub.Client
  alias SymphonyElixir.Config

  @roles %{
    "plan" => {"gpt-6-astra", "high"},
    "build" => {"gpt-6.1-sol", "medium"},
    "review" => {"gpt-6-astra", "high"},
    "publish" => {"gpt-6.1-sol", "medium"}
  }

  def settings(role) do
    {model, effort} = Map.fetch!(@roles, role)
    %{"model" => model, "serviceTier" => "default",
      "config" => %{"model_reasoning_effort" => effort}}
  end

  def verify_settings(_response, role, _approval) when role == %{}, do: :ok
  def verify_settings(response, role, approval) do
    expected = %{"model" => role["model"], "reasoningEffort" => role["config"]["model_reasoning_effort"],
      "serviceTier" => "default", "approvalPolicy" => approval}
    sandbox = response["sandbox"] || %{}
    if Map.take(response, Map.keys(expected)) == expected and
         sandbox["type"] == "workspaceWrite" and sandbox["networkAccess"] == false and
         approval == denied_approvals() do
      :ok
    else
      {:error, :role_settings_mismatch}
    end
  end

  def denied_approvals do
    %{"granular" => Map.new(~w(sandbox_approval rules mcp_elicitations request_permissions skill_approval), &{&1, false})}
  end

  def run(workspace, issue, prompt, on_message, opts \\ []) do
    root = Keyword.get(opts, :state_root, "/data/log/roles")
    File.mkdir_p!(root)
    key = Base.encode16(:crypto.hash(:sha256, issue.id), case: :lower)
    path = Path.join(root, key <> ".json")
    # Symphony has one worker per issue. An in-flight record survives worker death/retry.
    try do
      state = load(path, issue, opts)
      if state["stage"] in ~w(blocked done) or state["in_flight"] do
        halt!("Existing terminal or interrupted role flow; inspect ledger before resuming")
      end
      advance(path, state, workspace, issue, prompt, on_message, opts)
    rescue
      error ->
        state = if File.exists?(path), do: Jason.decode!(File.read!(path)), else: %{"issue" => issue.id}
        save(path, Map.merge(state, %{"stage" => "blocked", "reason" => Exception.message(error)}))
        Keyword.get(opts, :halt, &halt_issue/2).(issue, Exception.message(error))
    end
  end

  defp load(path, issue, opts) do
    if File.exists?(path) do
      state = Jason.decode!(File.read!(path))
      if state["issue"] != issue.id, do: halt!("Ledger issue mismatch")
      state
    else
      used = Keyword.get(opts, :initial_count, fn -> workpad_count!(issue) end).()
      if used not in 0..3, do: halt!("Invalid shared iteration count")
      state = %{"issue" => issue.id, "stage" => "plan", "iterations" => used, "events" => [], "in_flight" => false}
      save(path, state)
      state
    end
  end

  defp advance(path, state, workspace, issue, prompt, on_message, opts) do
    role = state["stage"]
    count = state["iterations"] + if(role == "build", do: 1, else: 0)
    if count > 3, do: halt!("Shared three-iteration budget exhausted")
    before = snapshot!(workspace)
    state = Map.merge(state, %{"iterations" => count, "in_flight" => true})
    save(path, state)
    result_path = Path.join(workspace, ".git/momoflow-role-result.json")
    File.rm(result_path)
    role_prompt = role_prompt(prompt, state, result_path, before)
    run_stage = Keyword.get(opts, :run_stage, &run_stage/5)
    {:ok, session} = run_stage.(workspace, issue, role, role_prompt, on_message)
    after_snapshot = snapshot!(workspace)
    if role in ~w(plan review publish) and before != after_snapshot do
      halt!("#{role} changed the reviewed tree")
    end
    result = Jason.decode!(File.read!(result_path))
    unless is_binary(result["summary"]) and byte_size(result["summary"]) <= 8000 and is_list(result["checks"]) do
      halt!("Missing bounded summary or checks evidence")
    end
    next = next_stage(role, result["status"])
    event = %{"role" => role, "iteration" => count, "settings" => settings(role),
      "session" => session, "before" => before, "after" => after_snapshot,
      "result" => result, "at" => DateTime.to_iso8601(DateTime.utc_now())}
    state = Map.merge(state, %{"stage" => next, "in_flight" => false,
      "events" => state["events"] ++ [event]})
    save(path, state)
    if next == "done" do
      halt_issue(issue, "Role flow complete; PR checks/reviews and deployment remain separate. Ledger: #{path}")
    else
      advance(path, state, workspace, issue, prompt, on_message, opts)
    end
  end

  def next_stage("plan", "complete"), do: "build"
  def next_stage("build", "complete"), do: "review"
  def next_stage("review", "complete"), do: "publish"
  def next_stage("review", "changes_requested"), do: "build"
  def next_stage("publish", "complete"), do: "done"
  def next_stage(_, _), do: halt!("Missing, blocked or invalid role result; no fallback")

  defp run_stage(workspace, issue, role, prompt, on_message) do
    with {:ok, session} <- AppServer.start_session(workspace, role_settings: settings(role)) do
      try do
        AppServer.run_turn(session, prompt, issue, on_message: on_message)
      after
        AppServer.stop_session(session)
      end
    end
  end

  defp role_prompt(prompt, state, result_path, snapshot) do
    role = state["stage"]
    task = case role do
      "plan" -> "Only inspect. Give short scope, acceptance criteria and work order. Do not implement or publish."
      "build" -> "Implement/correct the smallest change, validate it, update the existing workpad. Do not publish, merge, close the issue or change execution labels. Address the recorded review findings."
      "review" -> "Independently inspect the ACTUAL diff, HEAD, acceptance criteria and validation evidence. Do not modify code or publish. Report concrete findings and use changes_requested if any remain. A complete verdict is not a human approval."
      "publish" -> "Preserve the reviewed result in ONE PR using the repository template and github_api. Update the existing workpad with ledger evidence. Do not change code, merge, close the issue, deploy or dispatch successors. State checks/review still needed for the exact PR head."
    end
    """
    #{prompt}

    Engine role: #{role}. #{task}
    These stage instructions narrow the general workflow above. Stop after this stage.
    Shared implementation/validation/review iterations used: #{state["iterations"]}/3.
    Never reset this count. Fast remains OFF. Do not spawn other agents or change settings.
    Target tree: #{Jason.encode!(snapshot)}
    Prior role evidence (including independent review findings): #{Jason.encode!(state["events"])}
    Write a JSON result to #{result_path} before ending:
    {"status":"complete|changes_requested|blocked","summary":"bounded scope/plan or concrete findings and resolution","checks":["actual checks and results; separate mock, settings query and live calls"]}
    Only review may use changes_requested. Missing/invalid evidence stops execution.
    Do not edit engine ledger files. An exit alone is not success evidence.
    """
  end

  def snapshot!(workspace) do
    head = git!(workspace, ["rev-parse", "HEAD"])
    diff = git!(workspace, ["diff", "--binary", "HEAD"])
    others = git!(workspace, ["ls-files", "--others", "--exclude-standard", "-z"])
      |> String.split(<<0>>, trim: true)
      |> Enum.map(fn p -> {p, File.read!(Path.join(workspace, p))} end)
    %{"head" => String.trim(head), "diff_sha256" =>
      Base.encode16(:crypto.hash(:sha256, :erlang.term_to_binary({diff, others})), case: :lower)}
  end

  defp git!(workspace, args) do
    case System.cmd("git", args, cd: workspace, stderr_to_stdout: true) do
      {output, 0} -> output
      _ -> halt!("Cannot identify actual HEAD/diff")
    end
  end

  defp workpad_count!(issue) do
    repo = Config.settings!().tracker.provider["repo"]
    {:ok, %{status: 200, body: comments}} = Client.request("GET", "/repos/#{repo}/issues/#{issue.id}/comments", %{"per_page" => 100}, nil)
    pads = Enum.filter(comments, &String.contains?(&1["body"] || "", "<!-- momoflow:workpad -->"))
    case pads do
      [] -> 0
      [pad] ->
        case Regex.run(~r/누적 반복[^\n]*?([0-3])\s*\/\s*3/, pad["body"]) do
          [_, count] -> String.to_integer(count)
          _ -> halt!("Cannot seed shared count from existing workpad")
        end
      _ -> halt!("Multiple workpads; cannot seed shared count")
    end
  end

  defp halt_issue(issue, reason) do
    repo = Config.settings!().tracker.provider["repo"]
    # Remove only dispatch eligibility; no automatic promotion or closure.
    base = "/repos/#{repo}/issues/#{issue.id}"
    case Client.request("DELETE", base <> "/labels/momoflow%3Aready", %{}, nil) do
      {:ok, %{status: status}} when status in [200, 404] -> :ok
      _ -> halt!("Unable to remove dispatch label; operator intervention required")
    end
    {:ok, %{status: 200, body: labels}} = Client.request("GET", base <> "/labels", %{}, nil)
    if Enum.any?(labels, &(&1["name"] == "momoflow:ready")), do: halt!("Dispatch label remains")
    require Logger
    Logger.warning("Role flow stopped issue=#{issue.id}: #{reason}")
    :ok
  end

  defp save(path, state) do
    File.write!(path <> ".tmp", Jason.encode!(state))
    File.rename!(path <> ".tmp", path)
  end
  defp halt!(reason), do: raise(RuntimeError, reason)
end
