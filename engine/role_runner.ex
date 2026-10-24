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

  # Enrollment survives removal of opt-in flags: never fall back to a single unbounded session.
  def required?(issue, opts \\ []) do
    if System.get_env("MOMOFLOW_ROLE_FLOW") == "1" or System.get_env("MOMOFLOW_LAUNCH_ROOT") do
      true
    else
      case Client.resolved_repo(Config.settings!().tracker) do
        {:ok, repo} ->
          key = Base.encode16(:crypto.hash(:sha256, repo <> ":" <> issue.id), case: :lower)

          File.exists?(
            Path.join(Keyword.get(opts, :state_root, "/data/log/roles"), key <> ".json.enrolled")
          )

        _ ->
          # Token expiry/unknown scope must not turn an enrolled execution into a single session.
          Path.wildcard(
            Path.join(Keyword.get(opts, :state_root, "/data/log/roles"), "*.json.enrolled")
          ) != []
      end
    end
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
      verify_launch!(state, issue, opts)
      validate_state!(state)
      state = resume!(state, workspace, issue, opts)

      if state["stage"] in ~w(blocked done) or state["in_flight"] do
        halt!("Existing terminal or interrupted role flow; inspect ledger before resuming")
      end

      case state["stage"] do
        "await_decision" ->
          decision_hold(state, issue, opts)

        "await_validation" ->
          save(path, state)

          Keyword.get(opts, :halt, fn i, r ->
            halt_issue(i, r, Keyword.put(opts, :waiting, true))
          end).(issue, "Decision consumed; host validation pending")

        _ ->
          advance(path, state, workspace, issue, prompt, on_message, opts)
      end
    rescue
      error ->
        state = stop_state(path, issue)

        save(
          path,
          Map.merge(state, %{
            "stage" =>
              if(state["stage"] == "await_decision", do: "await_decision", else: "blocked"),
            "reason" => Exception.message(error)
          })
        )

        Keyword.get(opts, :halt, fn issue, reason -> halt_issue(issue, reason, opts) end).(
          issue,
          "#{Exception.message(error)}; shared iterations=#{inspect(state["iterations"])}/#{limit(state)}"
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
      manifest = launch_manifest!(issue, opts)
      marker = path <> ".enrolled"
      if File.exists?(marker), do: halt!("Enrolled ledger missing; operator recovery required")

      used =
        if manifest,
          do: 0,
          else: Keyword.get(opts, :initial_count, fn -> workpad_count!(issue, opts) end).()

      if not is_integer(used) or used not in 0..3, do: halt!("Invalid shared iteration count")

      state = %{
        "issue" => issue.id,
        "stage" => "plan",
        "iterations" => used,
        "events" => [],
        "in_flight" => false
      }

      state = if manifest, do: Map.put(state, "launch", manifest), else: state
      # Separate durable enrollment tombstone prevents a missing ledger from reseeding.
      if manifest do
        {:ok, marker_file} = File.open(marker, [:write, :exclusive, :sync])
        IO.binwrite(marker_file, Jason.encode!(manifest))
        File.close(marker_file)
      end

      save(path, state)
      state
    end
  end

  defp advance(path, state, workspace, issue, prompt, on_message, opts) do
    :ok = Keyword.get(opts, :eligible, fn issue -> eligible_issue(issue, opts) end).(issue)
    role = state["stage"]
    count = state["iterations"] + if(role == "build", do: 1, else: 0)
    verify_launch!(state, issue, opts)
    if count > limit(state), do: halt!("Shared iteration budget exhausted")
    if role == "plan" and count >= limit(state), do: halt!("No implementation budget remains")
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

    prompt =
      if inbox(opts),
        do:
          prompt <>
            "\nHost-connected publication requires result.publication={repo,issue,pr,base,head}. Keep the SAME PR across corrections; no auto-close keywords. Prior publication: #{Jason.encode!(state["publication"])}. Failure evidence: #{Jason.encode!(state["resume"])}",
        else: prompt

    role_prompt = role_prompt(prompt, state, result_path, before)

    role_prompt =
      if role == "publish" and inbox(opts),
        do: role_prompt <> publication_contract(state, issue, opts),
        else: role_prompt

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

    unless is_binary(result["summary"]) and String.trim(result["summary"]) != "" and
             byte_size(result["summary"]) <= 8000 and
             is_list(result["checks"]) and result["checks"] != [] and
             length(result["checks"]) <= 30 and
             Enum.all?(
               result["checks"],
               &(is_binary(&1) and String.trim(&1) != "" and byte_size(&1) <= 2000)
             ) do
      halt!("Missing bounded summary or checks evidence")
    end

    next =
      if result["status"] == "blocked", do: "blocked", else: next_stage(role, result["status"])

    event = %{
      "role" => role,
      "iteration" => count,
      "settings" => settings(role),
      "session" => Jason.decode!(Jason.encode!(session)),
      "before" => before,
      "after" => after_snapshot,
      "result" => result,
      "at" => DateTime.to_iso8601(DateTime.utc_now())
    }

    publication =
      if role == "publish" and next == "done" and inbox(opts) do
        publication!(result, state, workspace, issue, opts)
      else
        nil
      end

    next = if publication, do: "await_validation", else: next

    state =
      Map.merge(state, %{
        "stage" => next,
        "in_flight" => false,
        "events" => state["events"] ++ [event],
        "active_session" => nil
      })

    state = if publication, do: Map.put(state, "publication", publication), else: state

    state =
      if result["decision"],
        do: decision_checkpoint!(state, next, result, after_snapshot, issue, opts),
        else: state

    save(path, state)

    if state["stage"] == "await_decision" do
      decision_hold(state, issue, opts)
    else
      if next == "blocked" do
        halt!(
          "#{role} blocked: #{result["summary"]}; checks=#{Jason.encode!(result["checks"])}; Ledger: #{path}"
        )
      end

      if next in ~w(done await_validation) do
        waiting_opts = Keyword.put(opts, :waiting, next == "await_validation")

        Keyword.get(opts, :halt, fn issue, reason -> halt_issue(issue, reason, waiting_opts) end).(
          issue,
          "Role stage preserved (#{next}); shared iterations=#{count}/#{limit(state)}; PR checks/reviews and deployment remain separate. Ledger: #{path}"
        )
      else
        advance(path, state, workspace, issue, prompt, on_message, opts)
      end
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
    Shared implementation/validation/review iterations used: #{state["iterations"]}/#{limit(state)}.
    Never reset this count. Fast remains OFF. Do not spawn other agents or change settings.
    Target tree: #{Jason.encode!(snapshot)}
    Target tree diff_sha256 is an engine-owned composite fingerprint, NOT a plain git diff SHA-256.
    It hashes Erlang term_to_binary({raw git diff --binary HEAD output, ordered untracked {path, Git mode, content or symlink target} tuples}), excluding .momoflow-role-result.json.
    Do not compare it with sha256sum of git diff (even for a clean tree), or infer corruption from that comparison.
    Inspect the actual HEAD/diff/files for your task; the engine recomputes and compares snapshots itself and still rejects unauthorized tree changes.
    If exact recomputation is needed, an operator must call SymphonyElixir.RoleRunner.snapshot!(workspace) using this candidate's compiled module in the same workspace; do not approximate its Erlang serialization with shell hashing.
    Prior role evidence (including independent review findings): #{Jason.encode!(state["events"])}
    Prior operator confirmations (external operations, not human authentication): #{Jason.encode!(state["decisions"] || [])}
    Planning and review are sequential, separate sessions, not parallel delegation.
    Write a JSON result to #{result_path} before ending:
    {"status":"complete|changes_requested|blocked","summary":"bounded scope/plan or concrete findings and resolution","checks":["actual checks and results; separate mock, settings query and live calls"]}
    Only review may use changes_requested. Every result requires a nonblank summary and at least one nonblank check describing actual evidence (planning may record inspected scope/acceptance criteria). Missing/invalid evidence stops execution.
    In role mode the RUNNER owns execution-label removal, after durable results. Never remove ready yourself, including when requesting a decision.
    To request normal judgment waiting, return status complete (or review changes_requested) plus decision={"reason":"specific bounded question and proposed continuation"}.
    This preserves your completed role, checks, session, snapshot and shared usage before stopping. The normal next stage is held; no policy/budget/permission expansion is authorized.
    Use blocked for actual failure or unsupported authority, not as a substitute for a normal completed-role decision.
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

  # Git object identity covers full contents, executable modes, symlinks and deletions.
  # No index/object writes are made in the candidate repository.
  def tree!(workspace) do
    paths =
      git!(workspace, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      |> String.split(<<0>>, trim: true)
      |> Enum.uniq()
      |> Enum.reject(&(&1 == ".momoflow-role-result.json"))

    entries =
      Enum.flat_map(paths, fn p ->
        full = Path.join(workspace, p)

        case File.lstat(full) do
          {:error, :enoent} ->
            []

          {:ok, %{type: :symlink}} ->
            [{String.split(p, "/"), "120000", object("blob", File.read_link!(full))}]

          {:ok, %{type: :regular, mode: mode}} ->
            m = if Bitwise.band(mode, 0o100) != 0, do: "100755", else: "100644"
            [{String.split(p, "/"), m, object("blob", File.read!(full))}]

          _ ->
            halt!("Unsupported candidate tree entry")
        end
      end)

    Base.encode16(tree_object(entries), case: :lower)
  end

  defp object(type, bytes),
    do: :crypto.hash(:sha, type <> " " <> Integer.to_string(byte_size(bytes)) <> <<0>> <> bytes)

  defp tree_object(entries) do
    entries
    |> Enum.group_by(fn {[name | _], _, _} -> name end)
    |> Enum.map(fn {name, group} ->
      case group do
        [{[_], mode, hash}] ->
          {name, mode, hash, name}

        _ ->
          children = Enum.map(group, fn {[_ | rest], mode, hash} -> {rest, mode, hash} end)
          {name, "40000", tree_object(children), name <> "/"}
      end
    end)
    |> Enum.sort_by(&elem(&1, 3))
    |> Enum.map_join(fn {name, mode, hash, _} -> mode <> " " <> name <> <<0>> <> hash end)
    |> then(&object("tree", &1))
  end

  # Optional trusted launch mode is installed by an external operator, never by issue text.
  defp launch_root(opts) do
    Keyword.get_lazy(opts, :launch_root, fn ->
      case System.get_env("MOMOFLOW_LAUNCH_ROOT") do
        nil -> nil
        "/run/momoflow-launch" = root -> root
        _ -> halt!("Invalid trusted launch mount")
      end
    end)
  end

  def limit(state) do
    case state["launch"] do
      nil -> 3
      manifest when is_map(manifest) -> manifest["limit"]
      _ -> nil
    end
  end

  defp launch_manifest!(issue, opts) do
    if root = launch_root(opts) do
      unless Keyword.has_key?(opts, :launch_root) or System.get_env("MOMOFLOW_ROLE_FLOW") == "1",
        do: halt!("Launch requires enabled role flow; no single-session fallback")

      m = read_launch_manifest!(root, opts[:repo])

      unless m["issue"] == issue.id and inbox(opts),
        do: halt!("Launch scope/limit/inbox mismatch")

      m
    end
  end

  defp read_launch_manifest!(root, repo) do
    file = Path.join(root, "active.json")
    stat = File.lstat!(file)
    unless stat.type == :regular and stat.size < 4096, do: halt!("Invalid launch manifest")
    m = Jason.decode!(File.read!(file))

    unless is_map(m) and Enum.sort(Map.keys(m)) == Enum.sort(~w(v id repo issue base limit)),
      do: halt!("Invalid launch manifest fields")

    unless m["v"] == 1 and m["repo"] == repo and
             is_binary(m["issue"]) and Regex.match?(~r/^[1-9][0-9]*$/, m["issue"]) and
             is_binary(m["id"]) and Regex.match?(~r/^[a-f0-9]{64}$/, m["id"]) and
             is_binary(m["base"]) and Regex.match?(~r/^[\w.\/-]+$/, m["base"]) and
             is_integer(m["limit"]) and m["limit"] in 1..3,
           do: halt!("Launch scope/limit/inbox mismatch")

    m
  end

  defp launch_manifest_status(nil, _repo), do: %{status: "invalid"}

  defp launch_manifest_status(root, repo) do
    # Report invalid state without exposing file contents or breaking observability.
    case File.lstat(Path.join(root, "active.json")) do
      {:error, :enoent} ->
        %{status: "absent"}

      _ ->
        try do
          %{status: "present", value: read_launch_manifest!(root, repo)}
        rescue
          _ -> %{status: "invalid"}
        end
    end
  end

  defp verify_launch!(state, issue, opts) do
    current = launch_manifest!(issue, opts)

    unless current == state["launch"],
      do: halt!("Launch changed/missing or legacy ledger adoption forbidden")

    unless is_integer(limit(state)) and limit(state) in 1..3 and is_integer(state["iterations"]) and
             state["iterations"] <= limit(state),
           do: halt!("Invalid persisted launch budget")
  end

  defp read_only_mount?(nil), do: false

  defp read_only_mount?(root) do
    File.read!("/proc/self/mountinfo")
    |> String.split("\n")
    |> Enum.any?(fn line ->
      case String.split(line, " ") do
        [_, _, _, _, ^root, options | _] -> "ro" in String.split(options, ",")
        _ -> false
      end
    end)
  end

  # Exposed by the existing read-only state endpoint: no secrets, no execution.
  def launch_status(opts \\ []) do
    settings = Config.settings!()

    repo =
      case Client.resolved_repo(settings.tracker) do
        {:ok, value} -> value
        # Preserve observability when auth is unavailable; launch still fails scope validation.
        _ -> nil
      end

    %{
      contract: 1,
      source: Base.encode16(:crypto.hash(:sha256, File.read!(__ENV__.file)), case: :lower),
      repo: repo,
      concurrency: settings.agent.max_concurrent_agents,
      role_flow: System.get_env("MOMOFLOW_ROLE_FLOW") == "1",
      manifest: launch_manifest_status(launch_root(opts), repo),
      launch_root: launch_root(opts),
      launch_read_only: read_only_mount?(launch_root(opts)),
      inbox_read_only: read_only_mount?(inbox(opts)),
      inbox_root: inbox(opts)
    }
  end

  defp inbox(opts) do
    Keyword.get_lazy(opts, :inbox_root, fn ->
      case System.get_env("MOMOFLOW_POST_PR_INBOX") do
        nil -> nil
        "/run/momoflow-resume" = root -> root
        _ -> halt!("Resume inbox must be the operator-mounted /run/momoflow-resume")
      end
    end)
  end

  defp publication_contract(state, issue, opts) do
    expected = %{"repo" => opts[:repo], "issue" => issue.id}
    base = (state["launch"] || state["publication"] || %{})["base"]
    expected = if base, do: Map.put(expected, "base", base), else: expected

    """

    Engine-owned expected publication scope (JSON): #{Jason.encode!(expected)}
    Before any GitHub API side effect, verify the intended publication against this exact scope and these JSON types.
    Write result.publication with repo, issue, pr, base, head. repo and issue must exactly match the expected JSON strings;
    issue must remain a JSON string, never a JSON number. pr must be a positive JSON integer.
    base must be a JSON string matching the expected base when provided, otherwise the actual PR base.
    head must be the actual published commit SHA as a lowercase 40-hex JSON string, not the local pre-publication HEAD.
    Preserve the reviewed tree. Reuse the prior publication's PR/base across corrections; no auto-close keywords.
    Check the serialized result's types and exact scope before returning it. The runner still verifies remote PR/head/tree and review evidence.
    """
  end

  defp publication!(result, state, workspace, issue, opts) do
    p = result["publication"]
    review = List.last(state["events"])

    unless is_map(p) and p["repo"] == opts[:repo] and p["issue"] == issue.id and
             is_integer(p["pr"]) and p["pr"] > 0 and is_binary(p["base"]) and
             is_binary(p["head"]) and Regex.match?(~r/^[0-9a-f]{40}$/, p["head"]) and
             review["role"] == "review" and review["result"]["status"] == "complete" and
             review["after"] == snapshot!(workspace),
           do: halt!("Missing exact reviewed publication")

    if state["launch"] && p["base"] != state["launch"]["base"], do: halt!("Launch base mismatch")
    old = state["publication"]

    if old && (old["pr"] != p["pr"] or old["base"] != p["base"]),
      do: halt!("Correction must reuse same PR/base")

    {:ok, %{status: 200, body: pr}} =
      request("GET", repo_path(opts) <> "/pulls/#{p["pr"]}", %{}, nil, opts)

    {:ok, %{status: 200, body: commit}} =
      request("GET", repo_path(opts) <> "/git/commits/#{p["head"]}", %{}, nil, opts)

    tree = tree!(workspace)

    unless pr["state"] == "open" and pr["head"]["sha"] == p["head"] and
             pr["head"]["repo"]["full_name"] == opts[:repo] and pr["base"]["ref"] == p["base"] and
             pr["base"]["repo"]["full_name"] == opts[:repo] and is_binary(pr["base"]["sha"]) and
             Regex.match?(~r/^[0-9a-f]{40}$/, pr["base"]["sha"]) and commit["tree"]["sha"] == tree,
           do: halt!("Published tree/head/base mismatch")

    Map.merge(p, %{
      "tree" => tree,
      "base_head" => pr["base"]["sha"],
      "snapshot" => review["after"],
      "review_thread" => review["session"]["thread_id"],
      "generation" => length(state["events"]) + 1
    })
  end

  defp decision_checkpoint!(state, next, result, snapshot, issue, opts) do
    reason = result["decision"]["reason"]

    unless is_binary(inbox(opts)) and next in ~w(build review publish await_validation) and
             is_binary(reason) and String.trim(reason) != "" and byte_size(reason) <= 4000,
           do: halt!("Invalid decision request or trusted inbox unavailable")

    request = %{
      "id" => Base.encode16(:crypto.strong_rand_bytes(32), case: :lower),
      "repo" => opts[:repo],
      "issue" => issue.id,
      "generation" => length(state["events"]),
      "snapshot" => snapshot,
      "publication" => state["publication"],
      "next" => next,
      "limit" => limit(state),
      "launch" => state["launch"],
      "reason" => reason,
      "content_hash" => Base.encode16(:crypto.hash(:sha256, reason), case: :lower)
    }

    Map.merge(state, %{"stage" => "await_decision", "decision" => request})
  end

  defp decision_hold(state, issue, opts) do
    opts = Keyword.put(opts, :decision, state["decision"])

    Keyword.get(opts, :halt, fn i, r -> halt_issue(i, r, opts) end).(
      issue,
      "Normal decision pending: #{Jason.encode!(state["decision"])}"
    )
  end

  defp resume!(%{"stage" => "await_decision"} = state, workspace, issue, opts) do
    root = inbox(opts)

    unless is_binary(root) and Path.type(root) == :absolute and
             not String.starts_with?(Path.expand(root) <> "/", Path.expand(workspace) <> "/"),
           do: halt!("Trusted decision inbox unavailable")

    file =
      Path.join(
        root,
        Base.encode16(:crypto.hash(:sha256, opts[:repo] <> ":" <> issue.id), case: :lower) <>
          ".json"
      )

    case File.lstat(file) do
      {:error, :enoent} ->
        state

      {:ok, %{type: :regular, size: size}} when size < 65536 ->
        r = Jason.decode!(File.read!(file))
        d = state["decision"]
        # Old code-failure/decision envelopes are inert, never new authority.
        if r["kind"] != "decision" or r["request"] != d do
          state
        else
          unless not state["in_flight"] and is_nil(state["active_session"]) and
                   r["repo"] == opts[:repo] and r["issue"] == issue.id and
                   r["id"] == d["id"] and r["action"] == "continue" and
                   r["actor"] == "external-operator" and r["authority"] == "existing-scope" and
                   is_binary(r["source"]) and
                   Regex.match?(
                     Regex.compile!(
                       "^" <>
                         Regex.escape(
                           "https://github.com/" <> opts[:repo] <> "/issues/" <> issue.id
                         ) <> "(#issuecomment-[0-9]+)?$"
                     ),
                     r["source"]
                   ) and
                   r["unresolved"] == [d["id"]] and d["generation"] == length(state["events"]) and
                   d["limit"] == limit(state) and d["launch"] == state["launch"] and
                   snapshot!(workspace) == d["snapshot"] and
                   (d["next"] != "build" or state["iterations"] < limit(state)) and
                   not Enum.any?(state["decisions"] || [], &(&1["decision_id"] == d["id"])),
                 do: halt!("Invalid, stale, rejected or exhausted decision response")

          {:ok, %{status: 200, body: current}} =
            request("GET", issue_path(issue, opts), %{}, nil, opts)

          unless current["state"] == "open" and
                   not Enum.any?(
                     current["labels"] || [],
                     &(&1["name"] in ~w(momoflow:needs-decision momoflow:needs-review))
                   ),
                 do: halt!("Other unresolved decision/review hold")

          if p = d["publication"] do
            {:ok, %{status: 200, body: pr}} =
              request("GET", repo_path(opts) <> "/pulls/#{p["pr"]}", %{}, nil, opts)

            unless pr["state"] == "open" and pr["head"]["sha"] == p["head"] and
                     pr["head"]["repo"]["full_name"] == opts[:repo] and
                     pr["base"]["ref"] == p["base"] and pr["base"]["sha"] == p["base_head"] and
                     pr["base"]["repo"]["full_name"] == opts[:repo],
                   do: halt!("Decision PR changed")

            {:ok, %{status: 200, body: labels}} =
              request("GET", repo_path(opts) <> "/issues/#{p["pr"]}/labels", %{}, nil, opts)

            unless is_list(labels) and
                     not Enum.any?(
                       labels,
                       &(&1["name"] in ~w(momoflow:needs-decision momoflow:needs-review))
                     ), do: halt!("Other unresolved PR decision/review hold")
          end

          # advance persists this consumption with count/in_flight before starting a model.
          Map.merge(state, %{
            "stage" => d["next"],
            "decision" => nil,
            "decisions" =>
              (state["decisions"] || []) ++ [%{"decision_id" => d["id"], "response" => r}]
          })
        end

      _ ->
        halt!("Invalid decision envelope")
    end
  end

  defp resume!(%{"stage" => "await_validation"} = state, workspace, issue, opts) do
    root = inbox(opts)

    unless is_binary(root) and Path.type(root) == :absolute and
             not String.starts_with?(Path.expand(root) <> "/", Path.expand(workspace) <> "/"),
           do: halt!("Trusted resume inbox unavailable")

    p = state["publication"]
    name = Base.encode16(:crypto.hash(:sha256, opts[:repo] <> ":" <> issue.id), case: :lower)
    file = Path.join(root, name <> ".json")
    stat = File.lstat!(file)
    unless stat.type == :regular and stat.size < 65536, do: halt!("Invalid resume envelope")
    r = Jason.decode!(File.read!(file))

    unless not state["in_flight"] and state["iterations"] < limit(state) and
             r["repo"] == opts[:repo] and r["issue"] == issue.id and r["publication"] == p and
             r["generation"] == length(state["events"]) and r["kind"] == "code_failure" and
             is_binary(r["id"]) and Regex.match?(~r/^[0-9a-f]{64}$/, r["id"]) and
             is_binary(r["evidence"]) and String.trim(r["evidence"]) != "" and
             not Enum.any?(state["events"], &(&1["resume_id"] == r["id"])) and
             snapshot!(workspace) == p["snapshot"] and tree!(workspace) == p["tree"],
           do: halt!("Stale, interrupted, exhausted or invalid resume request")

    {:ok, %{status: 200, body: pr}} =
      request("GET", repo_path(opts) <> "/pulls/#{p["pr"]}", %{}, nil, opts)

    unless pr["state"] == "open" and pr["head"]["sha"] == p["head"],
      do: halt!("Resume PR changed")

    # Persist consumption together with build entry in advance; a crash cannot repeat a build.
    Map.merge(state, %{
      "stage" => "build",
      "resume" => r,
      "events" => state["events"] ++ [%{"resume_id" => r["id"], "evidence" => r["evidence"]}]
    })
  end

  defp resume!(state, _, _, _), do: state

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

    if opts[:decision] do
      {:ok, %{status: status}} =
        request("POST", base <> "/labels", %{}, %{"labels" => ["momoflow:needs-decision"]}, opts)

      unless status in [200, 201], do: halt!("Decision label report failed")
    end

    note =
      if opts[:decision] do
        "\n\nNormal decision checkpoint: #{Jason.encode!(opts[:decision])}\nReady removal verified; role/session/checks/usage preserved. External operator confirmation within existing scope required; labels/comments are not human authentication."
      else
        if opts[:waiting] do
          "\n\nHost validation pending: #{reason}\nReady removal verified. Routine host checks require no new approval or model run; only a verified host envelope may resume correction."
        else
          "\n\nEngine stopped (#{DateTime.to_iso8601(DateTime.utc_now())}): #{reason}\nReady removal verified. Inspect /data/log/roles before manual resumption; do not reset the ledger."
        end
      end

    decision_marker =
      if opts[:decision],
        do: "<!-- momoflow:runner-decision:#{opts[:decision]["id"]} -->",
        else: nil

    note = if decision_marker, do: "\n\n" <> decision_marker <> note, else: note

    case pads do
      [pad] when length(comments) < 100 and not is_nil(decision_marker) ->
        unless String.contains?(pad["body"] || "", decision_marker) do
          {:ok, %{status: 200}} =
            request(
              "PATCH",
              repo_path(opts) <> "/issues/comments/#{pad["id"]}",
              %{},
              %{"body" => pad["body"] <> note},
              opts
            )
        end

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
    unless state["stage"] in ~w(plan build review publish blocked done await_validation await_decision) and
             is_integer(state["iterations"]) and state["iterations"] in 0..3 and
             is_boolean(state["in_flight"]) and is_list(state["events"]) do
      halt!("Invalid ledger; manual inspection required")
    end
  end

  defp save(path, state) do
    {:ok, file} = :file.open(String.to_charlist(path <> ".tmp"), [:write, :binary, :raw])

    try do
      :ok = :file.write(file, Jason.encode!(state))
      :ok = :file.sync(file)
    after
      :file.close(file)
    end

    File.rename!(path <> ".tmp", path)

    {:ok, directory} =
      :file.open(String.to_charlist(Path.dirname(path)), [:read, :raw, :directory])

    try do
      :ok = :file.sync(directory)
    after
      :file.close(directory)
    end
  end

  defp halt!(reason), do: raise(RuntimeError, reason)
end
