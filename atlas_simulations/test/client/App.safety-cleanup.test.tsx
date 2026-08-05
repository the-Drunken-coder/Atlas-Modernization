import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App.js";
import { cleanupRun, loadHealth, loadRuns, loadTargets, startRun } from "../../src/client/api.js";
import { jsonNumber } from "../../src/shared/types.js";
import { cloneRun, deferred, deployedTarget, type HealthResponse, localTarget, scenario } from "./App.test-harness.js";

vi.mock("../../src/client/api.js");

describe("App safety and cleanup", () => {
  it("disables API-key entry until a target exists", async () => {
    vi.mocked(loadTargets).mockResolvedValueOnce({ targets: [], defaultTargetId: "" });
    render(<App />);

    expect(await screen.findByLabelText("API key")).toBeDisabled();
  });

  it("requires a fresh acknowledgement before each deployed start", async () => {
    const user = userEvent.setup();
    render(<App />);

    const apiSelect = await screen.findByLabelText("API");
    await user.selectOptions(apiSelect, deployedTarget.id);
    await waitFor(() => expect(vi.mocked(loadHealth)).toHaveBeenCalledWith(deployedTarget.id));
    const warning = await screen.findByRole("alert", { name: "Deployed Core selected" });
    expect(warning).toHaveTextContent(deployedTarget.label);
    expect(warning).toHaveTextContent(deployedTarget.baseUrl);

    let confirmation = screen.getByRole("checkbox", { name: "I understand this start will mutate the deployed Core." });
    let startButton = screen.getByRole("button", { name: "Start on deployed Core" });
    expect(confirmation).not.toBeChecked();
    expect(startButton).toBeDisabled();

    await user.click(confirmation);
    expect(startButton).toBeEnabled();
    await user.selectOptions(apiSelect, localTarget.id);
    expect(screen.queryByRole("alert", { name: "Deployed Core selected" })).not.toBeInTheDocument();
    await user.selectOptions(apiSelect, deployedTarget.id);

    confirmation = await screen.findByRole("checkbox", {
      name: "I understand this start will mutate the deployed Core."
    });
    startButton = screen.getByRole("button", { name: "Start on deployed Core" });
    expect(confirmation).not.toBeChecked();
    expect(startButton).toBeDisabled();
    await user.click(confirmation);
    await user.click(startButton);

    await waitFor(() =>
      expect(vi.mocked(startRun)).toHaveBeenCalledWith({
        scenarioId: scenario.id,
        targetId: deployedTarget.id,
        confirmDeployedMutation: true,
        inputs: { assetCount: 2 }
      })
    );
    await waitFor(() => expect(confirmation).not.toBeChecked());
    expect(startButton).toBeDisabled();
  });

  it("clears stale health while checking a newly selected target", async () => {
    const user = userEvent.setup();
    const deployedHealth = deferred<HealthResponse>();
    vi.mocked(loadHealth).mockImplementation((targetId) =>
      targetId === deployedTarget.id
        ? deployedHealth.promise
        : Promise.resolve({ ok: true, status: jsonNumber(200), message: "local ok", target: localTarget })
    );
    render(<App />);

    expect(await screen.findByText("Core reachable")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("API"), deployedTarget.id);
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(screen.queryByText("Core reachable")).not.toBeInTheDocument();

    await act(async () => {
      deployedHealth.resolve({ ok: true, status: jsonNumber(200), message: "deployed ok", target: deployedTarget });
      await deployedHealth.promise;
    });
    expect(await screen.findByText("Core reachable")).toBeInTheDocument();
  });

  it("ignores stale health responses after target switches", async () => {
    const user = userEvent.setup();
    const localHealth = deferred<HealthResponse>();
    const deployedHealth = deferred<HealthResponse>();
    vi.mocked(loadHealth).mockImplementation((targetId) =>
      targetId === deployedTarget.id ? deployedHealth.promise : localHealth.promise
    );
    render(<App />);

    const apiSelect = await screen.findByLabelText("API");
    await waitFor(() => expect(vi.mocked(loadHealth)).toHaveBeenCalledWith(localTarget.id));
    await user.selectOptions(apiSelect, deployedTarget.id);
    await waitFor(() => expect(vi.mocked(loadHealth)).toHaveBeenCalledWith(deployedTarget.id));

    await act(async () => {
      deployedHealth.resolve({ ok: true, status: jsonNumber(200), message: "deployed ok", target: deployedTarget });
      await deployedHealth.promise;
    });
    expect(await screen.findByText("Core reachable")).toBeInTheDocument();

    await act(async () => {
      localHealth.resolve({ ok: false, status: jsonNumber(503), message: "local down", target: localTarget });
      await localHealth.promise;
    });

    expect(screen.getByText("Core reachable")).toBeInTheDocument();
    expect(screen.queryByText("Core offline")).not.toBeInTheDocument();
  });

  it("uses the pasted API key when refreshing health and starting a run", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText("API key"), "secret-key");
    await user.click(screen.getByRole("button", { name: "Refresh Core status" }));
    await waitFor(() => expect(vi.mocked(loadHealth)).toHaveBeenCalledWith(localTarget.id, "secret-key"));

    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() =>
      expect(vi.mocked(startRun)).toHaveBeenCalledWith(
        {
          scenarioId: scenario.id,
          targetId: localTarget.id,
          inputs: { assetCount: 2 }
        },
        "secret-key"
      )
    );
  });

  it("uses the run target's in-memory API key for cleanup", async () => {
    const user = userEvent.setup();
    const deployedRun = cloneRun({ status: "completed", target: deployedTarget });
    vi.mocked(loadRuns).mockResolvedValue([deployedRun]);
    vi.mocked(cleanupRun).mockResolvedValue({ ...deployedRun, cleaned: true });
    render(<App />);

    const apiSelect = await screen.findByLabelText("API");
    await user.selectOptions(apiSelect, deployedTarget.id);
    await user.type(screen.getByLabelText("API key"), "remote-key");
    await user.selectOptions(apiSelect, localTarget.id);
    await user.click(await screen.findByRole("button", { name: /^Moving assets$/ }));
    await user.click(screen.getByRole("button", { name: /cleanup/i }));

    await waitFor(() => expect(vi.mocked(cleanupRun)).toHaveBeenCalledWith(deployedRun.id, "remote-key"));
  });

  it("shows abandoned runs and their last cleanup error", async () => {
    const user = userEvent.setup();
    const abandonedRun = cloneRun({
      status: "abandoned",
      target: deployedTarget,
      lastError: "The workbench restarted before this run finished"
    });
    vi.mocked(loadTargets).mockResolvedValue({ targets: [localTarget], defaultTargetId: localTarget.id });
    vi.mocked(loadRuns).mockResolvedValue([abandonedRun]);
    vi.mocked(cleanupRun).mockResolvedValue({ ...abandonedRun, cleaned: true });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /^Moving assets$/ }));

    expect(document.querySelector(".status-pill.abandoned")).toHaveTextContent("abandoned");
    expect(screen.getByText("Last error")).toBeInTheDocument();
    expect(screen.getByText("The workbench restarted before this run finished")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Cleanup API key"), "recovery-key");
    await user.click(screen.getByRole("button", { name: /cleanup/i }));
    await waitFor(() => expect(vi.mocked(cleanupRun)).toHaveBeenCalledWith(abandonedRun.id, "recovery-key"));
  });

  it("isolates recovery keys between abandoned runs that share a target ID", async () => {
    const user = userEvent.setup();
    const first = cloneRun({
      id: "sim-recovered-first",
      scenarioName: "Recovered first",
      status: "abandoned",
      target: deployedTarget
    });
    const second = cloneRun({
      id: "sim-recovered-second",
      scenarioName: "Recovered second",
      status: "abandoned",
      target: { ...deployedTarget, baseUrl: "https://different-atlas.example.test" }
    });
    vi.mocked(loadTargets).mockResolvedValue({ targets: [localTarget], defaultTargetId: localTarget.id });
    vi.mocked(loadRuns).mockResolvedValue([first, second]);
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Recovered first" }));
    await user.type(screen.getByLabelText("Cleanup API key"), "first-key");
    await user.click(screen.getByRole("button", { name: "Recovered second" }));

    expect(screen.getByLabelText("Cleanup API key")).toHaveValue("");
  });

  it("blocks invalid JSON input before starting a run", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Asset count")).toHaveValue(2));
    fireEvent.change(await screen.findByLabelText("JSON input"), { target: { value: "{" } });
    await user.click(screen.getByRole("button", { name: /start/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("JSON input must be valid JSON");
    expect(vi.mocked(startRun)).not.toHaveBeenCalled();
  });
});
