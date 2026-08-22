import { isAtlasTransportError } from "../../src/index.js";

declare const error: unknown;

if (isAtlasTransportError(error)) {
  const message: string = error.message;
  const code: "ATLAS_TRANSPORT_ERROR" = error.code;
  void message;
  void code;
}
