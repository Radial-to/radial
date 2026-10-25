// What app_error may send (errorReport.ts): every value is checked against
// these lists and shapes on its way out, and anything else is replaced (an
// unknown error class by "Error", an unknown code or process by "other", a
// place by "scrubbed"). The usage-data page (radial.to/docs/usage-data) lists
// exactly these; change one, change the other.
import dns from 'dns';
import os from 'os';
import util from 'util';

/** The error classes a report may name: JavaScript's own, DOMException's names, and Node's. Any other (a site's error class, a name built from data) is sent as "Error". */
export const ERROR_NAMES: ReadonlySet<string> = new Set([
  // JavaScript
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError', 'SuppressedError',
  // DOMException (WebIDL)
  'IndexSizeError', 'HierarchyRequestError', 'WrongDocumentError', 'InvalidCharacterError', 'NoModificationAllowedError', 'NotFoundError',
  'NotSupportedError', 'InUseAttributeError', 'InvalidStateError', 'InvalidModificationError', 'NamespaceError', 'InvalidAccessError',
  'TypeMismatchError', 'SecurityError', 'NetworkError', 'AbortError', 'URLMismatchError', 'QuotaExceededError', 'TimeoutError',
  'InvalidNodeTypeError', 'DataCloneError', 'EncodingError', 'NotReadableError', 'UnknownError', 'ConstraintError', 'DataError',
  'TransactionInactiveError', 'ReadOnlyError', 'VersionError', 'OperationError', 'NotAllowedError', 'OptOutError',
  // Node
  'SystemError', 'AssertionError',
]);

/** A window error event with no error object: why (windowErrors.ts). */
export const WINDOW_KINDS: ReadonlySet<string> = new Set(['resize-observer-loop', 'cross-origin-script', 'error-event']);

/** What a thrown or rejected value that isn't an Error may be named as: its type, or one of these classes; any other object is "object". */
export const VALUE_TYPES: ReadonlySet<string> = new Set([
  'string', 'undefined', 'null', 'number', 'boolean', 'bigint', 'symbol', 'function', 'object',
  'Event', 'ErrorEvent', 'CloseEvent', 'MessageEvent', 'ProgressEvent', 'CustomEvent', 'PromiseRejectionEvent',
  'Response', 'Request', 'XMLHttpRequest', 'WebSocket', 'AbortSignal',
  'Array', 'Map', 'Set', 'Date', 'RegExp', 'Promise', 'ArrayBuffer', 'Uint8Array', 'Blob', 'File',
]);

/** Why a process went away, as Electron says it. */
export const GONE_REASONS: ReadonlySet<string> = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']);

/** Electron's process types that can go away (child-process-gone), and the services its utility processes run. */
export const PROCESS_TYPES: ReadonlySet<string> = new Set(['GPU', 'Utility', 'Zygote', 'Sandbox helper', 'Pepper Plugin', 'Pepper Plugin Broker', 'Unknown']);
export const UTILITY_SERVICES: ReadonlySet<string> = new Set([
  'network.mojom.NetworkService', 'storage.mojom.StorageService', 'audio.mojom.AudioService', 'video_capture.mojom.VideoCaptureService',
  'data_decoder.mojom.DataDecoderService', 'tracing.mojom.TracingService', 'node.mojom.NodeService', 'proxy_resolver.mojom.ProxyResolverFactory',
  'shape_detection.mojom.ShapeDetectionService', 'printing.mojom.PrintBackendService', 'on_device_model.mojom.OnDeviceModelService',
  'unzip.mojom.Unzipper', 'patch.mojom.FilePatcher', 'media.mojom.CdmServiceBroker', 'device.mojom.XRDeviceService',
]);

/** Node's own error codes (ERR_…) and undici's (fetch) that its I/O can throw here; a system error's errno name is checked against Node's lists (systemCodes). */
export const NODE_CODES: ReadonlySet<string> = new Set([
  'ABORT_ERR', 'MODULE_NOT_FOUND',
  'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_PUSH_AFTER_EOF', 'ERR_STREAM_ALREADY_FINISHED', 'ERR_STREAM_CANNOT_PIPE',
  'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE', 'ERR_MISSING_ARGS', 'ERR_INVALID_RETURN_VALUE', 'ERR_INVALID_STATE', 'ERR_INVALID_THIS',
  'ERR_INVALID_URL', 'ERR_INVALID_URL_SCHEME', 'ERR_INVALID_FILE_URL_PATH', 'ERR_INVALID_FILE_URL_HOST', 'ERR_UNKNOWN_ENCODING', 'ERR_BUFFER_OUT_OF_BOUNDS',
  'ERR_STRING_TOO_LONG', 'ERR_INVALID_CHAR', 'ERR_INVALID_HTTP_TOKEN', 'ERR_UNESCAPED_CHARACTERS',
  'ERR_HTTP_HEADERS_SENT', 'ERR_HTTP_INVALID_HEADER_VALUE', 'ERR_HTTP_INVALID_STATUS_CODE', 'ERR_HTTP_REQUEST_TIMEOUT', 'ERR_HTTP_SOCKET_ENCODING',
  'ERR_SOCKET_CLOSED', 'ERR_SOCKET_CLOSED_BEFORE_CONNECTION', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'ERR_SOCKET_BAD_PORT', 'ERR_SERVER_ALREADY_LISTEN', 'ERR_SERVER_NOT_RUNNING',
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ERR_CHILD_PROCESS_IPC_REQUIRED', 'ERR_IPC_CHANNEL_CLOSED', 'ERR_IPC_DISCONNECTED',
  'ERR_FS_FILE_TOO_LARGE', 'ERR_FS_EISDIR', 'ERR_FS_CP_EINVAL', 'ERR_FS_CP_DIR_TO_NON_DIR', 'ERR_DIR_CLOSED', 'ERR_INVALID_FD',
  'ERR_MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_UNHANDLED_ERROR', 'ERR_ASSERTION', 'ERR_INTERNAL_ASSERTION', 'ERR_METHOD_NOT_IMPLEMENTED', 'ERR_MULTIPLE_CALLBACK', 'ERR_USE_AFTER_CLOSE', 'ERR_OPERATION_FAILED',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_OSSL_EVP_UNSUPPORTED', 'ERR_WORKER_OUT_OF_MEMORY',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED',
  'UND_ERR_INFO', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_INVALID_ARG', 'UND_ERR_RESPONSE_STATUS_CODE', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
]);

let system: Set<string> | null = null;
/** A system error's errno names as Node knows them: libuv's (util.getSystemErrorMap), the OS's (os.constants.errno), and the DNS resolver's (ENOTFOUND, …). */
export function systemCodes(): ReadonlySet<string> {
  if (!system) {
    system = new Set<string>(Object.keys(os.constants.errno));
    try { for (const [name] of util.getSystemErrorMap().values()) system.add(name); } catch {}
    for (const value of Object.values(dns)) if (typeof value === 'string' && /^E[A-Z]+$/.test(value)) system.add(value);
  }
  return system;
}

// The shapes `where` may take (the usage-data page's list):
const FN = String.raw`( \([A-Za-z_$][\w$]{0,59}\))?`; // one plain identifier from Radial's code
const LIBRARY = String.raw`(node_modules/(@[\w.-]+/)?[\w.-]+|src/renderer/vendor/[\w./-]+:\d+:\d+)`;
const WHERE = new RegExp([
  String.raw`^(src/[\w./-]+\.ts|out/[\w./-]+\.(js|cjs|mjs)):\d+${FN}( via ${LIBRARY})?$`, // Radial's own code, mapped to src/ (or a compiled line where no map ships)
  String.raw`^${LIBRARY}$`, // a library, with none of Radial's code in the stack
  String.raw`^(node|electron):[\w/._-]{1,80}$`, // Node's or Electron's own module
  String.raw`^ipc:[\w:.-]{1,64}$`, // a call from the window to main that failed (one of the preload's channels)
  '^none$', // no stack
].join('|'));

/** error_name: a known error class, a window kind, rejection:/throw: with a known type, or a process that went away with a known reason; else "Error". */
export function safeName(name: unknown): string {
  if (typeof name !== 'string') return 'Error';
  if (ERROR_NAMES.has(name) || WINDOW_KINDS.has(name)) return name;
  const value = /^(rejection|throw):(.*)$/.exec(name);
  if (value) return `${value[1]}:${VALUE_TYPES.has(value[2]) ? value[2] : 'object'}`;
  const gone = /^(render|child)-process-gone\/(.*)$/.exec(name);
  if (gone) return `${gone[1]}-process-gone/${safeReason(gone[2])}`;
  return 'Error';
}
/** where: one of the shapes above, or "scrubbed"; "none" when there's no place. */
export function safeWhere(where: string | null): string {
  if (!where) return 'none';
  return where.length <= 160 && WHERE.test(where) ? where : 'scrubbed';
}
/** error_code: a known system or Node code, else "other"; nothing for a value that isn't a code (a number, say). */
export function safeCode(code: unknown): string | undefined {
  if (typeof code !== 'string' || !code) return undefined;
  return systemCodes().has(code) || NODE_CODES.has(code) ? code : 'other';
}
/** reason: one of Electron's, else "unknown". */
export function safeReason(reason: unknown): string {
  return typeof reason === 'string' && GONE_REASONS.has(reason) ? reason : 'unknown';
}
/** process_type: one of Electron's types, a utility process's known service after it ("Utility:network.mojom.NetworkService"), else "other" ("Utility:other"). Only a utility process names a service. */
export function safeProcessType(type: unknown): string | undefined {
  if (typeof type !== 'string' || !type) return undefined;
  const at = type.indexOf(':');
  const kind = at < 0 ? type : type.slice(0, at);
  if (!PROCESS_TYPES.has(kind)) return 'other';
  if (at < 0 || kind !== 'Utility') return kind;
  return `Utility:${UTILITY_SERVICES.has(type.slice(at + 1)) ? type.slice(at + 1) : 'other'}`;
}
/** A count: a whole number, never negative. */
export function safeCount(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}
