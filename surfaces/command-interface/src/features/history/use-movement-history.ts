import type {
  EntityResource,
  MovementHistoryPage,
  MovementInspection,
  MovementSample,
  MovementTrail
} from "@the-drunken-coder/atlas-sdk";
import { useCallback, useEffect, useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import type { MovementHistoryReader } from "../../atlas/data-source.js";

type Window = { from: string; to: string };
type View = {
  key: string;
  open: boolean;
  duration: number;
  window?: Window;
  pinned?: MovementSample;
  following: boolean;
  cursor?: string;
  cursors: Array<string | undefined>;
  refresh: number;
  dismissed?: boolean;
};
type HistoryData = { key: string; window: Window; page: MovementHistoryPage };
const initial = (key: string): View => ({
  key,
  open: false,
  duration: 3600000,
  following: true,
  cursors: [],
  refresh: 0
});

export function useMovementHistory(entity: EntityResource | undefined, reader: MovementHistoryReader | undefined) {
  const id = entity?.entity_id;
  const created = entity?.metadata.created_at;
  const key = `${id ?? ""}/${created ?? ""}`;
  const [view, setView] = useState(() => initial(key));
  const [data, setData] = useState<HistoryData>();
  const [trailData, setTrailData] = useState<{ key: string; value: MovementTrail }>();
  const [trailError, setTrailError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<MovementSample>();
  const [inspection, setInspection] = useState<{
    key: string;
    at: string;
    sample: MovementSample;
    value: MovementInspection;
  }>();
  const [inspectionError, setInspectionError] = useState<string>();
  if (view.key !== key) {
    setView(initial(key));
    setPreview(undefined);
    setError(undefined);
    setInspectionError(undefined);
    setTrailError(undefined);
  }
  const open = view.key === key && view.open;
  const current = data?.key === key ? data : undefined;

  useEffect(() => {
    if (!open || !id || !created) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError(undefined);
    const read = async () => {
      setLoading(true);
      try {
        if (!reader) throw new Error("Movement history is unavailable");
        const now = Date.now();
        const window = view.window ?? {
          from: new Date(now - view.duration).toISOString(),
          to: new Date(now).toISOString()
        };
        const query = { entityCreatedAt: created, ...window, signal: controller.signal };
        await Promise.all([
          reader
            .history(id, { ...query, cursor: view.cursor, limit: 100 })
            .then((page) => {
              if (controller.signal.aborted) return;
              setData({ key, window, page });
              setError(undefined);
            })
            .catch((cause) => {
              if (!controller.signal.aborted) setError(sanitizeConnectionError(cause));
            }),
          reader
            .trail(id, { ...query, maxPoints: 1000 })
            .then((value) => {
              if (controller.signal.aborted) return;
              setTrailData({ key, value });
              setTrailError(undefined);
            })
            .catch((cause) => {
              if (!controller.signal.aborted) {
                setTrailData(undefined);
                setTrailError(sanitizeConnectionError(cause));
              }
            })
        ]);
      } catch (cause) {
        if (!controller.signal.aborted) setError(sanitizeConnectionError(cause));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (view.following) timer = setTimeout(() => void read(), 5000);
        }
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, id, created, key, reader, view.duration, view.window, view.following, view.cursor, view.refresh]);

  const sample = preview ?? view.pinned ?? (!view.dismissed ? current?.page.samples[0] : undefined);
  const at = sample?.time;
  useEffect(() => {
    if (!open || !id || !created || !at || !sample || !reader) return;
    const controller = new AbortController();
    setInspectionError(undefined);
    const timer = setTimeout(
      () => {
        void reader
          .inspectMovement(id, created, at, controller.signal)
          .then((value) => {
            if (!controller.signal.aborted) {
              setInspection({ key, at, sample, value });
              setInspectionError(undefined);
            }
          })
          .catch((cause) => {
            if (!controller.signal.aborted) setInspectionError(sanitizeConnectionError(cause));
          });
      },
      preview ? 100 : 0
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, id, created, key, at, sample, reader, preview, view.refresh]);

  const pin = useCallback(
    (sample: MovementSample) => {
      setPreview(undefined);
      setView((v) => ({
        ...v,
        following: false,
        dismissed: false,
        pinned: sample,
        window: current?.window ?? v.window
      }));
    },
    [current?.window]
  );
  const dismiss = useCallback(() => {
    if (!view.pinned && !preview) return false;
    setPreview(undefined);
    setView((v) => ({ ...v, pinned: undefined, dismissed: true }));
    return true;
  }, [view.pinned, preview]);
  const changeRange = (duration: number, window?: Window) => {
    const now = Date.now();
    setPreview(undefined);
    setData(undefined);
    setInspection(undefined);
    setTrailData(undefined);
    setTrailError(undefined);
    setView((v) => ({
      ...v,
      duration,
      dismissed: false,
      window:
        window ??
        (duration > 3600000
          ? { from: new Date(now - duration).toISOString(), to: new Date(now).toISOString() }
          : undefined),
      following: window === undefined && duration <= 3600000,
      pinned: undefined,
      cursor: undefined,
      cursors: []
    }));
  };
  const navigatePage = (older: boolean) => {
    if (!current) return;
    const cursor = older ? current.page.next_cursor : view.cursors.at(-1);
    if (older && !cursor) return;
    setPreview(undefined);
    setData(undefined);
    setInspection(undefined);
    setTrailData(undefined);
    setTrailError(undefined);
    setView((v) => ({
      ...v,
      window: current.window,
      dismissed: false,
      following: false,
      pinned: undefined,
      cursor,
      cursors: older ? [...v.cursors, v.cursor] : v.cursors.slice(0, -1)
    }));
  };
  // Keep the last complete live report visible while its successor is inspected.
  // Pinning or previewing an earlier report must never reuse later readings.
  const displayedInspection =
    inspection?.key === key &&
    (inspection.at === at ||
      (view.following && !preview && sample && Date.parse(inspection.at) <= Date.parse(sample.time)))
      ? inspection
      : undefined;
  const displayedSample = displayedInspection && displayedInspection.at !== at ? displayedInspection.sample : sample;
  return {
    open,
    loading,
    error,
    trailError,
    data: current && {
      ...current,
      trail: trailData?.key === key ? trailData.value : undefined
    },
    sample: displayedSample,
    preview: Boolean(preview),
    following: view.following,
    duration: view.duration,
    custom: view.window !== undefined && view.duration === 0,
    inspection: displayedInspection?.value,
    inspectionLoading: Boolean(sample && displayedInspection?.at !== at),
    inspectionError,
    canGoNewer: view.cursors.length > 0,
    toggle: () => {
      setPreview(undefined);
      setView((v) => ({ ...v, open: !v.open }));
    },
    refresh: () => setView((v) => ({ ...v, cursor: undefined, cursors: [], refresh: v.refresh + 1 })),
    recent: () => {
      setPreview(undefined);
      setInspection(undefined);
      setData(undefined);
      setTrailData(undefined);
      setTrailError(undefined);
      setView((v) => ({
        ...v,
        window: undefined,
        dismissed: false,
        following: true,
        pinned: undefined,
        cursor: undefined,
        cursors: [],
        duration: 3600000
      }));
    },
    changeRange,
    navigatePage,
    pin,
    dismiss,
    setPreview
  };
}

export type MovementHistoryState = ReturnType<typeof useMovementHistory>;
