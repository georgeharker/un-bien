/**
 * Received-image preview pipeline.
 *
 * Everything the App↔Pi image path needs once an Android `user_message` with
 * images lands on a PlainPeerChannel: decode + persist the payloads under the
 * private image cache, emit the metadata-only TUI preview custom message
 * (deferred while a turn is active), register the TUI renderer for it, and
 * hand the multimodal content to the agent via sendUserMessage.
 *
 * Seam: index.ts (composition root) owns the mutable module state this
 * pipeline reads (`_pi`, `_myRoomMeta`, the root session record) and the
 * `_wakeAgent` helper; they are threaded through `ImagePipelineDeps`. This
 * module MUST NOT import `../index.js` (circular import). The
 * pending-preview buffer is pipeline-local and lives here in module scope.
 *
 * NOT here: `_isPureDataContextMessage` / `_filterInternalMessagesFromContext`
 * — those are GENERIC context filters (issue #105, pure-data events must not
 * reach the model) used by the extension registration far beyond the image
 * path; they stay in index.ts and call `_isReceivedImageContextMessage` below.
 */
import { join } from "node:path"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Box, Container, Image, Text } from "@earendil-works/pi-tui"
import type { ClientMessage } from "../protocol/types.js"
import type { PlainPeerChannel } from "../transport/peer_channel.js"
import {
  IMAGE_PREVIEW_MIME,
  _imageCacheRootDir,
  _imageExtension,
  _safeFilenameToken,
  _safePreviewPath,
  _renderablePngPathFromImage,
  _decodeImagePayload,
} from "../image_codec.js"

/** Custom-message type for the metadata-only TUI preview (un-bien namespace). */
const UNBIEN_RECEIVED_IMAGE_TYPE = "un-bien:received-image"

export type ReceivedImageDetails = {
  messageId: string
  index: number
  mime: string
  size?: number
  path?: string
  previewPath?: string
  text?: string
  error?: string
  reason?: string
}

export type ReceivedImagePreviewDelivery = "immediate" | "defer"

/**
 * Structural mirror of index.ts's local `ClientUserMessage` (the
 * `user_message` variant of the app protocol). Kept local so this module
 * never imports the composition root.
 */
type ClientUserMessage = Extract<ClientMessage, { type: "user_message" }>

/** Mirror of index.ts's sendUserMessage options (steering behavior verb). */
type SendUserMessageOptions = NonNullable<
  Parameters<ExtensionAPI["sendUserMessage"]>[1]
>

/**
 * The seam between index.ts (composition root) and this pipeline.
 *
 * Same shape as `CommandDeps`: accessor closures / function references only,
 * members added exactly as the moved code requires them.
 */
export interface ImagePipelineDeps {
  /** The ROOT session's ExtensionAPI (previews are TUI-only, best-effort). */
  readonly pi: ExtensionAPI | null
  /** The ROOT session's state record (turnId drives preview deferral + seeding). */
  rootState(): { turnId: string | null }
  /** Room meta projection — `working` drives preview deferral. */
  readonly myRoomMeta: { working?: boolean } | null
  /** SDK handoff primitive from index.ts (content blocks + steering verb). */
  wakeAgent(
    content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
    label: string,
    steeringBehavior?: SendUserMessageOptions["deliverAs"],
  ): { ok: true } | { ok: false; detail: string }
}

/** Previews parked while a turn is active; flushed on agent_end / stop. */
const _pendingReceivedImagePreviews: ReceivedImageDetails[] = []

export function _sendReceivedImagePreviewNow(
  deps: ImagePipelineDeps,
  details: ReceivedImageDetails,
): void {
  if (!deps.pi) return
  try {
    deps.pi.sendMessage<ReceivedImageDetails>({
      customType: UNBIEN_RECEIVED_IMAGE_TYPE,
      content: "",
      display: true,
      details,
    })
  } catch {
    // TUI preview is best-effort; skip on failure.
  }
}

export function _shouldDeferReceivedImagePreview(
  deps: ImagePipelineDeps,
): boolean {
  return deps.rootState().turnId !== null || deps.myRoomMeta?.working === true
}

export function _sendReceivedImagePreview(
  deps: ImagePipelineDeps,
  details: ReceivedImageDetails,
  delivery: ReceivedImagePreviewDelivery = "immediate",
): void {
  if (delivery === "defer" || _shouldDeferReceivedImagePreview(deps)) {
    _pendingReceivedImagePreviews.push(details)
    return
  }
  _sendReceivedImagePreviewNow(deps, details)
}

export function _flushPendingReceivedImagePreviews(
  deps: ImagePipelineDeps,
): void {
  if (_pendingReceivedImagePreviews.length === 0) return
  const pending = _pendingReceivedImagePreviews.splice(0)
  for (const details of pending) _sendReceivedImagePreviewNow(deps, details)
}

/** Drop parked previews without rendering (teardown path — mirrors `_goIdle`). */
export function clearPendingReceivedImagePreviews(): void {
  _pendingReceivedImagePreviews.length = 0
}

export async function _collectReceivedImagePreviews(
  msg: ClientUserMessage,
): Promise<ReceivedImageDetails[]> {
  if (!msg.images || msg.images.length === 0) return []

  const previews: ReceivedImageDetails[] = []
  const text = typeof msg.text === "string" ? msg.text : ""
  const dir = _imageCacheRootDir()

  for (let i = 0; i < msg.images.length; i += 1) {
    const image = msg.images[i]
    const mime = typeof image?.mime === "string" ? image.mime : "unknown"

    if (!image || typeof image.data !== "string") {
      console.error(`[un-bien] malformed image in message ${msg.id} index=${i}`)
      previews.push({
        messageId: msg.id,
        index: i,
        mime,
        ...(text ? { text } : {}),
        error: "malformed image payload",
        reason: "missing mime/data payload fields",
      })
      continue
    }

    const decoded = _decodeImagePayload(image.data, image.mime)
    if (!decoded.ok) {
      console.error(
        `[un-bien] skipped image id=${msg.id} index=${i}: ${decoded.reason}`,
      )
      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        ...(text ? { text } : {}),
        error: "invalid image payload",
        reason: decoded.reason,
      })
      continue
    }

    const ext = _imageExtension(image.mime)
    if (!ext) {
      console.error(
        `[un-bien] unsupported image mime in message ${msg.id} index=${i}: ${image.mime}`,
      )
      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        ...(text ? { text } : {}),
        error: "invalid image payload",
        reason: `unsupported mime: ${image.mime}`,
      })
      continue
    }

    const filename = `${_safeFilenameToken(msg.id)}-${i}.${ext}`
    const path = join(dir, filename)

    try {
      writeFileSync(path, decoded.decoded, { mode: 0o600 })
      try {
        chmodSync(path, 0o600)
      } catch {
        /* best-effort permission hardening */
      }

      const previewPath =
        image.mime === IMAGE_PREVIEW_MIME
          ? undefined
          : await _renderablePngPathFromImage(
              image.data,
              image.mime,
              _safePreviewPath(dir, msg.id, i),
            )

      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        size: decoded.size,
        path,
        ...(previewPath ? { previewPath } : {}),
        ...(text ? { text } : {}),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(
        `[un-bien] failed saving image id=${msg.id} index=${i}: ${detail}`,
      )
      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        ...(text ? { text } : {}),
        path,
        error: "failed to save image",
        reason: detail,
      })
    }
  }

  return previews
}

export async function _emitReceivedImagePreviews(
  deps: ImagePipelineDeps,
  msg: ClientUserMessage,
  delivery: ReceivedImagePreviewDelivery = "immediate",
): Promise<void> {
  const previews = await _collectReceivedImagePreviews(msg)
  for (const preview of previews)
    _sendReceivedImagePreview(deps, preview, delivery)
}

export function _registerReceivedImageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<ReceivedImageDetails>(
    UNBIEN_RECEIVED_IMAGE_TYPE,
    (message, _options, theme) => {
      const details = (message.details ?? {}) as Partial<ReceivedImageDetails>
      const path = typeof details.path === "string" ? details.path : ""
      const previewPath =
        typeof details.previewPath === "string" ? details.previewPath : ""
      const mime =
        typeof details.mime === "string"
          ? details.mime
          : "application/octet-stream"
      const inlineImagePath =
        previewPath.length > 0
          ? previewPath
          : mime === IMAGE_PREVIEW_MIME
            ? path
            : ""
      const size = typeof details.size === "number" ? details.size : undefined
      const index =
        typeof details.index === "number" ? details.index : undefined
      const text = typeof details.text === "string" ? details.text.trim() : ""
      const messageId =
        typeof details.messageId === "string" ? details.messageId : "unknown"
      const error =
        typeof details.error === "string" ? details.error : undefined
      const reason =
        typeof details.reason === "string" ? details.reason : undefined

      const label = `📷 Photo from Android (${messageId}${index === undefined ? "" : ` #${index}`})`
      const lines = [
        theme.fg("customMessageLabel", label),
        theme.fg("customMessageText", `Saved: ${path || "(not saved)"}`),
      ]
      if (size !== undefined)
        lines.push(theme.fg("customMessageText", `Size: ${size} bytes`))
      if (mime) lines.push(theme.fg("customMessageText", `MIME: ${mime}`))
      if (error) lines.push(theme.fg("customMessageText", `Error: ${error}`))
      if (reason) lines.push(theme.fg("customMessageText", `Reason: ${reason}`))
      if (text) lines.push(theme.fg("customMessageText", `Text: ${text}`))

      const container = new Container()
      const metadata = new Box(1, 1, (line) =>
        theme.bg("customMessageBg", line),
      )
      metadata.addChild(new Text(lines.join("\n")))
      container.addChild(metadata)

      if (inlineImagePath && !error) {
        try {
          const imageData = readFileSync(inlineImagePath).toString("base64")
          if (imageData.length > 0) {
            const image = new Image(imageData, IMAGE_PREVIEW_MIME, {
              fallbackColor: (str) => theme.fg("customMessageText", str),
            })
            // Keep Kitty image rows out of Box padding/background so pi-tui can
            // preserve the empty reserved rows that make inline images visible.
            container.addChild(image)
          }
        } catch {
          // Keep the metadata-only fallback on any IO/terminal issue.
        }
      }

      return container
    },
  )
}

export function _isReceivedImageContextMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { role?: unknown }).role === "custom" &&
    (message as { customType?: unknown }).customType ===
      UNBIEN_RECEIVED_IMAGE_TYPE
  )
}

export function _contentFromUserMessage(
  msg: ClientUserMessage,
): Parameters<ExtensionAPI["sendUserMessage"]>[0] {
  return msg.images && msg.images.length > 0
    ? [
        ...msg.images.map((img) => ({
          type: "image" as const,
          data: img.data,
          mimeType: img.mime,
        })),
        { type: "text" as const, text: msg.text },
      ]
    : msg.text
}

export async function _deliverImageUserMessage(
  deps: ImagePipelineDeps,
  sender: PlainPeerChannel,
  msg: ClientUserMessage,
  shouldSteer: boolean,
): Promise<void> {
  const previewDelivery: ReceivedImagePreviewDelivery =
    shouldSteer ||
    deps.rootState().turnId !== null ||
    deps.myRoomMeta?.working === true
      ? "defer"
      : "immediate"
  const emitPreview = async () => {
    try {
      await _emitReceivedImagePreviews(deps, msg, previewDelivery)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(
        `[un-bien] failed emitting image preview id=${msg.id}: ${detail}`,
      )
    }
  }
  if (previewDelivery === "immediate") {
    await emitPreview()
  } else {
    void emitPreview().finally(() => {
      if (!_shouldDeferReceivedImagePreview(deps))
        _flushPendingReceivedImagePreviews(deps)
    })
  }

  const previousTurnId = deps.rootState().turnId
  const seededTurnId = !shouldSteer || deps.rootState().turnId === null
  if (seededTurnId) deps.rootState().turnId = msg.id

  const wake = deps.wakeAgent(
    _contentFromUserMessage(msg),
    `app user_message id=${msg.id} (+${msg.images?.length ?? 0} image)`,
    "steer",
  )
  if (!wake.ok) {
    if (seededTurnId) deps.rootState().turnId = previousTurnId
    sender.send({
      type: "error",
      code: "internal_error",
      in_reply_to: msg.id,
      message: `Agent rejected incoming message: ${wake.detail}`,
    })
    return
  }
}
