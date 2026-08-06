/**
 * Zod schemas for HTTP/2 frame wire-format validation.
 *
 * Frame bytes from the transport are untrusted external data (Rule #12). These
 * schemas validate the 9-byte frame header before the payload is decoded into
 * a typed {@link Frame} object, replacing the unsafe `as Frame` casts in
 * {@link decodeFrame}. Domain types live in `types.ts`; wire schemas here
 * (Rule #20).
 */

import { z } from "zod";
import { FrameType, type FrameTypeValue } from "./types.js";

/** All valid frame type bytes (0x0 – 0x9) per RFC 7540 §11.2. */
const FRAME_TYPE_VALUES: ReadonlySet<FrameTypeValue> = new Set([
    FrameType.DATA,
    FrameType.HEADERS,
    FrameType.PRIORITY,
    FrameType.RST_STREAM,
    FrameType.SETTINGS,
    FrameType.PUSH_PROMISE,
    FrameType.PING,
    FrameType.GOAWAY,
    FrameType.WINDOW_UPDATE,
    FrameType.CONTINUATION,
]);

/**
 * Zod schema for a known frame type byte.
 *
 * Validates the type byte is a recognized HTTP/2 frame type. Unknown types fail
 * validation — the caller handles them per RFC 7540 §4.1 (silently ignore).
 */
export const FrameTypeSchema = z
    .number()
    .int()
    .min(0)
    .max(255)
    .superRefine((val, ctx) => {
        if (!FRAME_TYPE_VALUES.has(val as FrameTypeValue)) {
            ctx.addIssue({
                code: "custom",
                message: `Unknown frame type byte: 0x${val.toString(16).padStart(2, "0")}`,
            });
        }
    });

/**
 * Zod schema for the 9-byte frame header fields (RFC 7540 §4.1).
 *
 * Validates the type byte is a known frame type, flags is a valid byte, streamId
 * is a non-negative 31-bit integer, and length is non-negative.
 */
export const FrameHeaderSchema = z.object({
    type: FrameTypeSchema,
    flags: z.number().int().min(0).max(255),
    streamId: z.number().int().min(0).max(0x7fffffff),
    length: z.number().int().min(0),
});

/** Validated frame header type — type byte is narrowed to {@link FrameTypeValue}. */
export type ValidatedFrameHeader = z.infer<typeof FrameHeaderSchema>;

/**
 * Validate a raw type byte and narrow it to {@link FrameTypeValue}.
 *
 * Returns the narrowed type byte if it is a known HTTP/2 frame type, or
 * `undefined` if it is unknown. Per RFC 7540 §4.1, unknown frame types MUST be
 * ignored by the receiver.
 */
export function validateFrameType(type: number): FrameTypeValue | undefined {
    const result = FrameTypeSchema.safeParse(type);
    return result.success ? (type as FrameTypeValue) : undefined;
}
