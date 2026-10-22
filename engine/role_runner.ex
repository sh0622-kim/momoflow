defmodule SymphonyElixir.RoleRunner do
  @moduledoc "Sequential, fail-closed role flow for the personal GitHub deployment."
  alias SymphonyElixir.Codex.AppServer
  alias SymphonyElixir.GitHub.Client
  alias SymphonyElixir.Config
  require Logger

  @roles %{
    "plan" => {"gpt-6-astra", "high"},
    "build" => {"gpt-6.1-sol", "medium"},
    "review" => {"gpt-6-astra", "high"},
    "publish" => {"gpt-6.1-sol", "medium"}
  }

  def settings(role) do
    {model, effort} = Map.fetch!(@roles, role)

    %{
      "model" => model,
      "serviceTier" => "default",
      "config" => %{"model_reasoning_effort" => effort}
    }
  end

  def verify_settings(_response, role, _approval) when role == %{}, do: :ok

  def verify_settings(response, role, approval) when is_map(response) do
    expected = %{
      "model" => role["model"],
      "reasoningEffort" => role["config"]["model_reasoning_effort"],
      "serviceTier" => "default",
      "approvalPolicy" => approval
    }

    sandbox = response["sandbox"] || %{}

    if Map.take(response, Map.keys(expected)) == expected and
         is_map(sandbox) and sandbox["type"] == "workspaceWrite" and
         sandbox["networkAccess"] == false and
         approval == denied_approvals() do
      :ok
    else
      {:error, :role_settings_mismatch}
    end
  end

  def verify_settings(_, _, _), do: {:error, :role_settings_mismatch}

  def denied_approvals do
    %{
      "granular" =>
        Map.new(
          ~w(sandbox_approval rules mcp_elicitations request_permissions skill_approval),
          &{&1, false}
        )
    }
  end

  def run(workspace, issue, prompt, on_message, opts \\ []) do
    root = Keyword.get(opts, :state_root, "/data/log/roles")
    File.mkdir_p!(root)

    repo =
      Keyword.get_lazy(opts, :repo, fn ->
        {:ok, repo} = Client.resolved_repo(Config.settings!().tracker)
        repo
      end)

    opts = Keyword.put(opts, :repo, repo)

    key =
      Base.encode16(
        :crypto.hash(
          :sha256,
          repo <>
            ":" <> issue.id
        ),
        case: :lower
      )

    path = Path.join(root, key <> ".json")
    # Symphony has one worker per issue. An in-flight record survives worker death/retry.
    try do
      state = load(path, issue, opts)
      validate_state!(state)
      if state["iterations"] >= 3, do: halt!("Shared three-iteration budget exhausted")

      if state["stage"] in ~w(blocked done) or state["in_flight"] do
        halt!("Existing terminal or interrupted role flow; inspect ledger before resuming")
      end

      advance(path, state, workspace, issue, prompt, on_message, opts)
    rescue
      error ->
        state = stop_state(path, issue)

        save(
          path,
          Map.merge(state, %{"stage" => "blocked", "reason" => Exception.message(error)})
        )

        Keyword.get(opts, :halt, fn issue, reason -> halt_issue(issue, reason, opts) end).(
          issue,
          "#{Exception.message(error)}; shared iterations=#{inspect(state["iterations"])}/3"
        )

        :ok
    end
  end

  defp stop_state(path, issue) do
    if File.exists?(path) do
      case Jason.decode(File.read!(path)) do
        {:ok, state} when is_map(state) ->
          state

        _ ->
          # Preserve corrupt bytes for inspection; never replace them with a fresh budget.
          backup = path <> ".corrupt"
          unless File.exists?(backup), do: File.cp!(path, backup)
          %{"issue" => issue.id, "iterations" => nil, "corrupt_backup" => backup}
      end
    else
      %{"issue" => issue.id, "iterations" => nil}
    end
  end

  defp load(path, issue, opts) do
    if File.exists?(path) do
      state = Jason.decode!(File.read!(path))
      if state["issue"] != issue.id, do: halt!("Ledger issue mismatch")
      state
    else
      used = Keyword.get(opts, :initial_count, fn -> workpad_count!(issue, opts) end).()
      if not is_integer(used) or used not in 0..3, do: halt!("Invalid shared iteration count")

      state = %{
        "issue" => issue.id,
        "stage" => "plan",
        "iterations" => used,
        "events" => [],
        "in_flight" => false
      }

      save(path, state)
      state
    end
  end

  defp advance(path, state, workspace, issue, prompt, on_message, opts) do
    :ok = Keyword.get(opts, :eligible, fn issue -> eligible_issue(issue, opts) end).(issue)
    role = state["stage"]
    count = state["iterations"] + if(role == "build", do: 1, else: 0)
    if count > 3, do: halt!("Shared three-iteration budget exhausted")
    if role == "plan" and count >= 3, do: halt!("No implementation budget remains")
    before = snapshot!(workspace)
    state = Map.merge(state, %{"iterations" => count, "in_flight" => true})
    save(path, state)
    result_path = Path.join(workspace, ".momoflow-role-result.json")

    if git!(workspace, ["ls-files", "--", ".momoflow-role-result.json"]) != "",
      do: halt!("Reserved result file is tracked")

    case File.rm(result_path) do
      :ok -> :ok
      {:error, :enoent} -> :ok
      _ -> halt!("Cannot clear prior role result")
    end

    role_prompt = role_prompt(prompt, state, result_path, before)
    run_stage = Keyword.get(opts, :run_stage, &run_stage/5)

    handler = fn message ->
      if message[:event] == :session_started do
        save(
          path,
          Map.put(state, "active_session", Map.take(message, [:session_id, :thread_id, :turn_id]))
        )
      end

      on_message.(message)
    end

    {:ok, session} = run_stage.(workspace, issue, role, role_prompt, handler)

    unless is_binary(session[:thread_id]) and is_binary(session[:session_id]) and
             not Enum.any?(state["events"], &(&1["session"]["thread_id"] == session[:thread_id])) do
      halt!("Missing or reused role session identity")
    end

    :ok = verify_settings(session[:effective_settings], settings(role), denied_approvals())
    after_snapshot = snapshot!(workspace)

    if role in ~w(plan review publish) and before != after_snapshot do
      halt!("#{role} changed the reviewed tree")
    end

    stat = File.lstat!(result_path)

    unless stat.type == :regular and stat.size <= 65536,
      do: halt!("Invalid or oversized role result")

    result = Jason.decode!(File.read!(result_path))

    unless is_binary(result["summary"]) and byte_size(result["summary"]) <= 8000 and
             is_list(result["checks"]) and length(result["checks"]) <= 30 and
             Enum.all?(result["checks"], &(is_binary(&1) and byte_size(&1) <= 2000)) do
      halt!("Missing bounded summary or checks evidence")
    end

    next = next_stage(role, result["status"])

    event = %{
      "role" => role,
      "iteration" => count,
      "settings" => settings(role),
      "session" => session,
      "before" => before,
      "after" => after_snapshot,
      "result" => result,
      "at" => DateTime.to_iso8601(DateTime.utc_now())
    }

    state =
      Map.merge(state, %{
        "stage" => next,
        "in_flight" => false,
        "events" => state["events"] ++ [event],
        "active_session" => nil
      })

    save(path, state)

    if next == "done" do
      Keyword.get(opts, :halt, fn issue, reason -> halt_issue(issue, reason, opts) end).(
        issue,
        "Role flow complete; shared iterations=#{count}/3; PR checks/reviews and deployment remain separate. Ledger: #{path}"
      )
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
        case AppServer.run_turn(session, prompt, issue, on_message: on_message) do
          {:ok, result} -> {:ok, Map.put(result, :effective_settings, session.effective_settings)}
          other -> other
        end
      after
        AppServer.stop_session(session)
      end
    end
  end

  defp role_prompt(prompt, state, result_path, snapshot) do
    role = state["stage"]

    task =
      case role do
        "plan" ->
          "Only inspect. Give short scope, acceptance criteria and work order. Do not implement or publish."

        "build" ->
          "Implement/correct the smallest change, validate it, update the existing workpad. Do not publish, merge, close the issue or change execution labels. Address the recorded review findings."

        "review" ->
          "Independently inspect the ACTUAL diff, HEAD, acceptance criteria and validation evidence. Do not modify code or publish. Report concrete findings and use changes_requested if any remain. A complete verdict is not a human approval."

        "publish" ->
          "Preserve the reviewed result in ONE PR using the repository template and github_api. Use GitHub API to materialize the exact reviewed HEAD + tracked/untracked diff without requiring local .git writes. Record the published PR head and compare its complete file contents to the reviewed candidate. Exclude the reserved result file. Update the existing workpad with ledger evidence. Do not change code, merge, close the issue, deploy or dispatch successors. State checks/review still needed for the exact PR head."
      end

    """
    #{prompt}

    Engine role: #{role}. #{task}
    These stage instructions narrow the general workflow above. Stop after this stage.
    Shared implementation/validation/review iterations used: #{state["iterations"]}/3.
    Never reset this count. Fast remains OFF. Do not spawn other agents or change settings.
    Target tree: #{Jason.encode!(snapshot)}
    Prior role evidence (including independent review findings): #{Jason.encode!(state["events"])}
    Planning and review are sequential, separate sessions, not parallel delegation.
    Write a JSON result to #{result_path} before ending:
    {"status":"complete|changes_requested|blocked","summary":"bounded scope/plan or concrete findings and resolution","checks":["actual checks and results; separate mock, settings query and live calls"]}
    Only review may use changes_requested. Missing/invalid evidence stops execution.
    Do not edit engine ledger files. An exit alone is not success evidence.
    """
  end

  def snapshot!(workspace) do
    head = git!(workspace, ["rev-parse", "HEAD"])
    diff = git!(workspace, ["diff", "--binary", "HEAD"])

    others =
      git!(workspace, ["ls-files", "--others", "--exclude-standard", "-z"])
      |> String.split(<<0>>, trim: true)
      |> Enum.reject(&(&1 == ".momoflow-role-result.json"))
      |> Enum.map(fn p ->
        full = Path.join(workspace, p)

        stat = File.lstat!(full)

        {mode, value} =
          case stat.type do
            :symlink ->
              {"120000", File.read_link!(full)}

            :regular ->
              mode = if Bitwise.band(stat.mode, 0o100) != 0, do: "100755", else: "100644"
              {mode, File.read!(full)}

            _ ->
              halt!("Unsupported untracked file type")
          end

        {p, mode, value}
      end)

    %{
      "head" => String.trim(head),
      "diff_sha256" =>
        Base.encode16(:crypto.hash(:sha256, :erlang.term_to_binary({diff, others})), case: :lower)
    }
  end

  defp git!(workspace, args) do
    case System.cmd("git", args, cd: workspace, stderr_to_stdout: true) do
      {output, 0} -> output
      _ -> halt!("Cannot identify actual HEAD/diff")
    end
  end

  # A workpad is a progress record, never authority for a higher budget.
  def count_from_comments!(comments) do
    if length(comments) >= 100, do: halt!("Workpad pagination requires operator inspection")

    case Enum.filter(comments, &String.contains?(&1["body"] || "", "<!-- momoflow:workpad -->")) do
      [] ->
        0

      [pad] ->
        row = pad["body"] |> String.split("\n") |> Enum.find(&String.contains?(&1, "누적 반복"))

        case row && Regex.run(~r/누적 반복[^\n]*?([0-9]+)\s*\/\s*([0-9]+)/, row) do
          [_, count, "3"] ->
            String.to_integer(count)

          _ ->
            halt!(
              "Cannot seed default budget from latest workpad row; issue exceptions need operator handoff"
            )
        end

      _ ->
        halt!("Multiple workpads; cannot seed shared count")
    end
  end

  defp workpad_count!(issue, opts) do
    {:ok, %{status: 200, body: comments}} =
      request("GET", issue_path(issue, opts) <> "/comments", %{"per_page" => 100}, nil, opts)

    count_from_comments!(comments)
  end

  defp eligible_issue(issue, opts) do
    {:ok, %{status: 200, body: current}} = request("GET", issue_path(issue, opts), %{}, nil, opts)

    unless current["state"] == "open" and
             Enum.any?(current["labels"] || [], &(&1["name"] == "momoflow:ready")),
           do: halt!("Issue no longer eligible; no next role started")

    :ok
  end

  defp repo_path(opts) do
    repo =
      opts
      |> Keyword.fetch!(:repo)
      |> String.split("/", parts: 2)
      |> Enum.map_join("/", &URI.encode(&1, fn c -> URI.char_unreserved?(c) end))

    "/repos/#{repo}"
  end

  defp issue_path(issue, opts), do: repo_path(opts) <> "/issues/#{issue.id}"

  defp request(method, path, params, body, opts) do
    Client.request(method, path, params, body, Keyword.take(opts, [:request_fun]))
  end

  defp halt_issue(issue, reason, opts) do
    base = issue_path(issue, opts)

    # Eligibility removal and read-back precede remote reporting, so reporting failure cannot dispatch more work.
    case request("DELETE", base <> "/labels/momoflow%3Aready", %{}, nil, opts) do
      {:ok, %{status: status}} when status in [200, 404] -> :ok
      _ -> halt!("Unable to remove dispatch label; operator intervention required")
    end

    {:ok, %{status: 200, body: labels}} = request("GET", base <> "/labels", %{}, nil, opts)
    if Enum.any?(labels, &(&1["name"] == "momoflow:ready")), do: halt!("Dispatch label remains")

    {:ok, %{status: 200, body: comments}} =
      request("GET", base <> "/comments", %{"per_page" => 100}, nil, opts)

    pads = Enum.filter(comments, &String.contains?(&1["body"] || "", "<!-- momoflow:workpad -->"))

    note =
      "\n\nEngine stopped (#{DateTime.to_iso8601(DateTime.utc_now())}): #{reason}\nReady removal verified. Inspect /data/log/roles before manual resumption; do not reset the ledger."

    case pads do
      [pad] when length(comments) < 100 ->
        path =
          repo_path(opts) <> "/issues/comments/#{pad["id"]}"

        {:ok, %{status: 200}} =
          request("PATCH", path, %{}, %{"body" => pad["body"] <> note}, opts)

      [] when length(comments) < 100 ->
        {:ok, %{status: 201}} =
          request(
            "POST",
            base <> "/comments",
            %{},
            %{
              "body" =>
                "<!-- momoflow:workpad -->\n## 현재 상태\n개입 필요; 누적 반복은 보존 ledger에서 확인.\n" <> note
            },
            opts
          )

      _ ->
        halt!("Cannot identify single workpad for stop evidence; label already removed")
    end

    Logger.warning("Role flow stopped issue=#{issue.id}: #{reason}")
    :ok
  end

  defp validate_state!(state) do
    unless state["stage"] in ~w(plan build review publish blocked done) and
             is_integer(state["iterations"]) and state["iterations"] in 0..3 and
             is_boolean(state["in_flight"]) and is_list(state["events"]) do
      halt!("Invalid ledger; manual inspection required")
    end
  end

  defp save(path, state) do
    File.write!(path <> ".tmp", Jason.encode!(state))
    File.rename!(path <> ".tmp", path)
  end

  defp halt!(reason), do: raise(RuntimeError, reason)
end
