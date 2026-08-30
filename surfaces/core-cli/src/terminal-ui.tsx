import { Box, type Key, render, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  cancelPending(): void;
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
  | { kind: "busy"; label: string }
  | { kind: "configure" }
  | { kind: "logs" }
  | { kind: "menu"; snapshot: DeploymentSnapshot }
  | { kind: "password" }
  | { kind: "status"; view: DeploymentDetails | Error }
  | { kind: "update"; info: UpdateInfo }
  | { kind: "update-error"; message: string }
  | { kind: "update-review"; info: UpdateInfo; scope: UpdateScope };

type AppMode = "configure" | "menu" | "update";

type OperationResult = {
  cancelled: boolean;
  failure?: Error;
};

type KeyValue = readonly [string, string];

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
  const terminalLost = useRef(false);
  const [screen, setScreen] = useState<Screen>({
    kind: "busy",
    label: initialLoadingLabel(mode)
  });

  const loadMenu = useCallback(async () => {
    setScreen({ kind: "busy", label: "Checking deployment..." });
    setScreen({ kind: "menu", snapshot: await readSnapshot(operator) });
  }, [operator]);

  const loadStatus = useCallback(async () => {
    setScreen({ kind: "busy", label: "Loading deployment and Docker statistics..." });
    try {
      setScreen({ kind: "status", view: await operator.details() });
    } catch (error) {
      setScreen({ kind: "status", view: new Error(errorMessage(error)) });
    }
  }, [operator]);

  const loadUpdate = useCallback(async () => {
    setScreen({ kind: "busy", label: "Checking npm for the latest release..." });
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
    const onEnd = (): void => {
      terminalLost.current = true;
      operator.cancelPending();
      exit(new Error("Atlas Core lost its terminal input."));
    };
    const onError = (error: Error): void => {
      terminalLost.current = true;
      operator.cancelPending();
      exit(new Error(`Atlas Core lost its terminal input: ${error.message}`));
    };
    input.once("end", onEnd);
    input.once("error", onError);
    return () => {
      input.off("end", onEnd);
      input.off("error", onError);
    };
  }, [exit, input, operator]);

  const runVisibleOperation = useCallback(
    async (label: string, operation: () => Promise<void>): Promise<OperationResult> => {
      setScreen({ kind: "busy", label: `${label}...` });
      await waitUntilRenderFlush();
      let result: OperationResult = { cancelled: false };
      await suspendTerminal(async () => {
        result = await runCancelableOperation(operator, operation);
        if (result.cancelled || terminalLost.current) return;
        if (result.failure) output.write(`\n${result.failure.message}\n`);
        output.write("\nPress Enter to return to Atlas Core.");
        await waitForReturn(input);
      });
      if (result.cancelled) exit();
      return result;
    },
    [exit, input, operator, output, suspendTerminal, waitUntilRenderFlush]
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

      const result = await runVisibleOperation(action.label, async () => {
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
      if (result.cancelled) return;
      await loadMenu();
    },
    [exit, loadMenu, loadStatus, loadUpdate, operator, runVisibleOperation]
  );

  const showLogs = useCallback(
    async (service: "api" | "minio" | "postgres" | "source-gateway" | undefined, returnTo: "menu" | "status") => {
      const result = await runVisibleOperation("Loading logs", async () => {
        await operator.logs(service, false);
      });
      if (result.cancelled) return;
      if (returnTo === "status") await loadStatus();
      else await loadMenu();
    },
    [loadMenu, loadStatus, operator, runVisibleOperation]
  );

  const runStatusDoctor = useCallback(async () => {
    const result = await runVisibleOperation("Running diagnostics", async () => {
      await operator.doctor();
    });
    if (result.cancelled) return;
    await loadStatus();
  }, [loadStatus, operator, runVisibleOperation]);

  const configureAdmin = useCallback(
    async (password: string) => {
      const result = await runVisibleOperation("Changing admin password", async () => {
        await operator.configureAdminPassword(password);
      });
      if (result.cancelled) return;
      if (mode === "configure") {
        if (result.failure) exit(result.failure);
        else exit();
        return;
      }
      await loadMenu();
    },
    [exit, loadMenu, mode, operator, runVisibleOperation]
  );

  const applyUpdate = useCallback(
    async (info: UpdateInfo, scope: UpdateScope) => {
      setScreen({ kind: "busy", label: "Applying reviewed update..." });
      await waitUntilRenderFlush();
      let result: OperationResult = { cancelled: false };
      await suspendTerminal(async () => {
        result = await runCancelableOperation(operator, async () => {
          await operator.update(scope, info.latestVersion, scope === "all");
        });
        if (result.cancelled) return;
        if (result.failure) output.write(`\n${result.failure.message}\n`);
        output.write(
          result.failure
            ? "\nThe update stopped without deleting Atlas Core data. Rerun atlas-core to inspect or retry.\n"
            : "\nUpdate complete. Rerun atlas-core to use the installed CLI.\n"
        );
        output.write("\nPress Enter to exit.");
        await waitForReturn(input);
      });
      if (result.cancelled) exit();
      else if (result.failure) exit(result.failure);
      else exit();
    },
    [exit, input, operator, output, suspendTerminal, waitUntilRenderFlush]
  );

  if (screen.kind === "busy") {
    return <BusyScreen label={screen.label} onCancel={() => operator.cancelPending()} />;
  }
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
  const { columns, rows } = useWindowSize();
  const actions = useMemo(() => menuActions(snapshot), [snapshot]);
  const actionPending = useRef(false);
  const selectedRef = useRef(0);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const filtered = useMemo(() => filteredActions(actions, filter), [actions, filter]);
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
  const width = columns;
  const wide = width >= 72;
  const actionWidth = Math.min(34, Math.max(24, Math.floor(width * 0.42)));
  const action = filtered[index];
  const compactRows = compactMainMenuRows(snapshot, filtered, filter, width);
  const fullRows = fullMainMenuRows(snapshot, filtered, action, filter, width, actionWidth, wide);
  const hasEnoughRows = rows >= compactRows;
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS && hasEnoughRows;
  const compact = rows < fullRows;

  useInput((input, key) => {
    if (actionPending.current) return;
    const modified = hasCommandModifier(key);
    if ((key.ctrl && input === "c") || key.escape || (!modified && input === "q" && filter === "")) {
      exit();
      return;
    }
    if (!canInteract || modified) return;
    if (key.upArrow) {
      const next = filtered.length === 0 ? 0 : (selectedRef.current - 1 + filtered.length) % filtered.length;
      selectedRef.current = next;
      setSelected(next);
      return;
    }
    if (key.downArrow) {
      const next = filtered.length === 0 ? 0 : (selectedRef.current + 1) % filtered.length;
      selectedRef.current = next;
      setSelected(next);
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((value) => Array.from(value).slice(0, -1).join(""));
      selectedRef.current = 0;
      setSelected(0);
      return;
    }
    if (key.return) {
      const action = filtered[Math.min(selectedRef.current, Math.max(0, filtered.length - 1))];
      if (action) {
        actionPending.current = true;
        onSelect(action);
      }
      return;
    }
    if (isPrintableInput(input, key)) {
      setFilter((value) => value + input);
      selectedRef.current = 0;
      setSelected(0);
    }
  });
  usePaste(
    (value) => {
      if (actionPending.current) return;
      const printable = printableText(value);
      if (printable) {
        setFilter((current) => current + printable);
        selectedRef.current = 0;
        setSelected(0);
      }
    },
    { isActive: canInteract }
  );

  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  if (!hasEnoughRows) return <ShortMainMenu requiredRows={compactRows} />;

  return (
    <Box flexDirection="column" width={width}>
      <Header right={`v${PACKAGE_VERSION}  ${stateName(snapshot.status)}`} title="ATLAS CORE" />
      <Text dimColor>Manage one durable deployment</Text>
      <Rule width={width} />
      {compact ? (
        <Box flexDirection="column">
          <Text bold>ACTIONS</Text>
          <ActionRows actions={filtered} selected={index} width={width} />
          <Text>{pad(action?.detail ?? "No actions match the filter.", width)}</Text>
        </Box>
      ) : wide ? (
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
      {compact ? null : <Text>{snapshot.detail}</Text>}
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

function compactMainMenuRows(snapshot: DeploymentSnapshot, actions: Action[], filter: string, width: number): number {
  return (
    mainMenuHeaderRows(snapshot, width) +
    actionRows(actions) +
    1 +
    1 +
    wrappedRows(`${stateName(snapshot.status)} Filter: ${filter || "type to filter"}`, width) +
    wrappedRows("↑/↓ move   Enter select   Backspace edit   Esc or q quit", width)
  );
}

function fullMainMenuRows(
  snapshot: DeploymentSnapshot,
  actions: Action[],
  action: Action | undefined,
  filter: string,
  width: number,
  actionWidth: number,
  wide: boolean
): number {
  const detail = action?.detail ?? "No actions match the filter.";
  const bodyRows = wide
    ? Math.max(
        actionRows(actions),
        1 +
          wrappedRows(action?.label ?? "No actions match the filter.", Math.max(1, width - actionWidth - 2)) +
          1 +
          wrappedRows(detail, Math.max(1, width - actionWidth - 2))
      )
    : actionRows(actions) + 2 + wrappedRows(detail, width);
  return (
    mainMenuHeaderRows(snapshot, width) +
    bodyRows +
    1 +
    wrappedRows(`${stateName(snapshot.status)} Filter: ${filter || "type to filter"}`, width) +
    wrappedRows(snapshot.detail, width) +
    wrappedRows("↑/↓ move   Enter select   Backspace edit   Esc or q quit", width)
  );
}

function mainMenuHeaderRows(snapshot: DeploymentSnapshot, width: number): number {
  return (
    wrappedRows(`ATLAS CORE v${PACKAGE_VERSION} ${stateName(snapshot.status)}`, width) +
    wrappedRows("Manage one durable deployment", width) +
    1
  );
}

function actionRows(actions: Action[]): number {
  return 1 + Math.max(1, actions.length);
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
  const actionPending = useRef(false);
  const [selected, setSelected] = useState(0);
  const services = view instanceof Error ? [] : view.services;
  const index = Math.min(selected, Math.max(0, services.length - 1));
  const hasEnoughColumns = columns >= MINIMUM_TERMINAL_COLUMNS;
  const requiredRows = view instanceof Error ? MINIMUM_STATUS_ROWS : requiredStatusRows(view, columns);
  const hasEnoughRows = view instanceof Error || rows >= requiredRows;
  const canInteract = hasEnoughColumns && hasEnoughRows;

  useInput((input, key) => {
    if (actionPending.current) return;
    const modified = hasCommandModifier(key);
    if (key.escape || key.return || (key.ctrl && input === "c") || (!modified && input === "q")) {
      actionPending.current = true;
      onBack();
    } else if (!canInteract || modified) return;
    else if (input === "r") {
      actionPending.current = true;
      onReload();
    } else if (input === "d") {
      actionPending.current = true;
      onDiagnostics();
    } else if ((key.leftArrow || key.upArrow) && services.length > 0) {
      setSelected((index - 1 + services.length) % services.length);
    } else if ((key.rightArrow || key.downArrow) && services.length > 0) {
      setSelected((index + 1) % services.length);
    } else if (input === "l") {
      const service = services[index];
      if (service) {
        actionPending.current = true;
        onLogs(service.id);
      }
    }
  });

  if (!hasEnoughColumns) return <NarrowTerminal />;
  if (!hasEnoughRows) return <ShortStatusTerminal requiredRows={requiredRows} />;
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
      <KeyValues values={deploymentValues(view)} width={width} />
      {view.performanceError ? (
        <Text color="yellow">Performance statistics unavailable: {view.performanceError}</Text>
      ) : null}
      <Rule width={width} />
      <Text dimColor>{"←/→ service   r refresh   l logs   d diagnostics   Enter or Esc back"}</Text>
    </Box>
  );
}

function ServiceDetails({ service, width }: { service: DeploymentService; width: number }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>{service.label}</Text>
      <KeyValues values={serviceValues(service)} width={width} />
    </Box>
  );
}

function KeyValues({ values, width }: { values: KeyValue[]; width: number }): ReactNode {
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

function serviceValues(service: DeploymentService): KeyValue[] {
  const status = `${service.state || "unknown"}${service.health ? `, ${service.health}` : ""}`;
  return [
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
  ];
}

function deploymentValues(view: DeploymentDetails): KeyValue[] {
  return [
    ["Initialized", view.initializedAt],
    ["Image", view.image ?? "No running Core image"],
    ["Configuration", "Credentials and durable volumes preserved"]
  ];
}

function requiredStatusRows(view: DeploymentDetails, width: number): number {
  const right = `${stateName(view.snapshot.status)}  Core v${view.coreVersion}  CLI v${view.cliVersion}`;
  const serviceRows =
    view.services.length === 0
      ? wrappedRows("No Atlas Core containers are running.", width)
      : Math.max(
          ...view.services.map(
            (service) => wrappedRows(service.label, width) + keyValueRows(serviceValues(service), width)
          )
        );
  const endpointRows =
    width >= 72
      ? wrappedRows(`API ${view.apiEndpoint}   MinIO ${view.minioEndpoint}`, width)
      : wrappedRows(`API ${view.apiEndpoint}`, width) + wrappedRows(`MinIO ${view.minioEndpoint}`, width);
  const serviceChoiceRows = width >= 72 ? (view.services.length > 0 ? 1 : 0) : view.services.length;
  const performanceRows = view.performanceError
    ? wrappedRows(`Performance statistics unavailable: ${view.performanceError}`, width)
    : 0;
  const rows =
    wrappedRows(`ATLAS CORE > STATUS ${right}`, width) +
    wrappedRows(view.snapshot.detail, width) +
    endpointRows +
    1 +
    1 +
    serviceChoiceRows +
    1 +
    serviceRows +
    1 +
    1 +
    keyValueRows(deploymentValues(view), width) +
    performanceRows +
    1 +
    wrappedRows("←/→ service   r refresh   l logs   d diagnostics   Enter or Esc back", width);
  return Math.max(MINIMUM_STATUS_ROWS, rows);
}

function keyValueRows(values: KeyValue[], width: number): number {
  const labelWidth = Math.min(14, Math.max(...values.map(([label]) => label.length)));
  const valueWidth = Math.max(1, width - labelWidth - 2);
  return values.reduce((rows, [, value]) => rows + wrappedRows(value, valueWidth), 0);
}

function wrappedRows(value: string, width: number): number {
  const lineWidth = Math.max(1, width);
  return value
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(Array.from(line).length / lineWidth)), 0);
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
  const actionPending = useRef(false);
  const selectedRef = useRef(0);
  const [selected, setSelected] = useState(0);
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;
  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.escape || (key.ctrl && input === "c")) {
      actionPending.current = true;
      onBack();
    } else if (!canInteract || hasCommandModifier(key)) return;
    else if (key.upArrow) {
      const next = (selectedRef.current - 1 + choices.length) % choices.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.downArrow) {
      const next = (selectedRef.current + 1) % choices.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.return) {
      actionPending.current = true;
      onSelect(selectedRef.current);
    }
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
  const actionPending = useRef(false);
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
    actionPending.current = true;
    onSubmit(password);
  };

  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.escape || (key.ctrl && input === "c")) {
      actionPending.current = true;
      onCancel();
    } else if (!canInteract || hasCommandModifier(key)) return;
    else if (key.return) submit();
    else if (key.backspace || key.delete) setValue((current) => Array.from(current).slice(0, -1).join(""));
    else if (isPrintableInput(input, key)) setValue((current) => current + input);
  });
  usePaste(
    (pasted) => {
      if (!actionPending.current) setValue((current) => current + printableText(pasted));
    },
    { isActive: canInteract }
  );

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
  const actionPending = useRef(false);
  const selectedRef = useRef(0);
  const choices = useMemo(() => updateChoices(info), [info]);
  const [selected, setSelected] = useState(0);
  const selectedIndex = Math.min(selected, Math.max(0, choices.length - 1));
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;
  useInput((input, key) => {
    if (actionPending.current) return;
    const modified = hasCommandModifier(key);
    if (key.escape || (key.ctrl && input === "c") || (!modified && input === "q")) {
      actionPending.current = true;
      onBack();
    } else if (!canInteract || modified) return;
    else if (input === "r") {
      actionPending.current = true;
      onReload();
    } else if (key.upArrow && choices.length > 0) {
      const next = (Math.min(selectedRef.current, choices.length - 1) - 1 + choices.length) % choices.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.downArrow && choices.length > 0) {
      const next = (Math.min(selectedRef.current, choices.length - 1) + 1) % choices.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.return) {
      const choice = choices[Math.min(selectedRef.current, Math.max(0, choices.length - 1))];
      actionPending.current = true;
      if (choice) onReview(choice.scope);
      else onBack();
    }
  });

  if (!canInteract) return <NarrowTerminal />;
  const choice = choices[selectedIndex];
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
            <Text inverse={index === selectedIndex} key={candidate.scope}>
              {pad(`${index === selectedIndex ? ">" : " "} ${candidate.label}`, columns)}
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
  const { columns, rows } = useWindowSize();
  const actionPending = useRef(false);
  const requiredRows = updateReviewRows(info, scope, columns);
  const hasEnoughRows = rows >= requiredRows;
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS && hasEnoughRows;
  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.escape || (key.ctrl && input === "c")) {
      actionPending.current = true;
      onBack();
    } else if (!canInteract || hasCommandModifier(key)) return;
    else if (key.return) {
      actionPending.current = true;
      onApply();
    }
  });
  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  if (!hasEnoughRows) return <ShortUpdateReview requiredRows={requiredRows} />;
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
  const actionPending = useRef(false);
  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.return || key.escape || (key.ctrl && input === "c")) {
      actionPending.current = true;
      onBack();
    }
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

function BusyScreen({ label, onCancel }: { label: string; onCancel(): void }): ReactNode {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      exit();
    }
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

function ShortMainMenu({ requiredRows }: { requiredRows: number }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ATLAS CORE
      </Text>
      <Text>Menu needs at least {requiredRows} rows at this width.</Text>
      <Text dimColor>Resize the terminal or press Esc or q to exit.</Text>
    </Box>
  );
}

function ShortStatusTerminal({ requiredRows }: { requiredRows: number }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ATLAS CORE
      </Text>
      <Text>Status needs at least {requiredRows} rows at this width.</Text>
      <Text dimColor>Resize the terminal or press Enter or Esc to go back.</Text>
    </Box>
  );
}

function ShortUpdateReview({ requiredRows }: { requiredRows: number }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ATLAS CORE
      </Text>
      <Text>Update review needs at least {requiredRows} rows at this width.</Text>
      <Text dimColor>Resize the terminal or press Esc to go back.</Text>
    </Box>
  );
}

function updateReviewRows(info: UpdateInfo, scope: UpdateScope, width: number): number {
  const headerAndFooterRows =
    wrappedRows("REVIEW UPDATE", width) + 1 + 1 + wrappedRows("Enter update   Esc back", width);
  if (scope === "cli") {
    return (
      headerAndFooterRows +
      wrappedRows(`CLI ${info.cliVersion} → ${info.latestVersion}`, width) +
      wrappedRows(`Atlas Core stays at ${info.coreVersion ?? "not initialized"}.`, width) +
      1 +
      wrappedRows("The current process exits after npm installs the CLI.", width)
    );
  }
  return (
    headerAndFooterRows +
    wrappedRows(
      info.cliUpdateAvailable ? `CLI ${info.cliVersion} → ${info.latestVersion}` : `CLI stays at ${info.cliVersion}.`,
      width
    ) +
    wrappedRows(`Atlas Core ${info.coreVersion} → ${info.latestVersion}`, width) +
    1 +
    wrappedRows(
      "PostgreSQL, MinIO, credentials, and configuration are preserved. Atlas Core restarts after the image pull.",
      width
    ) +
    1 +
    wrappedRows("Continuing confirms that a current paired PostgreSQL and MinIO backup exists.", width)
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

async function runCancelableOperation(
  operator: AtlasCoreOperator,
  operation: () => Promise<void>
): Promise<OperationResult> {
  // Ink pauses its input hooks while the terminal is suspended, so Ctrl-C arrives as SIGINT here.
  let cancelled = false;
  const onInterrupt = (): void => {
    cancelled = true;
    operator.cancelPending();
  };
  process.once("SIGINT", onInterrupt);
  try {
    await operation();
    return { cancelled };
  } catch (error) {
    return cancelled ? { cancelled } : { cancelled, failure: new Error(errorMessage(error)) };
  } finally {
    process.off("SIGINT", onInterrupt);
  }
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
