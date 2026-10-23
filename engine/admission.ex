defmodule SymphonyElixir.Admission do
  @moduledoc "Optional host-owned admission fence. A configured unreadable gate fails closed."
  def status do
    case System.get_env("MOMOFLOW_ADMISSION_ROOT") do
      nil -> %{contract: 1, configured: false, paused: false, generation: nil}
      root ->
        with true <- Path.type(root) == :absolute,
             {:ok, bytes} <- File.read(Path.join(root, "active.json")),
             true <- byte_size(bytes) < 4096,
             {:ok, %{"v" => 1, "generation" => generation, "paused" => paused} = gate} <- Jason.decode(bytes),
             true <- map_size(gate) == 3 and is_boolean(paused),
             true <- is_binary(generation) and Regex.match?(~r/^[a-f0-9]{64}$/, generation) do
          %{contract: 1, configured: true, paused: paused, generation: generation}
        else
          _ -> %{contract: 1, configured: true, paused: true, generation: nil, error: "invalid_gate"}
        end
    end
  end

  def open?, do: status().paused == false

  # Runs in the orchestrator process: the acknowledgement follows any dispatch already in progress.
  def snapshot(state) do
    Map.merge(status(), %{
      running: Map.keys(state.running),
      retrying: Map.keys(state.retry_attempts),
      claimed: MapSet.to_list(state.claimed),
      blocked: Map.keys(state.blocked),
      pending_dispatch: state.poll_check_in_progress == true
    })
  end
end
