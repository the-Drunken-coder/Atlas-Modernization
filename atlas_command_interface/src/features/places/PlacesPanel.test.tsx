import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapTarget } from "../../ui/map/interaction/map-camera.js";
import { PlacesPanel } from "./PlacesPanel.js";
import type { PlaceSearch, PlaceSearchResponse } from "./place-search.js";

const pointTarget = {
  type: "point" as const,
  id: "place:poi.1",
  coordinates: [-71.8063, 42.2746] as [number, number],
  label: "Worcester Polytechnic Institute"
};

const response: PlaceSearchResponse = {
  attribution: "© MapTiler © OpenStreetMap contributors",
  results: [
    {
      id: "poi.1",
      name: "Worcester Polytechnic Institute",
      context: "Worcester, Massachusetts, United States",
      coordinates: [-71.8063, 42.2746],
      target: pointTarget
    }
  ]
};

afterEach(() => {
  vi.useRealTimers();
});

function Harness({
  search,
  unavailableReason,
  onPreview = () => undefined,
  onFocus = () => undefined
}: {
  search?: PlaceSearch;
  unavailableReason?: string;
  onPreview?: (target: MapTarget | null) => void;
  onFocus?: (target: MapTarget) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <PlacesPanel
      query={query}
      search={search}
      unavailableReason={unavailableReason}
      onQueryChange={setQuery}
      onPreview={onPreview}
      onFocus={onFocus}
    />
  );
}

describe("PlacesPanel", () => {
  it("debounces search, renders attribution, previews on hover and focus, and activates on click", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => response);
    const onPreview = vi.fn<(target: MapTarget | null) => void>();
    const onFocus = vi.fn<(target: MapTarget) => void>();
    render(<Harness search={search} onPreview={onPreview} onFocus={onFocus} />);

    const input = screen.getByRole("searchbox", { name: "Search places" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "W" } });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DELAY));
    expect(search).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Worcester" } });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DELAY - 1));
    expect(search).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    const result = screen.getByRole("button", {
      name: "Worcester Polytechnic Institute, Worcester, Massachusetts, United States"
    });
    expect(search).toHaveBeenCalledWith("Worcester", expect.any(AbortSignal));
    expect(screen.getByText("1 place")).toBeInTheDocument();
    expect(screen.getByText("© MapTiler © OpenStreetMap contributors")).toBeInTheDocument();

    onPreview.mockClear();
    fireEvent.mouseEnter(result);
    expect(onPreview).toHaveBeenLastCalledWith(pointTarget);
    fireEvent.focus(result);
    expect(onPreview).toHaveBeenLastCalledWith(pointTarget);
    fireEvent.click(result);
    expect(onFocus).toHaveBeenCalledWith(pointTarget);
    fireEvent.blur(result);
    expect(onPreview).toHaveBeenLastCalledWith(null);
  });

  it("aborts stale searches when the query changes", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const search = vi.fn((_query: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<PlaceSearchResponse>(() => undefined);
    });
    render(<Harness search={search} />);

    const input = screen.getByRole("searchbox", { name: "Search places" });
    fireEvent.change(input, { target: { value: "Worcester" } });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DELAY));
    expect(signals[0]?.aborted).toBe(false);

    fireEvent.change(input, { target: { value: "Boston" } });
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DELAY));
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("shows empty results and recovers from errors", async () => {
    vi.useFakeTimers();
    const search = vi
      .fn<PlaceSearch>()
      .mockRejectedValueOnce(new Error("Place search failed."))
      .mockResolvedValueOnce({ ...response, results: [] });
    render(<Harness search={search} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search places" }), {
      target: { value: "Worcester" }
    });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DELAY));
    expect(screen.getByRole("alert")).toHaveTextContent("Place search failed.");

    fireEvent.click(screen.getByRole("button", { name: "Retry search" }));
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DELAY));
    expect(screen.getByText("No matching places.")).toBeInTheDocument();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("explains the missing-key state without attempting a request", () => {
    render(<Harness unavailableReason="missing key" />);

    expect(screen.getByRole("searchbox", { name: "Search places" })).toBeDisabled();
    expect(screen.getByText("Place search unavailable")).toBeInTheDocument();
    expect(screen.getByText(/VITE_MAPTILER_API_KEY/)).toBeInTheDocument();
  });
});

const SEARCH_DELAY = 250;
