import type { Store } from "./store.js";

/**
 * A device emulator.
 *
 * Services and devices are different things, and the difference is not
 * cosmetic:
 *
 * - a **service** is a remote API your code calls. There is one of it, it
 *   speaks HTTP, and every service shares one Hono app — which is why
 *   `ServicePlugin.register` takes that app and adds routes to it.
 * - a **device** is a peer your code talks to over the network. There can be
 *   several at once — a television and two speakers is an ordinary home — each
 *   owning its own listener, and it need not speak HTTP at all. Google Cast, for
 *   instance, is length-prefixed protobuf over TLS, and the device is an HTTP
 *   *client* rather than a server: it fetches the media from you.
 *
 * A device therefore cannot be expressed as a service plugin, hence this.
 */
export interface DevicePlugin<Config = unknown> {
  /** Registry name, e.g. `cast`. */
  name: string;

  /** What one of these is, for `emulate list`. */
  label: string;

  /**
   * Start one device.
   *
   * Called once per configured device, so an implementation must not hold
   * module-level state — two of these run side by side in the same process.
   */
  start(options: DeviceStartOptions<Config>): Promise<DeviceInstance>;

  /** Config for `emulate init`, if the device takes any. */
  initConfig?: Record<string, unknown>;
}

export interface DeviceStartOptions<Config = unknown> {
  /** What this instance is called, so several are distinguishable. */
  name: string;

  /**
   * The port to listen on, or 0 to let the operating system choose.
   *
   * Zero is the useful default for devices: unlike a service, nothing is
   * hard-coded to find them on a particular port — a sender discovers them, or
   * is told where to look — so tests can run several without arranging ports.
   */
  port: number;

  /** Shared with the services, so a device can record what it was asked to do. */
  store: Store;

  /** Whatever the config file said about this device. */
  config?: Config;
}

export interface DeviceInstance {
  readonly name: string;

  /** Where it actually listens, which is only known after starting on port 0. */
  readonly port: number;

  /** How a sender is told to reach it. */
  readonly address: string;

  /** Free the listener. Must be safe to call twice. */
  stop(): Promise<void>;
}
