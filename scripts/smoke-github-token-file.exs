alias SymphonyElixir.GitHub.Client

token_file = Path.join(System.tmp_dir!(), "momoflow-token-#{System.unique_integer([:positive])}.json")
settings = %{provider: %{"repo" => "smoke/fixture", "token" => "$GITHUB_TOKEN"}}
true = "GITHUB_TOKEN_FILE" in Client.secret_environment_names(settings)
request = fn ->
  Client.request("GET", "/repos/smoke/fixture", %{}, nil,
    tracker_settings: settings,
    request_fun: fn _, _, _, _, config -> {:ok, %{status: 200, body: config.token}} end
  )
end

try do
  System.delete_env("GITHUB_TOKEN_FILE")
  System.put_env("GITHUB_TOKEN", "fixture-legacy")
  {:ok, %{body: "fixture-legacy"}} = request.()
  System.put_env("GITHUB_TOKEN_FILE", token_file)
  {:error, :missing_github_token} = request.()
  {"x-access-token\n", 0} = System.cmd("/opt/momoflow/git-askpass.sh", ["Username"])
  expiry = DateTime.utc_now() |> DateTime.add(3600) |> DateTime.to_iso8601()
  File.write!(token_file, Jason.encode!(%{token: "fixture-first", expires_at: expiry}))
  {:ok, %{body: "fixture-first"}} = request.()
  {"fixture-first", 0} = System.cmd("/opt/momoflow/git-askpass.sh", ["Password"])
  File.write!(token_file <> ".new", Jason.encode!(%{token: "fixture-second", expires_at: expiry}))
  File.rename!(token_file <> ".new", token_file)
  {:ok, %{body: "fixture-second"}} = request.()
  {"fixture-second", 0} = System.cmd("/opt/momoflow/git-askpass.sh", ["Password"])
  expired = DateTime.utc_now() |> DateTime.add(-1) |> DateTime.to_iso8601()
  File.write!(token_file, Jason.encode!(%{token: "fixture-expired", expires_at: expired}))
  {:error, :missing_github_token} = request.()
  {"GitHub App authentication unavailable.\n", 1} =
    System.cmd("/opt/momoflow/git-askpass.sh", ["Password"], stderr_to_stdout: true)
  File.write!(token_file, "{")
  {:error, :missing_github_token} = request.()
  File.write!(token_file, Jason.encode!(%{token: 123, expires_at: expiry}))
  {:error, :missing_github_token} = request.()
  IO.puts("PASS: Symphony reads rotated tokens per request, rejects missing/expired/malformed files without legacy fallback.")
after
  File.rm(token_file)
  File.rm(token_file <> ".new")
end
