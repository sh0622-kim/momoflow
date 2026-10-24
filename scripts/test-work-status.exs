defmodule WorkStatusTest do
  use ExUnit.Case, async: false
  alias SymphonyElixir.WorkStatus
  setup do
    root = Path.join(System.tmp_dir!(), "status-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)
    m = %{"v" => 1, "repo" => "fixture/repo", "issue" => "38", "id" => String.duplicate("a",64), "base" => "main", "limit" => 3}
    s = %{"issue" => "38", "launch" => m, "stage" => "await_validation", "in_flight" => false, "events" => [],
      "publication" => %{"pr" => 2, "head" => String.duplicate("b",40)}}
    key = Base.encode16(:crypto.hash(:sha256,"fixture/repo:38"),case: :lower)
    ledger = Path.join(root,key<>".json")
    File.write!(ledger,Jason.encode!(s))
    File.write!(Path.join(root,"active.json"),Jason.encode!(m))
    opts = [repo: "fixture/repo", launch_root: root, ledger_root: root, inbox_root: root]
    h = %{"v"=>1,"repo"=>"fixture/repo","issue"=>"38","launch"=>m["id"],"generation"=>0,
      "pr"=>2,"head"=>s["publication"]["head"],"phase"=>"checks_wait","observed_at"=>DateTime.to_iso8601(DateTime.utc_now())}
    %{root: root, ledger: ledger, state: s, opts: opts, host: h, hostfile: Path.join(root,key<>".status.json")}
  end
  test "all runner stages are bounded and publication/idle never prove deployment", c do
    for stage <- ~w(plan build review publish await_validation await_decision blocked done) do
      File.write!(c.ledger,Jason.encode!(%{c.state|"stage"=>stage}))
      p = WorkStatus.observe(c.opts)
      assert p.phase == elem(WorkStatus.stages()[stage],0)
      refute p.phase == "Deployment and retirement verified"
      assert p.host =~ "Unknown"
    end
  end
  test "host states match scope and do not confuse merge with deployment", c do
    for phase <- ~w(validating checks_wait review_wait correction merged finishing complete blocked await_decision) do
      File.write!(c.hostfile,Jason.encode!(%{c.host|"phase"=>phase}))
      assert WorkStatus.observe(c.opts).phase == elem(WorkStatus.stages()[phase],0)
    end
  end
  test "missing malformed stale future and mismatched summaries stay unknown", c do
    for patch <- [%{"head"=>String.duplicate("c",40)},%{"generation"=>1},%{"repo"=>"other/repo"},%{"launch"=>String.duplicate("d",64)},%{"pr"=>3},%{"phase"=>"<script>secret</script>"},%{"observed_at"=>"bad"},%{"observed_at"=>nil},%{"observed_at"=>"2099-01-01T00:00:00Z"},%{"observed_at"=>"2000-01-01T00:00:00Z"}] do
      File.write!(c.hostfile,Jason.encode!(Map.merge(c.host,patch)))
      assert WorkStatus.observe(c.opts).host =~ "Unknown"
    end
    File.write!(c.hostfile,"not json")
    assert WorkStatus.observe(c.opts).host =~ "Unknown"
    File.rm!(c.hostfile)
    assert WorkStatus.observe(c.opts).host =~ "Unknown"
  end
  test "old host cannot override build or unreleased worker", c do
    File.write!(c.hostfile,Jason.encode!(%{c.host|"phase"=>"complete"}))
    for s <- [%{c.state|"stage"=>"build"},%{c.state|"in_flight"=>true}] do
      File.write!(c.ledger,Jason.encode!(s))
      refute WorkStatus.observe(c.opts).phase == "Deployment and retirement verified"
    end
  end
  test "stopped observations expire without renewing source time", c do
    File.write!(c.hostfile,Jason.encode!(c.host))
    p=WorkStatus.observe(c.opts)
    assert p.source == "host public summary"
    assert WorkStatus.observe(c.opts).observed_at == p.observed_at
    expired=WorkStatus.observe(Keyword.put(c.opts,:now,DateTime.add(DateTime.utc_now(),121)))
    assert expired.phase == "Unknown / stale"
    assert expired.host =~ "Unknown"
  end
  test "long roles require matching recent running session evidence and retain persisted time", c do
    old = DateTime.add(DateTime.utc_now(), -600) |> DateTime.truncate(:second)
    File.touch!(c.ledger, DateTime.to_unix(old))
    event_time = DateTime.utc_now() |> DateTime.truncate(:second)
    entry = %{issue_url: "https://github.com/fixture/repo/issues/38", session_id: "matching-session",
      last_codex_timestamp: event_time, last_codex_event: :notification}
    for stage <- ~w(plan build review publish) do
      File.write!(c.ledger, Jason.encode!(Map.merge(c.state, %{"stage" => stage, "in_flight" => true,
        "active_session" => %{"session_id" => "matching-session"}})))
      File.touch!(c.ledger, DateTime.to_unix(old))
      opts = Keyword.put(c.opts, :snapshot, %{running: [entry]})
      p = WorkStatus.observe(opts)
      assert p.phase == elem(WorkStatus.stages()[stage], 0)
      assert p.actor == "system"
      assert p.source == "runner stage + matching live session activity"
      assert p.persisted_at == DateTime.to_iso8601(old)
      assert p.activity_at == DateTime.to_iso8601(event_time)
      assert p.observed_at == p.activity_at
      payload = %{counts: %{running: 0, retrying: 0, blocked: 0}, running: [], retrying: [], blocked: [],
        codex_totals: %{total_tokens: 123, input_tokens: 100, output_tokens: 23, seconds_running: 0},
        rate_limits: nil, generated_at: DateTime.to_iso8601(event_time)}
      html = SymphonyElixirWeb.DashboardLive.render(%{__changed__: nil, work_status: p,
        payload: payload, now: event_time}) |> Phoenix.HTML.Safe.to_iodata() |> IO.iodata_to_binary()
      assert html =~ p.phase
      assert html =~ p.persisted_at
      assert html =~ p.activity_at
      assert html =~ "Runner last persisted (UTC)"
      refute html =~ "matching-session"
      assert WorkStatus.observe(opts).persisted_at == p.persisted_at
      for snapshot <- [:unavailable, :timeout, %{running: []},
        %{running: [%{entry | issue_url: "https://github.com/other/repo/issues/38"}]},
        %{running: [%{entry | session_id: "other-session"}]},
        %{running: [%{entry | last_codex_timestamp: old}]},
        %{running: [%{entry | last_codex_timestamp: DateTime.add(event_time, 60)}]},
        %{running: [%{entry | last_codex_timestamp: nil}]},
        %{running: [%{entry | last_codex_event: :turn_completed}]},
        %{running: [%{entry | last_codex_event: :approval_required}]}] do
        stopped = WorkStatus.observe(Keyword.put(opts, :snapshot, snapshot))
        assert stopped.phase == "Unknown / stale"
        assert stopped.actor == "operator"
        assert stopped.activity_at == nil
        assert stopped.observed_at == p.persisted_at
      end
      expired = WorkStatus.observe(Keyword.put(opts, :now, DateTime.add(event_time, 121)))
      assert expired.phase == "Unknown / stale"
    end
    # A worker from an earlier role cannot corroborate a released or sessionless ledger.
    for patch <- [%{"in_flight" => false}, %{"active_session" => nil}] do
      File.write!(c.ledger, Jason.encode!(Map.merge(Map.merge(c.state, %{"stage" => "review",
        "in_flight" => true, "active_session" => %{"session_id" => "matching-session"}}), patch)))
      File.touch!(c.ledger, DateTime.to_unix(old))
      assert WorkStatus.observe(Keyword.put(c.opts, :snapshot, %{running: [entry]})).phase == "Unknown / stale"
    end
  end
  test "historical selection explicit, invalid inputs and symlinks safe", c do
    File.rm!(Path.join(c.root,"active.json"))
    assert WorkStatus.observe(c.opts).issue == nil
    assert WorkStatus.observe(c.opts++[issue: "38"]).selection =~ "historical"
    for i <- ["../38","<script>","0",38] do
      assert WorkStatus.observe(c.opts++[issue: i]).issue == nil
    end
    File.rename!(c.ledger,c.ledger<>".private")
    File.ln_s!(c.ledger<>".private",c.ledger)
    p=WorkStatus.observe(c.opts++[issue: "38"])
    assert p.phase =~ "Unknown"
    refute inspect(p) =~ c.root
    refute inspect(p) =~ "private"
  end
  test "corrupt oversized and parent-symlinked ledgers stay unknown without path leakage", c do
    for bytes <- ["broken", String.duplicate("x",2_000_001), Jason.encode!(%{"issue"=>"38","stage"=>"<script>secret</script>"})] do
      File.write!(c.ledger,bytes)
      p=WorkStatus.observe(c.opts)
      assert p.phase =~ "Unknown"
      refute inspect(p) =~ "secret"
      refute inspect(p) =~ c.root
    end
    link=c.root<>"-link"
    File.ln_s!(c.root,link)
    on_exit(fn-> File.rm(link) end)
    assert WorkStatus.observe(Keyword.put(c.opts,:ledger_root,link)).phase =~ "Unknown"
  end
  test "actual candidate LiveView renders panel and legacy metrics, tick refreshes without PubSub", c do
    File.write!(c.hostfile,Jason.encode!(c.host))
    workflow=WorkStatus.observe(c.opts)
    payload=%{counts: %{running: 0,retrying: 0,blocked: 0},running: [],retrying: [],blocked: [],codex_totals: %{total_tokens: 123,input_tokens: 100,output_tokens: 23,seconds_running: 0},rate_limits: nil,generated_at: "2026-10-24T00:00:00Z"}
    assigns=%{__changed__: nil,work_status: workflow,payload: payload,now: DateTime.utc_now()}
    html=SymphonyElixirWeb.DashboardLive.render(assigns)|>Phoenix.HTML.Safe.to_iodata()|>IO.iodata_to_binary()
    assert html =~ "Current work and next action"
    assert html =~ "External checks pending"
    assert html =~ "No active sessions"
    assert html =~ "123"
    refute html =~ c.root
    # handle_info invokes a fresh projection independently of load_payload and agent messages.
    socket=%Phoenix.LiveView.Socket{assigns: %{__changed__: %{}, selected_issue: "38",work_status: workflow}}
    {:noreply, refreshed}=SymphonyElixirWeb.DashboardLive.handle_info(:runtime_tick,socket)
    assert refreshed.assigns.work_status != workflow
    assert_receive :runtime_tick, 1500
  end
end
