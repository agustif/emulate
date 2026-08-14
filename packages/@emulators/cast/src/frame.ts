/**
 * The Cast v2 wire format.
 *
 * Every message is a big-endian uint32 length followed by that many bytes of
 * protobuf. The message is `CastMessage` from Chromium's `cast_channel.proto`:
 *
 *   1 protocol_version (enum, always 0)   2 source_id (string)
 *   3 destination_id  (string)            4 namespace (string)
 *   5 payload_type    (enum)              6 payload_utf8 (string)
 *   7 payload_binary  (bytes)
 *
 * Hand-rolled rather than generated because it is seven fields of one message
 * and pulling in a protobuf toolchain to read them would be the larger cost.
 * The field numbers are the only thing that must not drift, and they are fixed
 * by a published `.proto`.
 */

export interface CastMessage {
  sourceId: string;
  destinationId: string;
  namespace: string;
  /** Text payloads are JSON. Binary ones are used by a few app protocols. */
  payload: { type: "text"; value: string } | { type: "binary"; value: Buffer };
}

const PROTOCOL_VERSION = 0;
const PAYLOAD_TYPE_STRING = 0;
const PAYLOAD_TYPE_BINARY = 1;

/** Base-128 varint: seven bits per byte, high bit set on all but the last. */
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const group = remaining & 0x7f;
    remaining >>>= 7;
    bytes.push(remaining > 0 ? group | 0x80 : group);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function decodeVarint(buffer: Buffer, offset: number): { value: number; length: number } {
  let value = 0;
  let shift = 0;
  let length = 0;
  for (;;) {
    const byte = buffer[offset + length];
    if (byte === undefined) return { value: 0, length: 0 };
    value |= (byte & 0x7f) << shift;
    length += 1;
    if ((byte & 0x80) === 0) return { value, length };
    shift += 7;
  }
}

function tag(field: number, wireType: number): Buffer {
  return encodeVarint((field << 3) | wireType);
}

function lengthDelimited(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), encodeVarint(payload.length), payload]);
}

function varintField(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), encodeVarint(value)]);
}

/** One framed message, ready to write to the socket. */
export function encodeFrame(message: CastMessage): Buffer {
  const body = Buffer.concat([
    varintField(1, PROTOCOL_VERSION),
    lengthDelimited(2, Buffer.from(message.sourceId, "utf8")),
    lengthDelimited(3, Buffer.from(message.destinationId, "utf8")),
    lengthDelimited(4, Buffer.from(message.namespace, "utf8")),
    message.payload.type === "text"
      ? Buffer.concat([
          varintField(5, PAYLOAD_TYPE_STRING),
          lengthDelimited(6, Buffer.from(message.payload.value, "utf8")),
        ])
      : Buffer.concat([
          varintField(5, PAYLOAD_TYPE_BINARY),
          lengthDelimited(7, message.payload.value),
        ]),
  ]);

  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body]);
}

function decodeMessage(body: Buffer): CastMessage {
  const message: CastMessage = {
    sourceId: "",
    destinationId: "",
    namespace: "",
    payload: { type: "text", value: "" },
  };

  let binary: Buffer | undefined;
  let text: string | undefined;
  let offset = 0;

  while (offset < body.length) {
    const header = decodeVarint(body, offset);
    if (header.length === 0) break;
    offset += header.length;

    const field = header.value >>> 3;
    const wireType = header.value & 0x7;

    if (wireType === 0) {
      const value = decodeVarint(body, offset);
      offset += value.length;
      continue;
    }
    if (wireType !== 2) break; // nothing else appears in this message

    const size = decodeVarint(body, offset);
    offset += size.length;
    const value = body.subarray(offset, offset + size.value);
    offset += size.value;

    if (field === 2) message.sourceId = value.toString("utf8");
    else if (field === 3) message.destinationId = value.toString("utf8");
    else if (field === 4) message.namespace = value.toString("utf8");
    else if (field === 6) text = value.toString("utf8");
    else if (field === 7) binary = Buffer.from(value);
  }

  // A binary payload only counts when there is no text one: the payload_type
  // field says which is authoritative, but senders in practice set exactly one.
  message.payload =
    text !== undefined
      ? { type: "text", value: text }
      : binary !== undefined
        ? { type: "binary", value: binary }
        : { type: "text", value: "" };

  return message;
}

/**
 * Take whole frames from a buffer, returning what is left over.
 *
 * Frames do not align with TCP reads, so the tail has to be carried forward
 * until the rest of it arrives.
 */
export function takeFrames(buffer: Buffer): [CastMessage[], Buffer] {
  const messages: CastMessage[] = [];
  let offset = 0;

  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.length - offset - 4 < length) break;
    messages.push(decodeMessage(buffer.subarray(offset + 4, offset + 4 + length)));
    offset += 4 + length;
  }

  return [messages, buffer.subarray(offset)];
}
