import { createServer } from "node:http";
import { connect, type TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "@emulators/core";
import { castDevice, type CastDeviceInstance } from "../device.js";
import { encodeFrame, takeFrames, type CastMessage } from "../frame.js";

const NAMESPACE = {
  connection: "urn:x-cast:com.google.cast.tp.connection",
  receiver: "urn:x-cast:com.google.cast.receiver",
  media: "urn:x-cast:com.google.cast.media",
};

/**
 * A sender, as small as one can be: connect, launch, load. This is what a real
 * Cast client does, so the device is exercised through its actual protocol
 * rather than by calling its internals.
 */
class Sender {
  private socket: TLSSocket;
  private pending: Buffer = Buffer.alloc(0);
  readonly received: CastMessage[] = [];
  private requestId = 1;

  private constructor(socket: TLSSocket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      const [messages, rest] = takeFrames(this.pending);
      this.pending = rest;
      this.received.push(...messages);
    });
  }

  static connect(port: number): Promise<Sender> {
    return new Promise((resolve) => {
      // Cast devices present a self-signed chain; senders are expected not to
      // verify it.
      const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () =>
        resolve(new Sender(socket)),
      );
    });
  }

  send(destinationId: string, namespace: string, payload: Record<string, unknown>): number {
    const id = this.requestId++;
    this.socket.write(
      encodeFrame({
        sourceId: "sender-0",
        destinationId,
        namespace,
        payload: { type: "text", value: JSON.stringify({ ...payload, requestId: id }) },
      }),
    );
    return id;
  }

  payloads(namespace: string): Record<string, unknown>[] {
    return this.received
      .filter((message) => message.namespace === namespace && message.payload.type === "text")
      .map((message) => JSON.parse((message.payload as { value: string }).value));
  }

  close(): void {
    this.socket.destroy();
  }
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

/** A media server, as a sender would run: a master playlist and its segments. */
async function mediaServer(): Promise<{ url: string; requested: string[]; close: () => void }> {
  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(request.url ?? "");
    if (request.url === "/master.m3u8") {
      response.writeHead(200, { "content-type": "application/x-mpegurl" });
      response.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n/v0.m3u8\n");
      return;
    }
    if (request.url === "/v0.m3u8") {
      response.writeHead(200, { "content-type": "application/x-mpegurl" });
      response.end(
        "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:6\n" +
          "#EXTINF:6.000,\n/v0/0.ts\n#EXTINF:6.000,\n/v0/1.ts\n#EXT-X-ENDLIST\n",
      );
      return;
    }
    response.writeHead(200, { "content-type": "video/mp2t" });
    response.end(Buffer.alloc(64));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requested, close: () => server.close() };
}

describe("cast device", () => {
  let device: CastDeviceInstance | undefined;

  afterEach(async () => {
    await device?.stop();
    device = undefined;
  });

  it("listens on a port of its own", async () => {
    device = await castDevice.start({ name: "living-room", port: 0, store: new Store() });

    expect(device.port).toBeGreaterThan(0);
    expect(device.address).toContain("living-room");
  });

  it("runs several at once, which is the point of a device", async () => {
    const first = await castDevice.start({ name: "tv", port: 0, store: new Store() });
    const second = await castDevice.start({ name: "kitchen", port: 0, store: new Store() });

    expect(first.port).not.toBe(second.port);

    await first.stop();
    await second.stop();
  });

  it("reports no running application until one is launched", async () => {
    device = await castDevice.start({ name: "tv", port: 0, store: new Store() });
    const sender = await Sender.connect(device.port);

    sender.send("receiver-0", NAMESPACE.connection, { type: "CONNECT" });
    sender.send("receiver-0", NAMESPACE.receiver, { type: "GET_STATUS" });
    await settle();

    const [status] = sender.payloads(NAMESPACE.receiver);
    expect(status?.type).toBe("RECEIVER_STATUS");
    expect((status?.status as { applications: unknown[] }).applications).toHaveLength(0);

    sender.close();
  });

  it("hands back a transport id once the media receiver is launched", async () => {
    device = await castDevice.start({ name: "tv", port: 0, store: new Store() });
    const sender = await Sender.connect(device.port);

    sender.send("receiver-0", NAMESPACE.connection, { type: "CONNECT" });
    sender.send("receiver-0", NAMESPACE.receiver, { type: "LAUNCH", appId: "CC1AD845" });
    await settle();

    const status = sender.payloads(NAMESPACE.receiver).at(-1);
    const applications = (status?.status as { applications: Array<{ transportId: string }> })
      .applications;
    expect(applications).toHaveLength(1);
    expect(applications[0]?.transportId).toBeTruthy();

    sender.close();
  });

  it("pulls the media it is told to play, which is the half that matters", async () => {
    const media = await mediaServer();
    device = await castDevice.start({ name: "tv", port: 0, store: new Store() });
    const sender = await Sender.connect(device.port);

    sender.send("receiver-0", NAMESPACE.connection, { type: "CONNECT" });
    sender.send("receiver-0", NAMESPACE.receiver, { type: "LAUNCH", appId: "CC1AD845" });
    await settle();

    sender.send("emulated-transport-1", NAMESPACE.media, {
      type: "LOAD",
      currentTime: 0,
      media: {
        contentId: `${media.url}/master.m3u8`,
        contentType: "application/x-mpegurl",
        streamType: "BUFFERED",
        hlsSegmentFormat: "ts_aac",
      },
    });
    await settle(1500);

    // Casting is inverted: the device fetches from the sender. A test that only
    // checked what was transmitted would not notice a playlist leading nowhere.
    expect(media.requested).toContain("/master.m3u8");
    expect(media.requested).toContain("/v0.m3u8");
    expect(media.requested).toContain("/v0/0.ts");
    expect(device.loaded?.hlsSegmentFormat).toBe("ts_aac");
    expect(device.playerState).toBe("PLAYING");

    sender.close();
    media.close();
  });

  it("honours pause, resume and seek", async () => {
    const media = await mediaServer();
    device = await castDevice.start({ name: "tv", port: 0, store: new Store() });
    const sender = await Sender.connect(device.port);

    sender.send("receiver-0", NAMESPACE.receiver, { type: "LAUNCH", appId: "CC1AD845" });
    await settle();
    sender.send("emulated-transport-1", NAMESPACE.media, {
      type: "LOAD",
      media: { contentId: `${media.url}/master.m3u8`, contentType: "application/x-mpegurl" },
    });
    await settle(800);

    sender.send("emulated-transport-1", NAMESPACE.media, { type: "PAUSE" });
    await settle();
    expect(device.playerState).toBe("PAUSED");

    sender.send("emulated-transport-1", NAMESPACE.media, { type: "SEEK", currentTime: 42 });
    await settle();
    expect(device.playerState).toBe("PLAYING");

    const status = sender.payloads(NAMESPACE.media).at(-1);
    expect((status?.status as Array<{ currentTime: number }>)[0]?.currentTime).toBe(42);

    sender.close();
    media.close();
  });
});
