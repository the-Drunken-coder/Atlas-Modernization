import { Box, type Key, render, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { PACKAGE_VERSION } from "./package-metadata.js";

export type DeploymentSnapshot = {
  status: "degraded" | "not-initialized" | "ready" | "stopped";
  detail: string;
};

export type DeploymentService = {
  id: "api" | "minio" | "postgres" | "source-gateway";
  label: string;
  container: string;
  state: string;
  health: string;
  cpuPercent?: string;
  memoryUsage?: string;
  memoryPercent?: string;
  networkIO?: string;
  blockIO?: string;
  processes?: string;
  uptime?: string;
  restarts?: number;
  image?: string;
};

export type DeploymentDetails = {
  snapshot: DeploymentSnapshot;
  cliVersion: string;
  coreVersion: string;
  initializedAt: string;
  apiEndpoint: string;
  minioEndpoint: string;
  image?: string;
  services: DeploymentService[];
  performanceError?: string;
};

export type UpdateInfo = {
  cliVersion: string;
  coreVersion?: string;
  latestVersion: string;
  cliUpdateAvailable: boolean;
  coreUpdateAvailable: boolean;
};

export type UpdateScope = "all" | "cli";

export type AtlasCoreOperator = {
  checkForUpdates(): Promise<UpdateInfo>;
  configureAdminPassword(password: string): Promise<void>;
  details(): Promise<DeploymentDetails>;
  doctor(): Promise<boolean>;
  init(): Promise<void>;
  logs(service: "api" | "minio" | "postgres" | "source-gateway" | undefined, follow: boolean): Promise<void>;
  reset(): Promise<void>;
  restart(): Promise<void>;
  snapshot(): Promise<DeploymentSnapshot>;
  start(): Promise<void>;
  status(): Promise<boolean>;
  stop(): Promise<void>;
  update(scope: UpdateScope, expectedVersion?: string, coreBackupConfirmed?: boolean): Promise<void>;
};

export type InteractiveCLI = {
  configureAdmin(operator: AtlasCoreOperator): Promise<void>;
  runMenu(operator: AtlasCoreOperator): Promise<void>;
  runUpdate(operator: AtlasCoreOperator): Promise<void>;
};

type Action = {
  id: "configure" | "doctor" | "init" | "logs" | "quit" | "reset" | "restart" | "start" | "status" | "stop" | "update";
  label: string;
  detail: string;
};

type Screen =
  | { captureInput: boolean; kind: "busy"; label: string }
  | { kind: "configure" }
  | { kind: "logs" }
  | { kind: "menu"; snapshot: DeploymentSnapshot }
  | { kind: "password" }
  | { kind: "status"; view: DeploymentDetails | Error }
  | { kind: "update"; info: UpdateInfo }
  | { kind: "update-error"; message: string }
  | { kind: "update-review"; info: UpdateInfo; scope: UpdateScope };

type AppMode = "configure" | "menu" | "update";

type AtlasCoreAppProps = {
  input: NodeJS.ReadStream;
  mode: AppMode;
  operator: AtlasCoreOperator;
  output: NodeJS.WriteStream;
};

const MINIMUM_TERMINAL_COLUMNS = 40;
const MINIMUM_STATUS_ROWS = 30;

export function createInteractiveCLI(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout
): InteractiveCLI {
  return {
    configureAdmin: async (operator) => {
      await runInkApp(operator, "configure", input, output);
    },
    runMenu: async (operator) => {
      await runInkApp(operator, "menu", input, output);
    },
    runUpdate: async (operator) => {
      await runInkApp(operator, "update", input, output);
    }
  };
}

async function runInkApp(
  operator: AtlasCoreOperator,
  mode: AppMode,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream
): Promise<void> {
  assertInteractive(input, output);
  const instance = render(<AtlasCoreApp input={input} mode={mode} operator={operator} output={output} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    incrementalRendering: true,
    interactive: true,
    maxFps: 30,
    patchConsole: false,
    stderr: output,
    stdin: input,
    stdout: output
  });
  try {
    await instance.waitUntilExit();
  } finally {
    instance.cleanup();
  }
}

function AtlasCoreApp({ input, mode, operator, output }: AtlasCoreAppProps): ReactNode {
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp();
  const [screen, setScreen] = useState<Screen>({
    captureInput: false,
    kind: "busy",
    label: initialLoadingLabel(mode)
  });

  const loadMenu = useCallback(async () => {
    setScreen({ captureInput: false, kind: "busy", label: "Checking deployment..." });
    setScreen({ kind: "menu", snapshot: await readSnapshot(operator) });
  }, [operator]);

  const loadStatus = useCallback(async () => {
    setScreen({ captureInput: false, kind: "busy", label: "Loading deployment and Docker statistics..." });
    try {
      setScreen({ kind: "status", view: await operator.details() });
    } catch (error) {
      setScreen({ kind: "status", view: new Error(errorMessage(error)) });
    }
  }, [operator]);

  const loadUpdate = useCallback(async () => {
    setScreen({ captureInput: false, kind: "busy", label: "Checking npm for the latest release..." });
    try {
      setScreen({ kind: "update", info: await operator.checkForUpdates() });
    } catch (error) {
      setScreen({ kind: "update-error", message: errorMessage(error) });
    }
  }, [operator]);

  useEffect(() => {
    if (mode === "configure") setScreen({ kind: "password" });
    else if (mode === "update") void loadUpdate();
    else void loadMenu();
  }, [loadMenu, loadUpdate, mode]);

  useEffect(() => {
    const onEnd = (): void => exit(new Error("Atlas Core lost its terminal input."));
    const onError = (error: Error): void => exit(new Error(`Atlas Core lost its terminal input: ${error.message}`));
    input.once("end", onEnd);
    input.once("error", onError);
    return () => {
      input.off("end", onEnd);
      input.off("error", onError);
    };
  }, [exit, input]);

  const runVisibleOperation = useCallback(
    async (label: string, operation: () => Promise<void>): Promise<Error | undefined> => {
      setScreen({ captureInput: true, kind: "busy", label: `${label}...` });
      await waitUntilRenderFlush();
      let failure: Error | undefined;
      await suspendTerminal(async () => {
        try {
          await operation();
        } catch (error) {
          failure = new Error(errorMessage(error));
          output.write(`\n${failure.message}\n`);
        }
        output.write("\nPress Enter to return to Atlas Core.");
        await waitForReturn(input);
      });
      return failure;
    },
    [input, output, suspendTerminal, waitUntilRenderFlush]
  );

  const runMainAction = useCallback(
    async (action: Action): Promise<void> => {
      if (action.id === "quit") {
        exit();
        return;
      }
      if (action.id === "configure") {
        setScreen({ kind: "configure" });
        return;
      }
      if (action.id === "logs") {
        setScreen({ kind: "logs" });
        return;
      }
      if (action.id === "status") {
        await loadStatus();
        return;
      }
      if (action.id === "update") {
        await loadUpdate();
        return;
      }

      await runVisibleOperation(action.label, async () => {
        switch (action.id) {
          case "doctor":
            await operator.doctor();
            return;
          case "init":
            await operator.init();
            return;
          case "reset":
            await operator.reset();
            return;
          case "restart":
            await operator.restart();
            return;
          case "start":
            await operator.start();
            return;
          case "stop":
            await operator.stop();
            return;
          case "configure":
          case "logs":
          case "quit":
          case "status":
          case "update":
            return;
        }
      });
      await loadMenu();
    },
    [exit, loadMenu, loadStatus, loadUpdate, operator, runVisibleOperation]
  );

  const showLogs = useCallback(
    async (service: "api" | "minio" | "postgres" | "source-gateway" | undefined, returnTo: "menu" | "status") => {
      await runVisibleOperation("Loading logs", async () => {
        await operator.logs(service, false);
      });
      if (returnTo === "status") await loadStatus();
      else await loadMenu();
    },
    [loadMenu, loadStatus, operator, runVisibleOperation]
  );

  const runStatusDoctor = useCallback(async () => {
    await runVisibleOperation("Running diagnostics", async () => {
      await operator.doctor();
    });
    await loadStatus();
  }, [loadStatus, operator, runVisibleOperation]);

  const configureAdmin = useCallback(
    async (password: string) => {
      const failure = await runVisibleOperation("Changing admin password", async () => {
        await operator.configureAdminPassword(password);
      });
      if (mode === "configure") {
        if (failure) exit(failure);
        else exit();
        return;
      }
      await loadMenu();
    },
    [exit, loadMenu, mode, operator, runVisibleOperation]
  );

  const applyUpdate = useCallback(
    async (info: UpdateInfo, scope: UpdateScope) => {
      setScreen({ captureInput: true, kind: "busy", label: "Applying reviewed update..." });
      await waitUntilRenderFlush();
      let failure: Error | undefined;
      await suspendTerminal(async () => {
        try {
          await operator.update(scope, info.latestVersion, scope === "all");
        } catch (error) {
          failure = new Error(errorMessage(error));
          output.write(`\n${failure.message}\n`);
        }
        output.write(
          failure
            ? "\nThe update stopped without deleting Atlas Core data. Rerun atlas-core to inspect or retry.\n"
            : "\nUpdate complete. Rerun atlas-core to use the installed CLI.\n"
        );
        output.write("\nPress Enter to exit.");
        await waitForReturn(input);
      });
      if (failure) exit(failure);
      else exit();
    },
    [exit, input, operator, output, suspendTerminal, waitUntilRenderFlush]
  );

  if (screen.kind === "busy") return <BusyScreen captureInput={screen.captureInput} label={screen.label} />;
  if (screen.kind === "menu") {
    return <MainMenu onSelect={(action) => void runMainAction(action)} snapshot={screen.snapshot} />;
  }
  if (screen.kind === "configure") {
    return <ConfigureMenu onAdmin={() => setScreen({ kind: "password" })} onBack={() => void loadMenu()} />;
  }
  if (screen.kind === "password") {
    return (
      <PasswordScreen
        onCancel={() => {
          if (mode === "configure") exit();
          else setScreen({ kind: "configure" });
        }}
        onSubmit={(password) => void configureAdmin(password)}
      />
    );
  }
  if (screen.kind === "logs") {
    return <LogsMenu onBack={() => void loadMenu()} onSelect={(service) => void showLogs(service, "menu")} />;
  }
  if (screen.kind === "status") {
    return (
      <StatusScreen
        onBack={() => void loadMenu()}
        onDiagnostics={() => void runStatusDoctor()}
        onLogs={(service) => void showLogs(service, "status")}
        onReload={() => void loadStatus()}
        view={screen.view}
      />
    );
  }
  if (screen.kind === "update-error") {
    return (
      <MessageScreen
        message={screen.message}
        onBack={() => {
          if (mode === "update") exit();
          else void loadMenu();
        }}
        title="Update check failed"
      />
    );
  }
  if (screen.kind === "update-review") {
    return (
      <UpdateReview
        info={screen.info}
        onApply={() => void applyUpdate(screen.info, screen.scope)}
        onBack={() => setScreen({ kind: "update", info: screen.info })}
        scope={screen.scope}
      />
    );
  }
  return (
    <UpdateMenu
      info={screen.info}
      onBack={() => {
        if (mode === "update") exit();
        else void loadMenu();
      }}
      onReload={() => void loadUpdate()}
      onReview={(scope) => setScreen({ kind: "update-review", info: screen.info, scope })}
    />
  );
}

function MainMenu({ onSelect, snapshot }: { onSelect(action: Action): void; snapshot: DeploymentSnapshot }): ReactNode {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const actions = useMemo(() => menuActions(snapshot), [snapshot]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const filtered = useMemo(() => filteredActions(actions, filter), [actions, filter]);
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;

  useInput((input, key) => {
    const modified = hasCommandModifier(key);
    if ((key.ctrl && input === "c") || key.escape || (!modified && input === "q" && filter === "")) {
      exit();
      return;
    }
    if (!canInteract || modified) return;
    if (key.upArrow) {
      setSelected(filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length);
      return;
    }
    if (key.downArrow) {
      setSelected(filtered.length === 0 ? 0 : (index + 1) % filtered.length);
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((value) => Array.from(value).slice(0, -1).join(""));
      setSelected(0);
      return;
    }
    if (key.return) {
      const action = filtered[index];
      if (action) onSelect(action);
      return;
    }
    if (isPrintableInput(input, key)) {
      setFilter((value) => value + input);
      setSelected(0);
    }
  });
  usePaste(
    (value) => {
      const printable = printableText(value);
      if (printable) {
        setFilter((current) => current + printable);
        setSelected(0);
      }
    },
    { isActive: canInteract }
  );

  if (!canInteract) return <NarrowTerminal />;
  const width = columns;
  const wide = width >= 72;
  const actionWidth = Math.min(34, Math.max(24, Math.floor(width * 0.42)));
  const action = filtered[index];

  return (
    <Box flexDirection="column" width={width}>
      <Header right={`v${PACKAGE_VERSION}  ${stateName(snapshot.status)}`} title="ATLAS CORE" />
      <Text dimColor>Manage one durable deployment</Text>
      <Rule width={width} />
      {wide ? (
        <Box>
          <Box flexDirection="column" width={actionWidth}>
            <Text bold>ACTIONS</Text>
            <ActionRows actions={filtered} selected={index} width={actionWidth} />
          </Box>
          <Box
            borderBottom={false}
            borderLeft
            borderLeftDimColor
            borderRight={false}
            borderStyle="single"
            borderTop={false}
            flexDirection="column"
            paddingLeft={1}
            width={width - actionWidth}
          >
            <Text bold>DETAILS</Text>
            <Text>{action?.label ?? "No actions match the filter."}</Text>
            <Text> </Text>
            <Text>{action?.detail ?? "Clear the filter to restore the action list."}</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold>ACTIONS</Text>
          <ActionRows actions={filtered} selected={index} width={width} />
          <Text> </Text>
          <Text bold>DETAILS</Text>
          <Text>{action?.detail ?? "No actions match the filter."}</Text>
        </Box>
      )}
      <Rule width={width} />
      <Box justifyContent="space-between">
        <StateText status={snapshot.status} />
        <Text dimColor>Filter: {filter || "type to filter"}</Text>
      </Box>
      <Text>{snapshot.detail}</Text>
      <Text dimColor>{"↑/↓ move   Enter select   Backspace edit   Esc or q quit"}</Text>
    </Box>
  );
}

function ActionRows({ actions, selected, width }: { actions: Action[]; selected: number; width: number }): ReactNode {
  if (actions.length === 0) return <Text dimColor>No matching actions</Text>;
  return actions.map((action, index) => (
    <Text inverse={index === selected} key={action.id}>
      {pad(`${index === selected ? ">" : " "} ${action.label}`, width)}
    </Text>
  ));
}

function StatusScreen({
  onBack,
  onDiagnostics,
  onLogs,
  onReload,
  view
}: {
  onBack(): void;
  onDiagnostics(): void;
  onLogs(service: DeploymentService["id"]): void;
  onReload(): void;
  view: DeploymentDetails | Error;
}): ReactNode {
  const { columns, rows } = useWindowSize();
  const [selected, setSelected] = useState(0);
  const services = view instanceof Error ? [] : view.services;
  const index = Math.min(selected, Math.max(0, services.length - 1));
  const hasEnoughColumns = columns >= MINIMUM_TERMINAL_COLUMNS;
  const hasEnoughRows = view instanceof Error || rows >= MINIMUM_STATUS_ROWS;
  const canInteract = hasEnoughColumns && hasEnoughRows;

  useInput((input, key) => {
    const modified = hasCommandModifier(key);
    if (key.escape || key.return || (key.ctrl && input === "c") || (!modified && input === "q")) onBack();
    else if (!canInteract || modified) return;
    else if (input === "r") onReload();
    else if (input === "d") onDiagnostics();
    else if ((key.leftArrow || key.upArrow) && services.length > 0) {
      setSelected((index - 1 + services.length) % services.length);
    } else if ((key.rightArrow || key.downArrow) && services.length > 0) {
      setSelected((index + 1) % services.length);
    } else if (input === "l") {
      const service = services[index];
      if (service) onLogs(service.id);
    }
  });

  if (!hasEnoughColumns) return <NarrowTerminal />;
  if (!hasEnoughRows) return <ShortStatusTerminal />;
  const width = columns;
  if (view instanceof Error) {
    return (
      <Box flexDirection="column" width={width}>
        <Header title="ATLAS CORE > STATUS" />
        <Text> </Text>
        <Text bold color="red">
          Status unavailable
        </Text>
        <Text>{view.message}</Text>
        <Rule width={width} />
        <Text dimColor>{"r retry   d diagnostics   Enter or Esc back"}</Text>
      </Box>
    );
  }

  const service = services[index];
  return (
    <Box flexDirection="column" width={width}>
      <Header
        right={`${stateName(view.snapshot.status)}  Core v${view.coreVersion}  CLI v${view.cliVersion}`}
        title="ATLAS CORE > STATUS"
      />
      <Text>{view.snapshot.detail}</Text>
      {width >= 72 ? (
        <Text dimColor>{`API ${view.apiEndpoint}   MinIO ${view.minioEndpoint}`}</Text>
      ) : (
        <>
          <Text dimColor>API {view.apiEndpoint}</Text>
          <Text dimColor>MinIO {view.minioEndpoint}</Text>
        </>
      )}
      <Rule width={width} />
      <Text bold>SERVICES</Text>
      {width >= 72 ? (
        <Box>
          {services.map((candidate, candidateIndex) => (
            <Text inverse={candidateIndex === index} key={candidate.id}>
              {` ${candidate.label} `}
            </Text>
          ))}
        </Box>
      ) : (
        services.map((candidate, candidateIndex) => (
          <Text inverse={candidateIndex === index} key={candidate.id}>
            {pad(`${candidateIndex === index ? ">" : " "} ${candidate.label}`, width)}
          </Text>
        ))
      )}
      <Text> </Text>
      {service ? (
        <ServiceDetails service={service} width={width} />
      ) : (
        <Text>No Atlas Core containers are running.</Text>
      )}
      <Text> </Text>
      <Text bold>DEPLOYMENT</Text>
      <KeyValues
        values={[
          ["Initialized", view.initializedAt],
          ["Image", view.image ?? "No running Core image"],
          ["Configuration", "Credentials and durable volumes preserved"]
        ]}
        width={width}
      />
      {view.performanceError ? (
        <Text color="yellow">Performance statistics unavailable: {view.performanceError}</Text>
      ) : null}
      <Rule width={width} />
      <Text dimColor>{"←/→ service   r refresh   l logs   d diagnostics   Enter or Esc back"}</Text>
    </Box>
  );
}

function ServiceDetails({ service, width }: { service: DeploymentService; width: number }): ReactNode {
  const status = `${service.state || "unknown"}${service.health ? `, ${service.health}` : ""}`;
  return (
    <Box flexDirection="column">
      <Text bold>{service.label}</Text>
      <KeyValues
        values={[
          ["Status", status],
          ["Container", service.container],
          ["Uptime", service.uptime ?? "Not running"],
          ["Restarts", service.restarts?.toString() ?? "Not available"],
          ["CPU", service.cpuPercent ?? "Not available"],
          ["Memory", joinMetric(service.memoryUsage, service.memoryPercent)],
          ["Network I/O", service.networkIO ?? "Not available"],
          ["Block I/O", service.blockIO ?? "Not available"],
          ["Processes", service.processes ?? "Not available"],
          ["Image", service.image ?? "Not available"]
        ]}
        width={width}
      />
    </Box>
  );
}

function KeyValues({ values, width }: { values: Array<readonly [string, string]>; width: number }): ReactNode {
  const labelWidth = Math.min(14, Math.max(...values.map(([label]) => label.length)));
  return values.map(([label, value]) => (
    <Box key={label} width={width}>
      <Box width={labelWidth + 2}>
        <Text dimColor>{pad(label, labelWidth)}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap">{value}</Text>
      </Box>
    </Box>
  ));
}

function ConfigureMenu({ onAdmin, onBack }: { onAdmin(): void; onBack(): void }): ReactNode {
  return (
    <SimpleMenu
      choices={["Admin account", "Back"]}
      onBack={onBack}
      onSelect={(index) => (index === 0 ? onAdmin() : onBack())}
      title="Configure"
    />
  );
}

function LogsMenu({
  onBack,
  onSelect
}: {
  onBack(): void;
  onSelect(service: DeploymentService["id"] | undefined): void;
}): ReactNode {
  const choices: Array<{ label: string; service: DeploymentService["id"] | undefined }> = [
    { label: "All services", service: undefined },
    { label: "Core API", service: "api" },
    { label: "Source Gateway", service: "source-gateway" },
    { label: "PostgreSQL", service: "postgres" },
    { label: "MinIO", service: "minio" }
  ];
  return (
    <SimpleMenu
      choices={[...choices.map(({ label }) => label), "Back"]}
      onBack={onBack}
      onSelect={(index) => {
        const choice = choices[index];
        if (choice) onSelect(choice.service);
        else onBack();
      }}
      title="View logs"
    />
  );
}

function SimpleMenu({
  choices,
  onBack,
  onSelect,
  title
}: {
  choices: string[];
  onBack(): void;
  onSelect(index: number): void;
  title: string;
}): ReactNode {
  const { columns } = useWindowSize();
  const [selected, setSelected] = useState(0);
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) onBack();
    else if (!canInteract || hasCommandModifier(key)) return;
    else if (key.upArrow) setSelected((value) => (value - 1 + choices.length) % choices.length);
    else if (key.downArrow) setSelected((value) => (value + 1) % choices.length);
    else if (key.return) onSelect(selected);
  });
  if (!canInteract) return <NarrowTerminal />;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title={title} />
      <Text> </Text>
      {choices.map((choice, index) => (
        <Text inverse={index === selected} key={choice}>
          {pad(`${index === selected ? ">" : " "} ${choice}`, columns)}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>{"↑/↓ move   Enter select   Esc back"}</Text>
    </Box>
  );
}

function PasswordScreen({ onCancel, onSubmit }: { onCancel(): void; onSubmit(password: string): void }): ReactNode {
  const { columns } = useWindowSize();
  const [confirmation, setConfirmation] = useState(false);
  const [error, setError] = useState<string>();
  const [password, setPassword] = useState("");
  const [value, setValue] = useState("");
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;

  const submit = (): void => {
    if (!confirmation) {
      setPassword(value);
      setValue("");
      setConfirmation(true);
      setError(undefined);
      return;
    }
    if (value !== password) {
      setError("Passwords did not match. The admin password was not changed.");
      setPassword("");
      setValue("");
      setConfirmation(false);
      return;
    }
    onSubmit(password);
  };

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) onCancel();
    else if (!canInteract || hasCommandModifier(key)) return;
    else if (key.return) submit();
    else if (key.backspace || key.delete) setValue((current) => Array.from(current).slice(0, -1).join(""));
    else if (isPrintableInput(input, key)) setValue((current) => current + input);
  });
  usePaste((pasted) => setValue((current) => current + printableText(pasted)), { isActive: canInteract });

  if (!canInteract) return <NarrowTerminal />;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title="Configure > Admin account" />
      <Text>Username: admin</Text>
      <Text> </Text>
      {error ? <Text color="red">{error}</Text> : null}
      <Box>
        <Text>{confirmation ? "Confirm password: " : "New password:     "}</Text>
        <Text>{"*".repeat(Array.from(value).length)}</Text>
      </Box>
      <Text> </Text>
      <Text dimColor>{"Enter continue   Esc cancel"}</Text>
    </Box>
  );
}

function UpdateMenu({
  info,
  onBack,
  onReload,
  onReview
}: {
  info: UpdateInfo;
  onBack(): void;
  onReload(): void;
  onReview(scope: UpdateScope): void;
}): ReactNode {
  const { columns } = useWindowSize();
  const choices = useMemo(() => updateChoices(info), [info]);
  const [selected, setSelected] = useState(0);
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;
  useInput((input, key) => {
    const modified = hasCommandModifier(key);
    if (key.escape || (key.ctrl && input === "c") || (!modified && input === "q")) onBack();
    else if (!canInteract || modified) return;
    else if (input === "r") onReload();
    else if (key.upArrow && choices.length > 0) setSelected((value) => (value - 1 + choices.length) % choices.length);
    else if (key.downArrow && choices.length > 0) setSelected((value) => (value + 1) % choices.length);
    else if (key.return) {
      const choice = choices[selected];
      if (choice) onReview(choice.scope);
      else onBack();
    }
  });

  if (!canInteract) return <NarrowTerminal />;
  const choice = choices[selected];
  return (
    <Box flexDirection="column" width={columns}>
      <Header title="ATLAS CORE > UPDATE" />
      <Text> </Text>
      <KeyValues
        values={[
          ["Installed CLI", info.cliVersion],
          ["Running Core", info.coreVersion ?? "Not initialized"],
          ["Latest release", info.latestVersion]
        ]}
        width={columns}
      />
      <Text> </Text>
      {choices.length === 0 ? (
        <Text>The CLI and Atlas Core are current.</Text>
      ) : (
        <>
          <Text bold>CHOOSE UPDATE</Text>
          {choices.map((candidate, index) => (
            <Text inverse={index === selected} key={candidate.scope}>
              {pad(`${index === selected ? ">" : " "} ${candidate.label}`, columns)}
            </Text>
          ))}
          <Text> </Text>
          <Text>
            {choice?.scope === "cli"
              ? "Install the latest CLI and leave the running Atlas Core version unchanged."
              : "Preserve credentials and durable data, install the latest CLI, then restart Atlas Core on its reviewed image."}
          </Text>
        </>
      )}
      <Rule width={columns} />
      <Text dimColor>
        {choices.length === 0
          ? "r check again   Enter or Esc back"
          : "↑/↓ move   Enter review   r check again   Esc back"}
      </Text>
    </Box>
  );
}

function UpdateReview({
  info,
  onApply,
  onBack,
  scope
}: {
  info: UpdateInfo;
  onApply(): void;
  onBack(): void;
  scope: UpdateScope;
}): ReactNode {
  const { columns } = useWindowSize();
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) onBack();
    else if (!canInteract || hasCommandModifier(key)) return;
    else if (key.return) onApply();
  });
  if (!canInteract) return <NarrowTerminal />;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title="REVIEW UPDATE" />
      <Text> </Text>
      {scope === "cli" ? (
        <>
          <Text>
            CLI {info.cliVersion} → {info.latestVersion}
          </Text>
          <Text>Atlas Core stays at {info.coreVersion ?? "not initialized"}.</Text>
          <Text> </Text>
          <Text>The current process exits after npm installs the CLI.</Text>
        </>
      ) : (
        <>
          <Text>
            {info.cliUpdateAvailable
              ? `CLI ${info.cliVersion} → ${info.latestVersion}`
              : `CLI stays at ${info.cliVersion}.`}
          </Text>
          <Text>
            Atlas Core {info.coreVersion} → {info.latestVersion}
          </Text>
          <Text> </Text>
          <Text>
            PostgreSQL, MinIO, credentials, and configuration are preserved. Atlas Core restarts after the image pull.
          </Text>
          <Text> </Text>
          <Text color="yellow">Continuing confirms that a current paired PostgreSQL and MinIO backup exists.</Text>
        </>
      )}
      <Rule width={columns} />
      <Text dimColor>{"Enter update   Esc back"}</Text>
    </Box>
  );
}

function MessageScreen({ message, onBack, title }: { message: string; onBack(): void; title: string }): ReactNode {
  const { columns } = useWindowSize();
  useInput((input, key) => {
    if (key.return || key.escape || (key.ctrl && input === "c")) onBack();
  });
  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title={title} />
      <Text> </Text>
      <Text color="red">{message}</Text>
      <Rule width={columns} />
      <Text dimColor>Enter or Esc back</Text>
    </Box>
  );
}

function BusyScreen({ captureInput, label }: { captureInput: boolean; label: string }): ReactNode {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  useInput((input, key) => {
    if (!captureInput && key.ctrl && input === "c") exit();
  });
  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title="ATLAS CORE" />
      <Text> </Text>
      <Text>{label}</Text>
    </Box>
  );
}

function Header({ right, title }: { right?: string; title: string }): ReactNode {
  return (
    <Box justifyContent="space-between">
      <Text bold color="cyan">
        {title}
      </Text>
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  );
}

function Rule({ width }: { width: number }): ReactNode {
  return <Text dimColor>{"─".repeat(Math.max(1, width))}</Text>;
}

function StateText({ status }: { status: DeploymentSnapshot["status"] }): ReactNode {
  if (status === "ready")
    return (
      <Text bold color="green">
        READY
      </Text>
    );
  if (status === "degraded")
    return (
      <Text bold color="yellow">
        DEGRADED
      </Text>
    );
  if (status === "stopped") return <Text bold>STOPPED</Text>;
  return (
    <Text bold color="yellow">
      NOT INITIALIZED
    </Text>
  );
}

function NarrowTerminal(): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ATLAS CORE
      </Text>
      <Text>Terminal too narrow.</Text>
      <Text dimColor>Resize to at least 40 columns.</Text>
    </Box>
  );
}

function ShortStatusTerminal(): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ATLAS CORE
      </Text>
      <Text>Status needs at least 30 rows.</Text>
      <Text dimColor>Resize the terminal or press Enter or Esc to go back.</Text>
    </Box>
  );
}

function updateChoices(info: UpdateInfo): Array<{ label: string; scope: UpdateScope }> {
  const choices: Array<{ label: string; scope: UpdateScope }> = [];
  if (info.cliUpdateAvailable) choices.push({ label: "Update CLI only", scope: "cli" });
  if (info.coreVersion && (info.cliUpdateAvailable || info.coreUpdateAvailable)) {
    choices.push({
      label: info.cliUpdateAvailable ? "Update CLI + Atlas Core" : "Update Atlas Core",
      scope: "all"
    });
  }
  return choices;
}

function menuActions(snapshot: DeploymentSnapshot): Action[] {
  const actions: Action[] = [];
  if (snapshot.status === "not-initialized") {
    actions.push({
      id: "init",
      label: "Initialize Atlas Core",
      detail: "Create private credentials and provision the new durable MinIO store."
    });
    actions.push({
      id: "update",
      label: "Update",
      detail: "Check npm and update the Atlas Core CLI."
    });
  } else {
    actions.push({ id: "status", label: "View status", detail: snapshot.detail });
    if (snapshot.status === "ready") {
      actions.push({ id: "stop", label: "Stop Atlas Core", detail: "Stop containers and preserve durable storage." });
    } else {
      actions.push({ id: "start", label: "Start Atlas Core", detail: "Start the deployment from its pinned image." });
    }
    actions.push(
      { id: "restart", label: "Restart Atlas Core", detail: "Pull the pinned image, then restart the deployment." },
      {
        id: "update",
        label: "Update",
        detail: "Check npm, then update only the CLI or update the CLI and Atlas Core together."
      },
      {
        id: "configure",
        label: "Configure",
        detail: "Open Atlas Core configuration. Admin account settings are available here."
      },
      { id: "logs", label: "View logs", detail: "Show the latest logs for all services or one service." }
    );
  }
  actions.push(
    { id: "doctor", label: "Run diagnostics", detail: "Check the host, Docker, Compose, and local configuration." },
    {
      id: "reset",
      label: "Reset Atlas Core",
      detail: "Permanently delete Atlas Core data and credentials, then start from scratch. Confirmation is required."
    },
    { id: "quit", label: "Quit", detail: "Exit without changing the deployment." }
  );
  return actions;
}

function filteredActions(actions: Action[], filter: string): Action[] {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) return actions;
  return actions.filter((action) => action.label.toLocaleLowerCase().includes(query));
}

async function readSnapshot(operator: AtlasCoreOperator): Promise<DeploymentSnapshot> {
  try {
    return await operator.snapshot();
  } catch (error) {
    return { status: "degraded", detail: errorMessage(error) };
  }
}

async function waitForReturn(input: NodeJS.ReadStream): Promise<void> {
  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    const onData = (data: string | Buffer): void => {
      if (!/[\r\n]/u.test(data.toString())) return;
      cleanup();
      resolve();
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      resolve();
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
  });
}

function assertInteractive(input: NodeJS.ReadStream, output: NodeJS.WriteStream): void {
  if (input.isTTY !== true || output.isTTY !== true || input.setRawMode === undefined) {
    throw new Error("Atlas Core's menu requires an interactive terminal. Use atlas-core help to list commands.");
  }
}

function initialLoadingLabel(mode: AppMode): string {
  if (mode === "update") return "Checking npm for the latest release...";
  if (mode === "configure") return "Opening admin account configuration...";
  return "Checking deployment...";
}

function stateName(status: DeploymentSnapshot["status"]): string {
  return status.replace("not-initialized", "NOT INITIALIZED").toUpperCase();
}

function joinMetric(value: string | undefined, percentage: string | undefined): string {
  if (!value) return "Not available";
  return percentage ? `${value} (${percentage})` : value;
}

function pad(value: string, width: number): string {
  const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return clipped.padEnd(width);
}

function isPrintableInput(input: string, key: Key): boolean {
  return !hasCommandModifier(key) && /^[^\u0000-\u001f\u007f]+$/u.test(input);
}

function hasCommandModifier(key: Key): boolean {
  return key.ctrl || key.meta || key.super || key.hyper;
}

function printableText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
