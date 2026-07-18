import type { Symbol as MilsymbolSymbol, SymbolOptions } from "milsymbol";
import type { RenderSymbolOptions, RenderSymbolResult } from "sidc-kit";
import { milsymbolScriptUrl } from "../runtime-asset-urls.js";

type MilsymbolRuntime = {
  Symbol: new (code: string, options?: SymbolOptions) => MilsymbolSymbol;
};

type MilsymbolGlobal = typeof globalThis & { ms?: MilsymbolRuntime };

let runtimePromise: Promise<MilsymbolRuntime> | undefined;

export function getSidcRuntime(): MilsymbolRuntime | undefined {
  return (globalThis as MilsymbolGlobal).ms;
}

export function loadSidcRuntime(): Promise<MilsymbolRuntime> {
  const global = globalThis as MilsymbolGlobal;
  if (global.ms) return Promise.resolve(global.ms);
  if (runtimePromise !== undefined) return runtimePromise;
  runtimePromise = loadRuntime(global).catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

export function renderSymbol(sidc: string, options: RenderSymbolOptions = {}): RenderSymbolResult {
  const global = globalThis as MilsymbolGlobal;
  if (!global.ms) throw new Error("SIDC symbol runtime is not ready");
  const normalizedSidc = sidc.trim();
  if (!/^\d{30}$/.test(normalizedSidc)) throw new Error("SIDC must be exactly 30 digits.");

  const symbol = new global.ms.Symbol(normalizedSidc, options);
  const metadata = symbol.getMetadata();
  if (symbol.isValid() !== true || metadata.dimensionUnknown) {
    throw new Error(`milsymbol does not support SIDC ${normalizedSidc}.`);
  }
  return {
    sidc: normalizedSidc,
    svg: symbol.asSVG(),
    anchor: symbol.getAnchor(),
    size: symbol.getSize()
  };
}

function loadRuntime(global: MilsymbolGlobal): Promise<MilsymbolRuntime> {
  return new Promise<MilsymbolRuntime>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>("script[data-atlas-milsymbol]");
    let script: HTMLScriptElement | undefined;
    const fail = () => {
      (existingScript ?? script)?.remove();
      reject(new Error("SIDC symbol runtime failed to load"));
    };
    const finish = () => {
      if (global.ms) {
        resolve(global.ms);
      } else {
        reject(new Error("SIDC symbol runtime did not initialize"));
      }
    };

    if (existingScript) {
      existingScript.addEventListener("load", finish, { once: true });
      existingScript.addEventListener("error", fail, { once: true });
      return;
    }

    script = document.createElement("script");
    script.src = milsymbolScriptUrl;
    script.dataset.atlasMilsymbol = "true";
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", fail, { once: true });
    document.head.append(script);
  });
}
