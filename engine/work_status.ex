defmodule SymphonyElixir.WorkStatus do
  @moduledoc "Read-only, allowlisted workflow observation; never dispatch authority."
  @stages %{
    "plan" => {"Planning", "system", "Prepare the implementation plan"},
    "build" => {"Implementation / validation", "system", "Implement and run affected checks"},
    "review" => {"Independent review", "system", "Review the candidate in a separate session"},
    "publish" => {"PR publication", "system", "Preserve the reviewed candidate in the same PR"},
    "await_validation" =>
      {"External validation pending", "operator", "Check the PR and host validation record"},
    "await_decision" =>
      {"Judgment pending", "operator",
       "Check the workpad decision request and authenticated response"},
    "blocked" =>
      {"Blocked", "operator", "Inspect the workpad; preserve evidence before recovery"},
    "done" =>
      {"Role flow ended", "operator", "Verify PR, merge and deployment evidence separately"},
    "validating" => {"Host validation", "system", "Wait for fixed host checks"},
    "checks_wait" => {"External checks pending", "system", "Wait for exact-head checks"},
    "review_wait" => {"Human review pending", "user", "Review the exact PR head on GitHub"},
    "correction" =>
      {"Correction pending", "system", "Resume the same PR within the shared budget"},
    "merged" =>
      {"Merge confirmed; deployment unconfirmed", "operator",
       "Check deployment eligibility and completion record"},
    "finishing" =>
      {"Deployment / retirement verification", "system", "Wait for host completion verification"},
    "complete" =>
      {"Deployment and retirement verified", "system", "No successor is dispatched automatically"}
  }

  def stages, do: @stages

  def observe(opts \\ []) do
    repo =
      Keyword.get_lazy(opts, :repo, fn ->
        case SymphonyElixir.GitHub.Client.resolved_repo(SymphonyElixir.Config.settings!().tracker) do
          {:ok, r} -> r
          _ -> nil
        end
      end)

    root = Keyword.get(opts, :launch_root, System.get_env("MOMOFLOW_LAUNCH_ROOT"))
    selected = opts[:issue]
    manifest = if root, do: read(Path.join(root, "active.json"), 4096), else: nil
    m = if manifest, do: elem(manifest, 0), else: %{}
    issue = selected || m["issue"]

    if valid_repo?(repo) and valid_issue?(issue) do
      project(repo, issue, m, opts)
    else
      unknown("No current launch available; idle workers do not prove completion")
    end
  rescue
    _ -> unknown("Status unavailable; check the issue workpad and host records")
  end

  defp project(repo, issue, manifest, opts) do
    now = Keyword.get(opts, :now, DateTime.utc_now())
    key = Base.encode16(:crypto.hash(:sha256, repo <> ":" <> issue), case: :lower)
    root = Keyword.get(opts, :ledger_root, "/data/log/roles")
    url = "https://github.com/#{repo}/issues/#{issue}"

    base =
      Map.merge(unknown("Runner evidence unavailable; check the workpad"), %{
        issue: issue,
        issue_url: url,
        selection:
          if(opts[:issue], do: "Selected issue (may be historical)", else: "Current launch"),
        observed_at: nil,
        host: "Unknown: host summary absent or invalid"
      })

    with {s, stamp} <- read(Path.join(root, key <> ".json"), 2_000_000),
         true <- s["issue"] == issue and is_list(s["events"]),
         launch when is_map(launch) <- s["launch"],
         true <- launch["repo"] == repo and launch["issue"] == issue,
         true <- valid_id?(launch["id"]),
         true <- opts[:issue] != nil or launch == manifest do
      base =
        Map.put(
          base,
          :last_known_phase,
          elem(Map.get(@stages, s["stage"], {"Unknown", "operator", "Check workpad"}), 0)
        )

      p = s["publication"]

      base =
        if is_map(p) and is_integer(p["pr"]) and p["pr"] > 0,
          do: Map.put(base, :pr_url, "https://github.com/#{repo}/pull/#{p["pr"]}"),
          else: base

      base = Map.put(base, :persisted_at, stamp)
      activity = active_observation(s, url, opts, now)
      phase = if fresh?(stamp, now) or activity, do: s["stage"], else: "unknown"
      result =
        describe(base, phase, "runner ledger (last persisted state)", stamp)
        |> Map.put(:activity_at, activity)
      result = if activity,
        do: %{result | source: "runner stage + matching live session activity", observed_at: activity},
        else: result
      inbox = Keyword.get(opts, :inbox_root, System.get_env("MOMOFLOW_POST_PR_INBOX"))
      host = if inbox, do: read(Path.join(inbox, key <> ".status.json"), 4096), else: nil

      with {h, _} <- host,
           true <-
             h["v"] == 1 and h["repo"] == repo and h["issue"] == issue and
               h["launch"] == launch["id"] and h["generation"] == length(s["events"]),
           p when is_map(p) <- s["publication"],
           true <-
             is_integer(p["pr"]) and p["pr"] > 0 and is_binary(p["head"]) and
               Regex.match?(~r/^[a-f0-9]{40}$/, p["head"]),
           true <- h["head"] == p["head"] and h["pr"] == p["pr"],
           true <-
             s["stage"] in ["await_validation", "await_decision", "done", "blocked"] and
               s["in_flight"] == false,
           true <- fresh?(h["observed_at"], now),
           true <-
             h["phase"] in ~w(validating checks_wait review_wait correction merged finishing complete blocked await_decision) do
        describe(base, h["phase"], "host public summary", h["observed_at"])
        |> Map.put(:host, "Fresh, matching launch / generation / PR head")
        |> Map.put(:pr_url, "https://github.com/#{repo}/pull/#{h["pr"]}")
      else
        _ ->
          Map.put(
            result,
            :host,
            "Unknown: summary absent, stale, unreadable or mismatched; check PR/workpad and operator records"
          )
      end
    else
      _ -> base
    end
  end

  # The ledger is saved only at stage boundaries. A fresh event from the same
  # running issue/session corroborates the stage without renewing its persisted time.
  defp active_observation(s, url, opts, now) do
    if s["stage"] in ~w(plan build review publish) and s["in_flight"] == true and
         is_map(s["active_session"]) and is_binary(s["active_session"]["session_id"]) do
      snapshot = Keyword.get_lazy(opts, :snapshot, fn ->
        SymphonyElixir.Orchestrator.snapshot(SymphonyElixir.Orchestrator, 1_000)
      end)
      running = if is_map(snapshot), do: Map.get(snapshot, :running, []), else: []
      Enum.find_value(running, fn entry ->
        stamp = case entry[:last_codex_timestamp] do
          %DateTime{} = t -> DateTime.to_iso8601(t)
          _ -> nil
        end
        if entry[:issue_url] == url and
             entry[:session_id] == s["active_session"]["session_id"] and
             entry[:last_codex_event] not in [:turn_completed, :turn_failed, :turn_cancelled,
               :turn_input_required, :approval_required] and fresh?(stamp, now),
          do: stamp
      end)
    end
  end

  defp describe(base, phase, source, stamp) do
    {label, actor, action} =
      Map.get(
        @stages,
        phase,
        {"Unknown / stale", "operator", "Check the issue workpad, PR and host records"}
      )

    Map.merge(base, %{
      phase: label,
      actor: actor,
      next_action: action,
      source: source,
      observed_at: stamp
    })
  end

  defp unknown(reason),
    do: %{
      phase: "Unknown / idle",
      actor: "operator",
      next_action: reason,
      source: "No verified current evidence",
      observed_at: nil,
      persisted_at: nil,
      activity_at: nil,
      issue: nil,
      issue_url: nil,
      pr_url: nil,
      selection: "No current selection",
      last_known_phase: "Unknown",
      host: "Unknown"
    }

  defp valid_repo?(r),
    do:
      is_binary(r) and Regex.match?(~r/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, r) and
        not String.contains?(r, "..")

  defp valid_issue?(i), do: is_binary(i) and Regex.match?(~r/^[1-9][0-9]{0,9}$/, i)
  defp valid_id?(i), do: is_binary(i) and Regex.match?(~r/^[a-f0-9]{64}$/, i)

  defp fresh?(stamp, now) when is_binary(stamp) do
    case DateTime.from_iso8601(stamp) do
      {:ok, t, _} -> DateTime.diff(now, t) in 0..120
      _ -> false
    end
  end

  defp fresh?(_, _), do: false

  # Read bounded regular files only, rejecting symlinked roots/parents as well as leaves.
  defp read(path, limit) do
    if regular_parents?(Path.dirname(path)) do
      with {:ok, %{type: :regular, size: size, mtime: mtime}} when size <= limit <-
             File.lstat(path, time: :posix),
           {:ok, f} <- File.open(path, [:read, :binary]) do
        try do
          with bytes when is_binary(bytes) and byte_size(bytes) <= limit <-
                 IO.binread(f, limit + 1),
               {:ok, data} when is_map(data) <- Jason.decode(bytes) do
            {data, DateTime.from_unix!(mtime) |> DateTime.to_iso8601()}
          else
            _ -> nil
          end
        after
          File.close(f)
        end
      else
        _ -> nil
      end
    end
  end

  defp regular_parents?("/"), do: true

  defp regular_parents?(path) do
    case File.lstat(path) do
      {:ok, %{type: :directory}} -> regular_parents?(Path.dirname(path))
      _ -> false
    end
  end
end
