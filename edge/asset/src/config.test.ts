import { describe, expect, it } from "vitest";
import { parseAssetConfig } from "./config.js";

const VALID = `
[core]
url = "http://127.0.0.1:8080"
api_key = "owner-key"

[asset]
id = "quad-01"

[link]
transport = "serial"
port = "/dev/tty.usbserial-0001"
baud = 57600

[vehicle]
system_id = 1
component_id = 1

[execution]
core_loss_grace_seconds = 5
`;

describe("parseAssetConfig", () => {
  it("parses a complete serial configuration", () => {
    const config = parseAssetConfig(VALID);
    expect(config.coreUrl).toBe("http://127.0.0.1:8080");
    expect(config.assetId).toBe("quad-01");
    expect(config.link).toEqual({ transport: "serial", port: "/dev/tty.usbserial-0001", baud: 57600 });
    expect(config.vehicleSystemId).toBe(1);
    expect(config.coreLossGraceSeconds).toBe(5);
    expect(config.arrivalRadiusM).toBe(1.5);
  });

  it("applies defaults when [execution] is absent", () => {
    const config = parseAssetConfig(VALID.replace("[execution]\ncore_loss_grace_seconds = 5\n", ""));
    expect(config.coreLossGraceSeconds).toBe(5);
    expect(config.taskTimeoutSeconds).toBe(300);
    expect(config.minBatteryPercent).toBe(20);
  });

  it("parses a TCP simulation link", () => {
    const config = parseAssetConfig(
      VALID.replace(
        '[link]\ntransport = "serial"\nport = "/dev/tty.usbserial-0001"\nbaud = 57600',
        '[link]\ntransport = "tcp"\nhost = "127.0.0.1"\ntcp_port = 5760'
      )
    );
    expect(config.link).toEqual({ transport: "tcp", host: "127.0.0.1", port: 5760 });
  });

  it("rejects missing sections without changing anything", () => {
    expect(() => parseAssetConfig("")).toThrowError(/\[core\]/);
    expect(() => parseAssetConfig('[core]\nurl = "http://x"\napi_key = "k"\n')).toThrowError(/\[asset\]/);
  });

  it("rejects empty credentials and non-http URLs", () => {
    expect(() => parseAssetConfig(VALID.replace('api_key = "owner-key"', 'api_key = ""'))).toThrowError(/api_key/);
    expect(() => parseAssetConfig(VALID.replace("http://127.0.0.1:8080", "ws://127.0.0.1:8080"))).toThrowError(/url/);
  });

  it("rejects a serial link without a port and an unknown transport", () => {
    expect(() => parseAssetConfig(VALID.replace('port = "/dev/tty.usbserial-0001"\n', ""))).toThrowError(/port/);
    expect(() => parseAssetConfig(VALID.replace('transport = "serial"', 'transport = "zigbee"'))).toThrowError(
      /transport/
    );
  });

  it("rejects out-of-range numeric settings", () => {
    expect(() => parseAssetConfig(VALID.replace("system_id = 1", "system_id = 300"))).toThrowError(/system_id/);
    expect(() =>
      parseAssetConfig(VALID.replace("core_loss_grace_seconds = 5", "core_loss_grace_seconds = 0"))
    ).toThrowError(/core_loss_grace_seconds/);
  });

  it("rejects invalid TOML", () => {
    expect(() => parseAssetConfig("[core\nurl = ")).toThrowError(/TOML/);
  });
});
