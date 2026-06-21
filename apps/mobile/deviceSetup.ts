import * as Device from "expo-device";
import { Paths } from "expo-file-system";
import { decideDeviceSetup, type DeviceFormFactor, type DeviceSetupDecision, type DeviceSetupFacts } from "@mycelium/brain";
import { isTabletLayout } from "./layout";

function deviceFormFactor(width: number, height: number): DeviceFormFactor {
  if (Device.deviceType === Device.DeviceType.TABLET) return "tablet";
  if (Device.deviceType === Device.DeviceType.DESKTOP) return "desktop";
  if (Device.deviceType === Device.DeviceType.PHONE) return "phone";
  return isTabletLayout(width, height) ? "tablet" : "phone";
}

function availableDiskBytes(): number | null {
  try {
    const bytes = Paths.availableDiskSpace;
    return typeof bytes === "number" && Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

export function mobileDeviceLabel(width: number, height: number): string {
  if (deviceFormFactor(width, height) === "tablet") return "this iPad";
  return "this iPhone";
}

export function collectMobileSetupFacts(width: number, height: number): DeviceSetupFacts {
  return {
    surface: "mobile",
    formFactor: deviceFormFactor(width, height),
    totalMemoryBytes: Device.totalMemory,
    availableDiskBytes: availableDiskBytes(),
    deviceYearClass: Device.deviceYearClass,
    supportedCpuArchitectures: Device.supportedCpuArchitectures,
  };
}

export function decideMobileSetup(width: number, height: number): DeviceSetupDecision {
  return decideDeviceSetup(collectMobileSetupFacts(width, height));
}
