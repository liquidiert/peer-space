/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * One media connection to one peer.
 */
export class MediaConn {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Close the connection.
     */
    close(): void;
    /**
     * Largest datagram the path currently allows, if datagrams are supported at all.
     */
    maxDatagramSize(): number | undefined;
    /**
     * Open an ordered stream for one track. Higher `priority` is sent first when the link
     * is congested. At most `queue` messages wait to be written; beyond that `send` refuses.
     */
    openStream(priority: number, queue: number): Promise<TrackSender>;
    /**
     * The authenticated endpoint id of the other side.
     */
    remoteId(): string;
    /**
     * Smoothed round-trip time in milliseconds over the best path, for diagnostics.
     */
    rttMs(): number | undefined;
    /**
     * Send one unreliable datagram. Returns false when it could not be queued (too large,
     * or the connection is gone); the caller just moves on, as a lost packet would.
     */
    sendDatagram(data: Uint8Array): boolean;
    /**
     * Start delivering incoming traffic. `on_event` receives
     * `{type: "datagram", data}`, `{type: "message", data}` (one framed stream message)
     * and finally `{type: "closed", reason}`. Calling it twice is a no-op.
     */
    start(on_event: Function): void;
}

/**
 * A running iroh endpoint that speaks the media ALPN.
 */
export class MediaNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Wait for the next incoming media connection. Resolves to `undefined` once the
     * endpoint is closed. Failed handshakes are skipped.
     */
    accept(): Promise<MediaConn | undefined>;
    /**
     * Teach the endpoint how to reach a peer via its relay, so dialing does not depend on
     * DNS/pkarr address lookup.
     */
    addPeer(endpoint_id: string, relay_url?: string | null): void;
    /**
     * Shut the endpoint down.
     */
    close(): Promise<void>;
    /**
     * Dial a peer (call `addPeer` first).
     */
    connect(endpoint_id: string): Promise<MediaConn>;
    /**
     * This endpoint's id (public key string).
     */
    endpointId(): string;
    /**
     * Resolves once a home relay is connected. Returns its URL, if any.
     */
    online(): Promise<string | undefined>;
    /**
     * Current home relay URL (may be empty before `online` resolves).
     */
    relayUrl(): string | undefined;
    /**
     * Sign `data` with this endpoint's ed25519 key (64-byte signature).
     */
    sign(data: Uint8Array): Uint8Array;
    /**
     * Bind a new endpoint with a fresh identity. `relays` lists relay URLs to use instead
     * of n0's public ones (pass an empty array for the defaults).
     */
    static spawn(relays: string[]): Promise<MediaNode>;
}

/**
 * Sending half of one ordered track stream.
 */
export class TrackSender {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Finish the stream once the queued messages are written.
     */
    close(): void;
    /**
     * Messages still waiting to be written.
     */
    queued(): number;
    /**
     * Queue one message. Returns false when the queue is full (the link is not keeping up)
     * or the stream is closed; the message is dropped in that case.
     */
    send(data: Uint8Array): boolean;
}

export function start(): void;

/**
 * Verify an ed25519 `signature` over `data` made by `endpoint_id`.
 */
export function verify(endpoint_id: string, data: Uint8Array, signature: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly __wbg_mediaconn_free: (a: number, b: number) => void;
    readonly __wbg_medianode_free: (a: number, b: number) => void;
    readonly __wbg_tracksender_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly mediaconn_close: (a: number) => void;
    readonly mediaconn_maxDatagramSize: (a: number) => number;
    readonly mediaconn_openStream: (a: number, b: number, c: number) => any;
    readonly mediaconn_remoteId: (a: number) => [number, number];
    readonly mediaconn_rttMs: (a: number) => [number, number];
    readonly mediaconn_sendDatagram: (a: number, b: number, c: number) => number;
    readonly mediaconn_start: (a: number, b: any) => void;
    readonly medianode_accept: (a: number) => any;
    readonly medianode_addPeer: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly medianode_close: (a: number) => any;
    readonly medianode_connect: (a: number, b: number, c: number) => any;
    readonly medianode_endpointId: (a: number) => [number, number];
    readonly medianode_online: (a: number) => any;
    readonly medianode_relayUrl: (a: number) => [number, number];
    readonly medianode_sign: (a: number, b: number, c: number) => [number, number];
    readonly medianode_spawn: (a: number, b: number) => any;
    readonly start: () => void;
    readonly tracksender_close: (a: number) => void;
    readonly tracksender_queued: (a: number) => number;
    readonly tracksender_send: (a: number, b: number, c: number) => number;
    readonly verify: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen_412f237d29853ac3___convert__closures_____invoke___js_sys_45554a2cba579f78___Function_fn_wasm_bindgen_412f237d29853ac3___JsValue_____wasm_bindgen_412f237d29853ac3___sys__Undefined___js_sys_45554a2cba579f78___Function_fn_wasm_bindgen_412f237d29853ac3___JsValue_____wasm_bindgen_412f237d29853ac3___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_412f237d29853ac3___convert__closures_____invoke___wasm_bindgen_412f237d29853ac3___JsValue__core_7d5f0a2ba6a62c33___result__Result_____wasm_bindgen_412f237d29853ac3___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_412f237d29853ac3___convert__closures_____invoke___wasm_bindgen_412f237d29853ac3___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_412f237d29853ac3___convert__closures_____invoke___web_sys_ed29546da527cfa4___features__gen_CloseEvent__CloseEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_412f237d29853ac3___convert__closures_____invoke___web_sys_ed29546da527cfa4___features__gen_MessageEvent__MessageEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_412f237d29853ac3___convert__closures_____invoke_______true_: (a: number, b: number) => void;
    readonly wasm_bindgen_412f237d29853ac3___convert__closures_____invoke_______true__1_: (a: number, b: number) => void;
    readonly wasm_bindgen_412f237d29853ac3___convert__closures_____invoke_______true__2_: (a: number, b: number) => void;
    readonly wasm_bindgen_412f237d29853ac3___convert__closures_____invoke_______true__3_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
