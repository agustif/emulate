import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import type { DeviceInstance, DevicePlugin, DeviceStartOptions, Store } from "@emulators/core";
import { encodeFrame, takeFrames, type CastMessage } from "./frame.js";
import { selfSignedCertificate } from "./certificate.js";

const NAMESPACE = {
  connection: "urn:x-cast:com.google.cast.tp.connection",
  heartbeat: "urn:x-cast:com.google.cast.tp.heartbeat",
  receiver: "urn:x-cast:com.google.cast.receiver",
  media: "urn:x-cast:com.google.cast.media",
} as const;

const RECEIVER_ID = "receiver-0";
const DEFAULT_MEDIA_RECEIVER = "CC1AD845";

export interface CastDeviceConfig {
  /** What the device calls itself, as a sender would see it. */
  friendlyName?: string;
  model?: string;
  /**
   * How many HLS segments to pull before settling.
   *
   * A real device keeps a few seconds of buffer ahead of the playhead. Pulling
   * a couple is enough to prove the playlists lead somewhere, and stops a test
   * transcoding an entire film.
   */
  segments?: number;
}

/** What a sender asked this device to play. */
export interface LoadedMedia {
  contentId: string;
  contentType: string;
  currentTime: number;
  hlsSegmentFormat?: string;
  trackContentIds: string[];
}

interface Fetched {
  url: string;
  status: number;
  bytes: number;
}

interface DeviceState {
  launched: boolean;
  playerState: "IDLE" | "PLAYING" | "PAUSED" | "BUFFERING";
  currentTime: number;
  loaded?: LoadedMedia;
  fetched: Fetched[];
}

export interface CastDeviceInstance extends DeviceInstance {
  /** What the sender asked for, once it has. */
  readonly loaded: LoadedMedia | undefined;
  /** Every URL this device pulled, in order. */
  readonly fetched: readonly Fetched[];
  readonly playerState: DeviceState["playerState"];
}

/**
 * Follow a media URL the way a receiver does.
 *
 * For HLS that means master playlist -> a variant -> its first segments. The
 * lowest-bitrate variant is chosen, which is what a real receiver does before it
 * has measured anything and keeps a test from transcoding 1080p to prove a
 * playlist parses.
 */
async function pull(
  url: string,
  contentType: string,
  segments: number,
  record: (fetched: Fetched) => void,
): Promise<void> {
  const get = async (target: string): Promise<string> => {
    const response = await fetch(target);
    const isSegment = target.endsWith(".ts") || target.endsWith(".m4s");
    const body = isSegment ? "" : await response.text();
    const bytes = isSegment ? (await response.arrayBuffer()).byteLength : body.length;
    record({ url: target, status: response.status, bytes });
    return body;
  };

  const body = await get(url);
  if (!contentType.includes("mpegurl")) return;

  const entries = (playlist: string): string[] =>
    playlist
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

  const variant = entries(body)[0];
  if (variant === undefined) return;

  const media = await get(new URL(variant, url).toString());
  for (const segment of entries(media).slice(0, segments)) {
    await get(new URL(segment, url).toString());
  }
}

/**
 * A Google Cast device.
 *
 * It does the two things a real one does, and the second is the one that
 * matters. It **serves** the control channel — length-prefixed protobuf over
 * TLS — answering CONNECT, GET_STATUS, LAUNCH and the media commands. And on
 * LOAD it **pulls** the media over HTTP, because casting is inverted: the device
 * fetches from the sender. A test that only checks what the sender transmitted
 * checks the easy half.
 */
export const castDevice: DevicePlugin<CastDeviceConfig> = {
  name: "cast",
  label: "Google Cast device (TLS control channel, pulls media over HTTP)",

  initConfig: {
    cast: {
      devices: [{ name: "living-room", friendlyName: "Living Room TV", model: "Chromecast" }],
    },
  },

  async start(options: DeviceStartOptions<CastDeviceConfig>): Promise<CastDeviceInstance> {
    const config = options.config ?? {};
    const friendlyName = config.friendlyName ?? options.name;
    const segments = config.segments ?? 2;

    const state: DeviceState = {
      launched: false,
      playerState: "IDLE",
      currentTime: 0,
      fetched: [],
    };

    const certificate = await selfSignedCertificate();
    const server = createTlsServer({ key: certificate.key, cert: certificate.cert });

    server.on("secureConnection", (socket: TLSSocket) => {
      handleSender(socket, state, { friendlyName, model: config.model, segments }, options.store);
    });

    await new Promise<void>((resolve) => server.listen(options.port, resolve));

    const address = server.address();
    const port = address !== null && typeof address === "object" ? address.port : options.port;

    return {
      name: options.name,
      port,
      address: `${friendlyName} (127.0.0.1:${port})`,
      get loaded() {
        return state.loaded;
      },
      get fetched() {
        return state.fetched;
      },
      get playerState() {
        return state.playerState;
      },
      stop: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  },
};

function handleSender(
  socket: TLSSocket,
  state: DeviceState,
  device: { friendlyName: string; model?: string; segments: number },
  store: Store,
): void {
  let pending: Buffer = Buffer.alloc(0);
  const transportId = "emulated-transport-1";

  const send = (sourceId: string, namespace: string, payload: unknown): void => {
    socket.write(
      encodeFrame({
        sourceId,
        destinationId: "sender-0",
        namespace,
        payload: { type: "text", value: JSON.stringify(payload) },
      }),
    );
  };

  const receiverStatus = (requestId: number): void => {
    send(RECEIVER_ID, NAMESPACE.receiver, {
      type: "RECEIVER_STATUS",
      requestId,
      status: {
        applications: state.launched
          ? [
              {
                appId: DEFAULT_MEDIA_RECEIVER,
                displayName: "Default Media Receiver",
                sessionId: "emulated-session-1",
                transportId,
                statusText: "Ready to cast",
              },
            ]
          : [],
        volume: { level: 1, muted: false },
      },
    });
  };

  const mediaStatus = (requestId: number): void => {
    send(transportId, NAMESPACE.media, {
      type: "MEDIA_STATUS",
      requestId,
      status:
        state.playerState === "IDLE"
          ? []
          : [
              {
                mediaSessionId: 1,
                playerState: state.playerState,
                currentTime: state.currentTime,
              },
            ],
    });
  };

  const onMessage = (message: CastMessage): void => {
    if (message.payload.type !== "text" || message.payload.value.length === 0) return;

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(message.payload.value) as Record<string, unknown>;
    } catch {
      return; // a payload this device cannot read is one it would ignore
    }

    const type = typeof body.type === "string" ? body.type : "";
    const requestId = typeof body.requestId === "number" ? body.requestId : 0;

    if (message.namespace === NAMESPACE.heartbeat) {
      send(RECEIVER_ID, NAMESPACE.heartbeat, { type: "PONG" });
      return;
    }

    if (message.namespace === NAMESPACE.receiver) {
      if (type === "LAUNCH") state.launched = true;
      if (type === "LAUNCH" || type === "GET_STATUS") receiverStatus(requestId);
      return;
    }

    if (message.namespace !== NAMESPACE.media) return;

    if (type === "LOAD") {
      const media = body.media as Record<string, unknown> | undefined;
      if (media === undefined) return;

      const tracks = Array.isArray(media.tracks) ? (media.tracks as Record<string, unknown>[]) : [];
      const loaded: LoadedMedia = {
        contentId: String(media.contentId ?? ""),
        contentType: String(media.contentType ?? ""),
        currentTime: typeof body.currentTime === "number" ? body.currentTime : 0,
        hlsSegmentFormat:
          typeof media.hlsSegmentFormat === "string" ? media.hlsSegmentFormat : undefined,
        trackContentIds: tracks
          .map((track) => track.trackContentId)
          .filter((id): id is string => typeof id === "string"),
      };

      state.loaded = loaded;
      state.playerState = "PLAYING";
      state.currentTime = loaded.currentTime;
      store.setData("cast:loaded", loaded);
      mediaStatus(requestId);

      // A real device answers LOAD and then fetches in its own time; holding
      // the control channel open while megabytes transfer would be a lie.
      void pull(loaded.contentId, loaded.contentType, device.segments, (fetched) =>
        state.fetched.push(fetched),
      ).catch(() => undefined);

      for (const track of loaded.trackContentIds) {
        void pull(track, "text/vtt", 0, (fetched) => state.fetched.push(fetched)).catch(
          () => undefined,
        );
      }
      return;
    }

    if (type === "PAUSE") state.playerState = "PAUSED";
    if (type === "PLAY") state.playerState = "PLAYING";
    if (type === "SEEK" && typeof body.currentTime === "number") {
      state.currentTime = body.currentTime;
      state.playerState = "PLAYING";
    }
    if (type === "STOP") {
      state.playerState = "IDLE";
      state.loaded = undefined;
    }
    mediaStatus(requestId);
  };

  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const [messages, rest] = takeFrames(pending);
    pending = rest;
    for (const message of messages) onMessage(message);
  });

  socket.on("error", () => undefined); // a sender that vanishes is not an error
}
